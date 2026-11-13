"""Standard skill discovery and executor integration."""
from __future__ import annotations

import asyncio
from concurrent.futures import Future, ThreadPoolExecutor
from copy import deepcopy
import json
import logging
import os
import sys
import threading
import time

from .local_base import _data_root
from . import skill_policy

log = logging.getLogger("uvicorn.error")

SETTING_KEY = "skills_cfg"          # Settings store allowed skills and additional discovery roots.

# Built-in browser, computer, and office skills provide the product baseline execution capabilities.

# Office output must remain unrestricted; browser and computer capabilities are enabled by default.
# The administrator catalog continues to govern enterprise-created or imported skills.
BASELINE_SKILLS = frozenset({"browser-use", "computer-use", "office"})

# Legacy settings or plugins may still reference officecli or office-cli.
# Normalize those aliases to the active office capability.
_LEGACY_SKILL_ALIASES = {"officecli": "office", "office-cli": "office"}
_MAX_SCAN_DEPTH = 4                 # Bound discovery depth to avoid scanning entire repositories as skill catalogs.
_MAX_SKILLS = 200

_SCAN_CACHE_TTL_SECONDS = 30.0
_SCAN_CACHE_MAX_ITEMS = 128
_SCAN_CACHE: dict[tuple[str, tuple[str, ...], str], tuple[float, list[dict]]] = {}
_SCAN_CACHE_LOCK = threading.Lock()
_SCAN_GENERATION = 0
_SCAN_PENDING: dict[tuple[str, tuple[str, ...], str], Future] = {}
# File I/O never occupies the event loop or every worker of its shared executor.
_SCAN_EXECUTOR = ThreadPoolExecutor(max_workers=4, thread_name_prefix="skill-scan")


def home_root() -> str:
    """Return the user-managed skill root beneath the archive data root, outside working
    repositories.
    """
    return os.path.join(_data_root(), "skills")


def bundled_root() -> str:
    """Return version-controlled skills bundled with SoduWork. Keep user-added skills in home_root
    so upgrades do not overwrite them.
    """
    # PyInstaller one-file Runners extract resources beneath sys._MEIPASS.
    # Do not infer the repository root from the module's parent depth in that environment.
    frozen = getattr(sys, "_MEIPASS", "")
    if frozen:
        return os.path.join(frozen, "skills")
    here = os.path.dirname(os.path.abspath(__file__))          # app/services
    repo = os.path.dirname(os.path.dirname(os.path.dirname(here)))   # Repository root.
    return os.path.join(repo, "skills")


def configured_roots() -> list[str]:
    """Additional local roots supplied by the embedding SoduWork client."""
    raw = str(os.environ.get("SODUWORK_SKILL_ROOTS") or "")
    return [os.path.abspath(os.path.expanduser(part))
            for part in raw.split(os.pathsep) if str(part).strip()]


def default_roots() -> list[str]:
    """Return default skill roots, including compatible harness directories so existing standard
    skills can be reused.
    """
    home = os.path.expanduser("~")
    roots = [bundled_root(), home_root(), *configured_roots(),
             os.path.join(home, ".pi", "agent", "skills"),
             os.path.join(home, ".agents", "skills"),
             os.path.join(os.environ.get("CODEX_HOME") or os.path.join(home, ".codex"), "skills"),
             os.path.join(home, ".claude", "skills")]
    out = []
    seen = set()
    for root in roots:
        key = os.path.normcase(os.path.abspath(os.path.expanduser(root)))
        if key not in seen:
            seen.add(key)
            out.append(root)
    return out


# Skill discovery.
def _parse_front(path: str, fallback_name: str = "") -> dict | None:
    """Only expose metadata that the real Skill loader can interpret."""
    from .skill_frontmatter import parse
    try:
        with open(path, "rb") as stream:
            fields = parse(stream.read(), fallback_name, source=path)
    except (OSError, ValueError) as exc:
        log.warning("Skill 无法加载：%s", exc)
        return None
    return {key: fields[key] for key in ("name", "description", "compatibility")}


def _walk(root: str) -> list[dict]:
    found: list[dict] = []
    if not os.path.isdir(root):
        return found
    base_depth = root.rstrip("\\/").count(os.sep)
    for cur, dirs, files in os.walk(root):
        if cur.count(os.sep) - base_depth >= _MAX_SCAN_DEPTH:
            dirs[:] = []
            continue
        dirs[:] = [d for d in dirs if not d.startswith(".") and d not in ("node_modules", "__pycache__")]
        if "SKILL.md" in files:
            meta = _parse_front(os.path.join(cur, "SKILL.md"), os.path.basename(cur))
            if meta:
                found.append({**meta, "path": cur, "root": root,
                              "dir": os.path.basename(cur)})
            dirs[:] = []                   # Stop descending once a skill directory is found.
    return found


def scan_root(root: str) -> list[dict]:
    """Scan one explicit immutable root without letting global skills shadow it."""
    return sorted(_walk(root), key=lambda x: x["name"])


def scan(extra_roots: list[str] | None = None, owner_client_id: str = "") -> list[dict]:
    """Discover skills, keeping the first occurrence of each name to avoid conflicting definitions.

    """
    seen: dict[str, dict] = {}
    # Imported packages are content-addressed and must win over a stale copy with
    # the same name in a scanned folder. Personal packages are only visible to
    # their owner; company packages are visible to admin and all devices.
    try:
        from . import skill_packages
        for item in skill_packages.active(owner_client_id=owner_client_id):
            seen[item["name"]] = item
    except Exception as exc:  # noqa: BLE001 - one bad index must not break built-ins
        log.warning("导入技能索引读取失败：%s", type(exc).__name__)
    for root in (default_roots() + list(extra_roots or [])):
        for s in _walk(root):
            if s["name"] not in seen:
                seen[s["name"]] = s
            if len(seen) >= _MAX_SKILLS:
                break
    return sorted(seen.values(), key=lambda x: x["name"])


def _scan_cache_key(extra_roots: list[str] | None, owner_client_id: str, revision: str
                    ) -> tuple[str, tuple[str, ...], str]:
    roots = default_roots() + list(extra_roots or [])
    normalized = tuple(os.path.normcase(os.path.abspath(os.path.expanduser(str(root))))
                       for root in roots)
    return str(owner_client_id or ""), normalized, revision


def clear_scan_cache() -> None:
    """Invalidate the short-lived directory cache after skill import or deletion."""
    global _SCAN_GENERATION
    with _SCAN_CACHE_LOCK:
        _SCAN_CACHE.clear()
        # Low-level scan waiters may finish, but authorization must rescan their
        # results. Old completion callbacks cannot refill the new generation.
        _SCAN_PENDING.clear()
        _SCAN_GENERATION += 1


def _package_revision() -> str:
    from . import skill_packages
    try:
        return skill_packages.index_revision()
    except (OSError, ValueError, TypeError) as exc:
        raise PolicyChanged("企业能力包目录暂时不可读取，请稍后重试") from exc


def _scan_future(extra_roots, owner_client_id, revision, force=False) -> Future:
    key = _scan_cache_key(extra_roots, owner_client_id, revision)
    with _SCAN_CACHE_LOCK:
        cached = _SCAN_CACHE.get(key)
        if not force and cached and time.monotonic() - cached[0] < _SCAN_CACHE_TTL_SECONDS:
            ready = Future()
            ready.set_result(cached[1])
            return ready
        if not force and key in _SCAN_PENDING:
            return _SCAN_PENDING[key]
        future = _SCAN_EXECUTOR.submit(scan, list(extra_roots or []), str(owner_client_id or ""))
        _SCAN_PENDING[key] = future

    def completed(done):
        try:
            snapshot = deepcopy(done.result())
        except Exception:  # Callers receive the original error; failed scans are not cached.
            snapshot = None
        with _SCAN_CACHE_LOCK:
            if _SCAN_PENDING.get(key) is not done:
                return
            _SCAN_PENDING.pop(key, None)
            if snapshot is not None:
                _SCAN_CACHE.pop(key, None)
                _SCAN_CACHE[key] = (time.monotonic(), snapshot)
                while len(_SCAN_CACHE) > _SCAN_CACHE_MAX_ITEMS:
                    _SCAN_CACHE.pop(next(iter(_SCAN_CACHE)))

    # Register outside the lock: an already completed Future invokes this inline.
    future.add_done_callback(completed)
    return future


def scan_cached(extra_roots: list[str] | None = None, owner_client_id: str = "",
                *, force: bool = False, _revision: str | None = None) -> list[dict]:
    """Cache skill scans briefly and return copies. Run filesystem discovery outside the event
    loop, sharing work only for the same roots and user rather than blocking unrelated users on
    a global disk lock.
    """
    revision = _package_revision() if _revision is None else _revision
    return deepcopy(_scan_future(extra_roots, owner_client_id, revision, force).result())


async def scan_async(extra_roots: list[str] | None = None, owner_client_id: str = "",
                     *, force: bool = False, _revision: str | None = None) -> list[dict]:
    """Event-loop-safe skill discovery entry point."""
    revision = await asyncio.to_thread(_package_revision) if _revision is None else _revision
    future = _scan_future(extra_roots, owner_client_id, revision, force)
    # A disconnected request must not cancel a scan shared by other clients.
    return deepcopy(await asyncio.shield(asyncio.wrap_future(future)))


def public_view(item: dict, *, enabled: bool = False) -> dict:
    """Return the client-safe, substrate-neutral Skill contract.

    Filesystem paths belong to the Hub process and are never useful to an
    Electron client or a remote Runner. Downloadable means the Hub owns an
    immutable payload that can be materialized on the execution node; it does
    not claim that the payload is already installed there.
    """
    checksum = str(
        item.get("pluginChecksum") or item.get("packageChecksum") or
        item.get("bundleChecksum") or ""
    )
    raw_scope = str(item.get("scope") or "company")
    scope = raw_scope if raw_scope in ("personal", "local") else "company"
    source, source_key = source_info(item)
    return {
        "id": "skill:" + str(item.get("name") or ""),
        "name": str(item.get("name") or "")[:64],
        "description": str(item.get("description") or "")[:1024],
        "compatibility": str(item.get("compatibility") or "")[:500],
        "scope": scope,
        "source": source,
        "sourceKey": source_key,
        "version": (checksum or str(item.get("version") or ""))[:12],
        "checksum": checksum,
        "downloadable": bool(item.get("bundled") and checksum),
        "enabled": bool(enabled),
        "hasScripts": bool(item.get("hasScripts")),
        "resourceKinds": list(item.get("resourceKinds") or [])[:20],
        "localOnly": bool(item.get("runtimeLocal")),
        "runtimeAvailable": bool(item.get("runtimeAvailable") or item.get("runtimeLocal")),
        "runtimeSources": list(item.get("runtimeSources") or [])[:8],
    }


def source_info(item: dict) -> tuple[str, str]:
    """Return stable provenance without exposing a local filesystem path."""
    explicit_key = str(item.get("sourceKey") or "").strip().lower()
    explicit = str(item.get("source") or "").strip()
    if item.get("runtimeLocal") and explicit_key:
        labels = {
            "pi": "Pi", "codex": "Codex", "claude": "Claude Code",
            "agents": "Agent Skills", "soduwork": "SoduWork 本机",
            "builtin": "SoduWork 内置",
        }
        return explicit[:40] or labels.get(explicit_key, "本机 Skill"), explicit_key[:24]
    if item.get("scope") == "personal":
        return "我创建的", "personal"
    if item.get("scope") == "company":
        return "公司能力库", "company"
    root = os.path.normcase(os.path.abspath(str(item.get("root") or ""))).replace("\\", "/")
    bundled = os.path.normcase(os.path.abspath(bundled_root())).replace("\\", "/")
    home = os.path.normcase(os.path.abspath(home_root())).replace("\\", "/")
    if root == bundled:
        return "SoduWork 内置", "builtin"
    if root == home:
        return "SoduWork 本机", "soduwork"
    configured = {
        os.path.normcase(os.path.abspath(path)).replace("\\", "/")
        for path in configured_roots()
    }
    if root in configured:
        return "SoduWork 本机", "soduwork"
    if "/.pi/agent/skills" in root:
        return "Pi", "pi"
    if "/.agents/skills" in root:
        return "Agent Skills", "agents"
    if "/.codex/skills" in root:
        return "Codex", "codex"
    if "/.claude/skills" in root:
        return "Claude Code", "claude"
    return "本机 Skill", "local"


def runtime_public(item: dict) -> dict:
    """Metadata a Runner may disclose to the Hub; never include paths or content."""
    source, source_key = source_info({**item, "runtimeLocal": True})
    return {
        "name": str(item.get("name") or "")[:64],
        "description": str(item.get("description") or "")[:1024],
        "compatibility": str(item.get("compatibility") or "")[:500],
        "source": source, "sourceKey": source_key,
        "version": str(item.get("packageChecksum") or item.get("version") or "")[:64],
        "hasScripts": bool(item.get("hasScripts")),
    }


def runner_items(client) -> list[dict]:
    """Return metadata for Skills physically present on this client's Runner."""
    client_id = str(getattr(client, "id", "") or "")
    if not client_id:
        return []
    try:
        from . import runner_hub
        runner = runner_hub.for_client(client_id)
    except Exception:  # noqa: BLE001 - an offline registry is an empty local catalog
        runner = None
    if runner is None:
        return []
    catalog = list(getattr(runner, "skill_catalog", None) or [])
    if not catalog:
        catalog = [{"name": name, "source": "本机 Skill", "sourceKey": "local"}
                   for name in (getattr(runner, "skills", None) or [])]
    out = []
    for meta in catalog[:_MAX_SKILLS]:
        name = str(meta.get("name") or "").strip()[:64]
        if not name:
            continue
        source = str(meta.get("source") or "本机 Skill")[:40]
        source_key = str(meta.get("sourceKey") or "local")[:24]
        out.append({
            "name": name,
            "description": str(meta.get("description") or
                               ("安装在 %s 的本机 Skill" % source))[:1024],
            "compatibility": str(meta.get("compatibility") or "")[:500],
            "scope": "local", "runtimeLocal": True, "runtimeAvailable": True,
            "runtimeRunnerId": str(getattr(runner, "id", "") or "")[:64],
            "source": source, "sourceKey": source_key,
            "version": str(meta.get("version") or "")[:64],
            "hasScripts": bool(meta.get("hasScripts")),
            "path": "", "root": "", "dir": "",
        })
    return out


def available_for_client(extra_roots: list[str] | None, client) -> list[dict]:
    """Merge governed Hub Skills with native Skills on this device.

    A governed Skill wins same-name collisions, so a local folder cannot
    shadow a blocked company package. The Runner contributes availability and
    provenance only; paths and contents stay on the execution machine.
    """
    client_id = str(getattr(client, "id", "") or "")
    rows = [dict(item) for item in scan(extra_roots, owner_client_id=client_id)]
    return _with_runner_items(rows, client)


async def available_for_client_async(extra_roots: list[str] | None, client, *, _revision=None) -> list[dict]:
    rows = await scan_async(extra_roots, owner_client_id=str(getattr(client, "id", "") or ""),
                            _revision=_revision)
    # runner_hub is owned by the event loop. Read it here, not in the scan worker,
    # and never cache this device's live Runner state with filesystem metadata.
    return _with_runner_items(rows, client)


class PolicyChanged(ValueError):
    pass


async def catalog_with_policy(session, client=None, *, include_runner=True) -> tuple[dict, list[dict]]:
    """Read authorization after scanning; retry changed roots and fail closed.

    Administrators can revoke access while slow file I/O is pending. Roots are
    also policy: a same-named file from a removed root must not remain usable.
    """
    cfg = await _read_cfg(session)
    for _ in range(3):
        roots = cfg.get("roots") or []
        revision = await asyncio.to_thread(_package_revision)
        with _SCAN_CACHE_LOCK:
            generation = _SCAN_GENERATION
        rows = (await available_for_client_async(roots, client, _revision=revision)
                if client is not None and include_runner else await scan_async(
                    roots, owner_client_id=str(getattr(client, "id", "") or ""), _revision=revision))
        # Other Hub workers only change the shared index, not our generation.
        current_revision = await asyncio.to_thread(_package_revision)
        # Authorization is read after all potentially slow filesystem awaits.
        fresh = await _read_cfg(session)
        with _SCAN_CACHE_LOCK:
            if (_SCAN_GENERATION == generation and current_revision == revision
                    and (fresh.get("roots") or []) == roots):
                return skill_policy.effective(fresh, rows, bundled_root(), BASELINE_SKILLS), rows
        cfg = fresh
    raise PolicyChanged("企业能力目录配置正在变化，请刷新后重试")


def _with_runner_items(rows: list[dict], client) -> list[dict]:
    positions = {str(item.get("name") or ""): index for index, item in enumerate(rows)}
    for local in runner_items(client):
        name = str(local.get("name") or "")
        if name in positions:
            current = rows[positions[name]]
            sources = list(current.get("runtimeSources") or [])
            source = {"key": local.get("sourceKey"), "label": local.get("source")}
            if source not in sources:
                sources.append(source)
            current["runtimeSources"] = sources[:8]
            expected = str(
                current.get("pluginChecksum") or current.get("packageChecksum") or
                current.get("bundleChecksum") or "")
            reported = str(local.get("version") or "")
            # Name equality is not version equality. A stale native copy may be
            # listed as provenance, but cannot satisfy an immutable enterprise package.
            current["runtimeAvailable"] = bool(
                not expected or (reported and reported == expected))
            continue
        positions[name] = len(rows)
        rows.append(local)
    return sorted(rows, key=lambda item: str(item.get("name") or ""))


# Skill availability and selection.
async def _read_cfg(session) -> dict:
    """Read explicit grants and defaults without scanning or mutating settings."""
    from .. import models
    row = await session.get(models.AppSetting, SETTING_KEY, populate_existing=True)
    raw = row.value if row is not None else None
    return {**skill_policy.decode(raw)[0], "policyRevision": skill_policy.revision(raw)}


async def bootstrap(session) -> bool:
    """Reopen existing built-ins once; subsequent starts retain explicit opt-outs."""
    from sqlalchemy import select, update
    from sqlalchemy.exc import IntegrityError
    from ..models import AppSetting
    for _ in range(3):
        raw = (await session.execute(select(AppSetting.value).where(
            AppSetting.key == SETTING_KEY))).scalar_one_or_none()
        cfg, migrate = skill_policy.decode(raw)
        if not migrate:
            if cfg["policyVersion"] is None:
                log.warning("Skill policy is invalid; built-in defaults remain unavailable")
            return False
        value = json.dumps(cfg, ensure_ascii=False)
        if raw is None:
            session.add(AppSetting(key=SETTING_KEY, value=value))
            try:
                await session.commit()
                return True
            except IntegrityError:
                await session.rollback()
        else:
            result = await session.execute(update(AppSetting).where(
                AppSetting.key == SETTING_KEY, AppSetting.value == raw).values(value=value))
            if result.rowcount:
                await session.commit()
                return True
            await session.rollback()
    raise PolicyChanged("企业能力开放策略正在更新，请稍后重试")


async def load_cfg(session) -> dict:
    """Use the same post-scan authorization for every policy consumer."""
    cfg, _ = await catalog_with_policy(session, include_runner=False)
    return cfg


async def save_cfg(session, cfg: dict) -> dict:
    from sqlalchemy import select, update
    from .. import models
    if not isinstance(cfg, dict):
        raise PolicyChanged("企业能力开放策略格式无效，请刷新后重试")
    allowed = cfg.get("allowed", cfg.get("enabled", []))
    by_repo, roots = cfg.get("byRepo", {}), cfg.get("roots", [])
    def names(value):
        return isinstance(value, list) and all(isinstance(name, str) for name in value)
    if (not names(allowed) or not names(roots) or not isinstance(by_repo, dict) or
            any(not isinstance(key, str) or not names(value) for key, value in by_repo.items())):
        raise PolicyChanged("企业能力开放清单、目录或项目选择格式无效，请刷新后重试")
    current, rows = await catalog_with_policy(session, include_runner=False)
    if current.get("policyVersion") != skill_policy.VERSION:
        raise PolicyChanged("企业能力开放策略无效或版本不受支持，请先修复配置")
    if "policyRevision" in cfg and cfg["policyRevision"] != current.get("policyRevision"):
        raise PolicyChanged("企业能力开放策略已更新，请刷新后重新确认改动")
    desired = {name[:64] for name in allowed[:_MAX_SKILLS]}
    builtins = skill_policy.builtin_names(rows, bundled_root())
    snapshot = cfg.get("builtinCatalog", sorted(builtins))
    if not isinstance(snapshot, list) or any(not isinstance(name, str) for name in snapshot):
        raise PolicyChanged("企业能力目录快照无效，请刷新后重试")
    reviewed = set(snapshot)
    if reviewed - builtins:
        # A removed built-in or imported same-name row must not inherit a stale grant.
        raise PolicyChanged("企业内置能力目录已变化，请刷新后重试")
    disabled = ((set(current.get("builtinDisabled") or []) - reviewed) |
                (reviewed - desired)) - BASELINE_SKILLS
    clean = {"allowed": sorted(desired - builtins),
             "byRepo": {key[:64]: [name[:64] for name in value[:_MAX_SKILLS]]
                        for key, value in by_repo.items()},
             "roots": [root[:400] for root in roots[:10]],
             "policyVersion": skill_policy.VERSION, "builtinDisabled": sorted(disabled)}
    raw = (await session.execute(select(models.AppSetting.value).where(
        models.AppSetting.key == SETTING_KEY))).scalar_one_or_none()
    if skill_policy.revision(raw) != current["policyRevision"]:
        raise PolicyChanged("企业能力开放策略已更新，请刷新后重新确认改动")
    value = json.dumps(clean, ensure_ascii=False)
    if raw is None:
        # Both supported databases can reject a concurrent insert without
        # aborting the caller's transaction or prematurely releasing a savepoint.
        if session.get_bind().dialect.name == "postgresql":
            from sqlalchemy.dialects.postgresql import insert
        else:
            from sqlalchemy.dialects.sqlite import insert
        result = await session.execute(insert(models.AppSetting).values(
            key=SETTING_KEY, value=value).on_conflict_do_nothing(index_elements=["key"]))
        if not result.rowcount:
            raise PolicyChanged("企业能力开放策略已更新，请刷新后重新确认改动")
    else:
        result = await session.execute(update(models.AppSetting).where(
            models.AppSetting.key == SETTING_KEY,
            models.AppSetting.value == raw).values(value=value))
        if not result.rowcount:
            raise PolicyChanged("企业能力开放策略已更新，请刷新后重新确认改动")
    return skill_policy.effective({**clean, "policyRevision": skill_policy.revision(value)},
                                  rows, bundled_root(), BASELINE_SKILLS)




async def allow_shared_skill(session, name: str) -> None:
    """Merge one publication into policy without losing concurrent approvals."""
    from sqlalchemy import select, update
    from sqlalchemy.exc import IntegrityError
    from ..models import AppSetting
    for _ in range(6):
        raw = (await session.execute(select(AppSetting.value).where(
            AppSetting.key == SETTING_KEY))).scalar_one_or_none()
        cfg, _ = skill_policy.decode(raw)
        if cfg["policyVersion"] != skill_policy.VERSION:
            raise PolicyChanged("企业能力开放策略无效或版本不受支持，请先修复配置")
        allowed = list(cfg["allowed"])
        if name in allowed:
            return
        allowed.append(name)
        value = json.dumps({**cfg, "allowed": allowed}, ensure_ascii=False)
        if raw is None:
            session.add(AppSetting(key=SETTING_KEY, value=value))
            try:
                await session.commit()
                return
            except IntegrityError:
                await session.rollback()
        else:
            result = await session.execute(update(AppSetting).where(
                AppSetting.key == SETTING_KEY, AppSetting.value == raw).values(value=value))
            if result.rowcount:
                await session.commit()
                return
            await session.rollback()
    raise ValueError("开放策略正在更新；审核结果已保存，请在公司能力库中确认开放状态")


async def resolve(session, repo_id: str = "", client=None) -> list[dict]:
    """Resolve dispatch skills from repository selection when present, otherwise client defaults
    and explicit switches. Apply administrator availability rules and retain only skills
    discoverable on the execution machine.
    """
    cfg, rows = await catalog_with_policy(session, client)
    from . import skill_preferences
    mine = sorted(skill_preferences.selected_names(client, rows))
    names = cfg["byRepo"].get(repo_id) if (repo_id and repo_id in cfg["byRepo"]) else mine
    by_name = {s["name"]: s for s in rows}
    allowed = set(cfg["allowed"])
    out = []
    for name in (names or []):
        item = by_name.get(name)
        if not item:
            continue
        if item.get("scope") == "local":
            out.append(item)
            continue
        personal = item.get("scope") == "personal"
        if personal:
            if item.get("ownerClientId") == getattr(client, "id", ""):
                out.append(item)
        elif name in allowed or name in BASELINE_SKILLS:
            out.append(item)
    return out


async def resolve_named(session, names, client=None) -> list[dict]:
    """Resolve capabilities explicitly required by one task.

    Explicit does not mean privileged: company Skills still have to pass the
    administrator allow-list, and a personal Skill remains visible only to its owner.
    """
    requested: list[str] = []
    for raw in names or []:
        name = str(raw or "").strip()[:64]
        name = _LEGACY_SKILL_ALIASES.get(name, name)
        if name and name not in requested:
            requested.append(name)
        if len(requested) >= _MAX_SKILLS:
            break
    if not requested:
        return []
    cfg, rows = await catalog_with_policy(session, client)
    client_id = str(getattr(client, "id", "") or "")
    by_name = {item["name"]: item for item in rows}
    allowed = set(cfg["allowed"])
    missing: list[str] = []
    blocked: list[str] = []
    out: list[dict] = []
    for name in requested:
        item = by_name.get(name)
        if item is None:
            missing.append(name)
            continue
        if item.get("scope") == "local":
            out.append(item)
            continue
        if item.get("scope") == "personal":
            if str(item.get("ownerClientId") or "") != client_id:
                blocked.append(name)
                continue
        elif name not in allowed and name not in BASELINE_SKILLS:
            blocked.append(name)
            continue
        out.append(item)
    if missing:
        raise ValueError("执行能力未安装：" + "、".join(missing))
    if blocked:
        raise ValueError("管理员尚未开放执行能力：" + "、".join(blocked))
    return out


# Runtime skill injection.
def cli_args(skills: list[dict], cli: str) -> list[str]:
    """Use native runtime arguments where available, including repeatable Pi --skill options."""
    if cli != "pi" or not skills:
        return []
    out: list[str] = []
    for s in skills:
        out += ["--skill", s["path"]]
    return out


def prompt_block(skills: list[dict], native: bool) -> str:
    """Build prompt skill context. When loaded natively, mention availability without duplicating
    descriptions; otherwise include names and absolute paths for on-demand reading.
    """
    valid = []
    for raw in skills or []:
        item = raw if isinstance(raw, dict) else {}
        name = str(item.get("name") or "").strip()
        description = str(item.get("description") or "").strip()
        path = str(item.get("path") or "").strip()
        if name and description and path:
            valid.append({**item, "name": name, "description": description, "path": path})
    if not valid:
        return ""
    if native:
        return ("\n【可用技能】已经给你装上这几项：" +
                "、".join(s["name"] for s in valid) +
                "。对上号了就按它说的做。\n")
    lines = ["\n【可用技能（SoduWork 给这条活配的）】",
             "下面每一项都是一个技能目录，里面的 `SKILL.md` 写了完整做法。",
             "**判断哪一项对得上这次的活，对上了就先 `read` 它的 SKILL.md 再照着做**；都对不上就正常干。"]
    for s in valid:
        lines.append("- **%s**：%s\n  目录：%s" % (s["name"], s["description"], s["path"]))
    return "\n".join(lines) + "\n"
