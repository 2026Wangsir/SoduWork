"""Public module behavior and service contracts."""
from __future__ import annotations

import logging
import os

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am
from . import ai_local as _ai_local
from . import agent_naming, context_window, execution_capabilities
from . import execution_host_policy
from .ai_exec_route import (LOCAL_PREFIX, REMOTE_PREFIX,
                            by_assignee as _by_assignee,
                            by_ref as _by_ref,
                            by_ref_async as _by_ref_async)
from .ai_task_text import (PLAN_DELIVER, PROGRESS_FILE_RULE, milestone_brief,
                           parse_plan, plan_headline)

log = logging.getLogger("uvicorn.error")





_PROVIDERS = {"local": _ai_local}
_DEFAULT = "local"

# Single source of truth for supported local execution providers.
# Plugin simulation, release evaluation, and workflow execution must share this capability catalog.
def _declared_local_agent_kinds() -> tuple[str, ...]:
    from .local_base import _PROFILES
    return tuple("local:" + key for key in _PROFILES)


LOCAL_AGENT_KINDS = _declared_local_agent_kinds()

# Required adapter functions.
_REQUIRED = ("load", "configured", "enabled", "list_assignees_sync", "resolve_assignee_sync",
             "dispatch_sync", "status_sync", "fetch_attachment_sync", "preview_issue")

# Use neutral event names while recognizing historical multica.* events.
# Retiring an executor must not hide historical execution records.
EV_DISPATCHED = "ai.dispatched"
EV_DISPATCH_STARTED = "ai.dispatch_started"
EV_DISPATCH_UNCERTAIN = "ai.dispatch_uncertain"
EV_DISPATCH_FAILED = "ai.dispatch_failed"
EV_ARTIFACTS = "ai.artifacts"
KINDS_DISPATCHED = (EV_DISPATCHED, "multica.dispatched")
KINDS_ARTIFACTS = (EV_ARTIFACTS, "multica.artifacts")
KINDS_DISPATCH_STATE = (EV_DISPATCH_STARTED, EV_DISPATCH_UNCERTAIN,
                        EV_DISPATCH_FAILED) + KINDS_DISPATCHED + KINDS_ARTIFACTS


async def _provider_name(session: AsyncSession) -> str:
    from .. import models
    row = (await session.execute(
        select(models.AppSetting).where(models.AppSetting.key == "ai_exec_provider")
    )).scalars().first()
    name = (row.value or "").strip() if row else ""
    return name if name in _PROVIDERS else _DEFAULT


async def load(session: AsyncSession, force: bool = False) -> dict:
    """Load the active provider context containing its name and opaque adapter configuration.
    Callers pass configuration through without interpreting it.
    """
    name = await _provider_name(session)
    p = _PROVIDERS[name]
    ctx = {"name": name, "cfg": await p.load(session, force=force)}
    # Local execution must receive its own model and gateway configuration.
    # Do not pass another provider's configuration into the local adapter.
    # Missing local model settings can trigger unintended provider fallback and authentication failures.
    if name != "local":
        try:
            ctx["localCfg"] = await _ai_local.load(session, force=force)
        except Exception as e:  # noqa: BLE001
            log.warning("取本机 CLI 配置失败: %s", type(e).__name__)
            ctx["localCfg"] = {}
    return ctx


def _cfg_of(ctx: dict, p) -> dict:
    """Select configuration for the target provider. Remote Runners also use localCfg because they
    execute through ai_local with the same model, credentials, and development-flow settings.
    """
    if (ctx or {}).get("name") == "local":
        return (ctx or {}).get("cfg") or {}
    if p is _ai_local or getattr(p, "PREFIX", "") == REMOTE_PREFIX:
        return (ctx or {}).get("localCfg") or {}
    return (ctx or {}).get("cfg") or {}



def _runner_cfg(ctx: dict) -> dict:
    """Return remote-provider configuration and the current device boundary."""
    from . import ai_remote
    out = dict(_cfg_of(ctx, ai_remote) or {})
    if (ctx or {}).get("_runnerAllowedClients") is not None:
        out["allowedClients"] = list((ctx or {}).get("_runnerAllowedClients") or [])
    if (ctx or {}).get("_runnerAllowedOrgs") is not None:
        out["allowedOrgs"] = list((ctx or {}).get("_runnerAllowedOrgs") or [])
    if (ctx or {}).get("_runnerAllowedRunners") is not None:
        out["allowedRunners"] = list((ctx or {}).get("_runnerAllowedRunners") or [])
    # Strip same-named provider config. Only the server's owner-checked cloud
    # dispatch_scope can grant a personal environment.
    out.pop("personalRunnerOwner", None)
    out.pop("personalRunnerIds", None)
    if (ctx or {}).get("_cloudExecution"):
        out["personalRunnerOwner"] = str(ctx.get("_personalRunnerOwner") or "")
        out["personalRunnerIds"] = list(ctx.get("_personalRunnerIds") or [])
    return out

def _p(ctx: dict):
    return _PROVIDERS.get((ctx or {}).get("name") or _DEFAULT, _ai_local)


def execution_names(ctx: dict) -> dict:
    """Read execution_aliases from the already-loaded context. Avoid additional database queries in
    frequently polled workbench paths.
    """
    return (_cfg_of(ctx, _ai_local) or {}).get("names") or {}


def provider_name(ctx: dict) -> str:
    return (ctx or {}).get("name") or _DEFAULT


def provider(ctx: dict):
    """Return the active adapter for optional capability detection."""
    return _p(ctx)


def configured(ctx: dict) -> bool:
    """Check whether the required endpoint and credentials are configured."""
    return _p(ctx).configured(ctx.get("cfg") or {})


def available(ctx: dict) -> bool:
    """Check for an available executor within the current dispatch boundary."""
    if (ctx or {}).get("_clientRunnerOnly"):
        try:
            from . import runner_hub
            runner = runner_hub.for_client(str((ctx or {}).get("_dispatchClientId") or ""))
            return bool(runner and runner_hub.can_dispatch(runner) and runner.agents)
        except Exception:
            return False
    if (_p(ctx) is not _ai_local or execution_host_policy.hub_local_allowed()) and configured(ctx):
        return True
    try:
        if execution_host_policy.hub_local_allowed() and _ai_local.configured(_cfg_of(ctx, _ai_local)):
            return True
    except Exception:
        pass
    try:
        from . import ai_remote
        return ai_remote.configured(_runner_cfg(ctx))
    except Exception:
        return False


def enabled(ctx: dict) -> bool:
    """Check the default execution path; device-scoped mode allows only the current device's
    Runner.
    """
    if (ctx or {}).get("_clientRunnerOnly"):
        return available(ctx)
    return _p(ctx).enabled(ctx.get("cfg") or {})

def default_assignee(ctx: dict) -> dict:
    """Return a default that is actually dispatchable in the current scope.

    Organization configuration stores a portable kind such as ``local:opencode``.
    Employee clients, however, may dispatch only to the concrete Agent seat on
    their own embedded Runner.  Exposing the portable id as a UI default made
    unselected dispatches fail even while the roster visibly showed healthy
    ``runner:...`` seats.
    """
    configured_default = _p(ctx).default_assignee(ctx.get("cfg") or {}) or {}
    if not (ctx or {}).get("_clientRunnerOnly"):
        return configured_default
    agents = list((list_assignees_sync(ctx) or {}).get("agents") or [])
    if not agents:
        return {}
    configured_id = str(configured_default.get("id") or "").strip()
    preferred_cli = (configured_id.split(":", 1)[1]
                     if configured_id.startswith(LOCAL_PREFIX) else "")
    picked = next((item for item in agents
                   if preferred_cli and str(item.get("cli") or "") == preferred_cli), None)
    picked = picked or agents[0]
    return {"id": str(picked.get("id") or ""),
            "type": str(picked.get("type") or "agent")}

def agent_kinds() -> list[dict]:
    """Return portable agent types for organization templates, deriving CLI types from _PROFILES.
    Resolve a type to a concrete recipient only at dispatch time.
    """
    out = [{"key": "hosted", "name": "托管智能体", "modelPick": False,
            "note": "派给后台配好的那套托管 AI（模型在它那边按 agent 配，SoduWork 改不了）"}]
    try:
        from .local_base import _PROFILES
        for key, prof in list(_PROFILES.items()):
            out.append({"key": "local:" + key, "name": "本机 " + prof["name"],
                        "modelPick": bool(prof.get("needs_llm")),
                        "note": ("走共享模型服务，模型可以在这儿指定"
                                 if prof.get("needs_llm") else "用它自己的账号与模型，这儿指定不了模型")})
    except Exception as e:  # noqa: BLE001 - Keep configuration pages available if local discovery fails.
        log.warning("取 agent 类型清单失败: %s", type(e).__name__)
    return out


def _selected(item: dict | None, source: str, reason: str) -> dict | None:
    if item is None:
        return None
    out = dict(item)
    out["selection"] = {"source": str(source or "")[:40],
                        "reason": str(reason or "")[:240]}
    return out



def with_client_runner_scope(ctx: dict, client_id: str) -> dict:
    """Employee AI dispatch is restricted to the current device's Runner, without cross-machine or
    Hub fallback.
    """
    cid = str(client_id or "").strip()
    out = dict(ctx or {})
    out["_runnerAllowedClients"] = [cid] if cid else []
    out["_runnerAllowedOrgs"] = []
    out["_clientRunnerOnly"] = True
    out["_dispatchClientId"] = cid
    try:
        from . import runner_hub
        runner = runner_hub.for_client(cid)
        out["_runnerAllowedRunners"] = [runner.id] if runner is not None else []
    except Exception:
        out["_runnerAllowedRunners"] = []
    return out

def resolve_kind(ctx: dict, kind: str, client_id: str = "",
                 prefer_runner: str = "", required_capabilities=None,
                 runner_tags=None) -> dict | None:
    """Resolve a template type to a dispatchable recipient, or None. Prefer the previous Runner on
    reruns to preserve workspace, credentials, and toolchain continuity.
    """
    kind = (kind or "").strip()
    required = execution_capabilities.normalize(required_capabilities)
    tags = [str(x).strip().lower() for x in (runner_tags or []) if str(x).strip()]
    if not kind:
        return None
    if kind.startswith(LOCAL_PREFIX):
        cli = kind[len(LOCAL_PREFIX):]
        if (ctx or {}).get("_clientRunnerOnly"):
            try:
                from . import ai_remote, runner_hub
                scoped_client = str((ctx or {}).get("_dispatchClientId") or client_id or "")
                if not scoped_client or (client_id and str(client_id) != scoped_client):
                    return None
                runner = runner_hub.for_client(scoped_client)
                if runner is None or not runner_hub.can_dispatch(runner):
                    return None
                if cli and not any(str(a.get("key") or "") == cli for a in runner.agents or []):
                    return None
                if tags and not set(tags).issubset(set(runner.tags or [])):
                    return None
                if not runner_hub.supports_capabilities(runner, required):
                    return None
                aid = "%s%s:%s" % (REMOTE_PREFIX, runner.id, cli)
                hit = ai_remote.resolve_assignee_sync(_runner_cfg(ctx), aid, "agent")
                return _selected(hit, "current-device", "只派给当前设备在线 Agent")
            except Exception as error:
                log.warning("选择当前设备 Agent 失败: %s", type(error).__name__)
                return None
        # Templates identify an agent type; resolve the actual machine from task ownership.
        # Prefer the previous online Runner, then the owner's Runner, with broader fallbacks only where permitted.
        cli = kind[len(LOCAL_PREFIX):]
        if prefer_runner:
            try:
                from . import ai_remote, runner_hub
                pinned = runner_hub.get(prefer_runner)
                tagged = set(tags).issubset(set(getattr(pinned, "tags", []) or [])) \
                    if pinned is not None else False
                allowed = ctx.get("_runnerAllowedClients")
                allowed_orgs = ctx.get("_runnerAllowedOrgs")
                scoped = runner_hub.in_scope(
                    pinned, set(allowed) if allowed is not None else None,
                    set(allowed_orgs) if allowed_orgs is not None else None) \
                    if pinned is not None else False
                if pinned is not None and tagged and scoped and runner_hub.supports_capabilities(pinned, required):
                    aid = "%s%s:%s" % (REMOTE_PREFIX, prefer_runner, cli)
                    hit = ai_remote.resolve_assignee_sync(_runner_cfg(ctx), aid, "agent")
                    if hit is not None:
                        return _selected(hit, "continuation", "返工或续跑优先沿用上一轮执行机")
            except Exception as e:  # noqa: BLE001 - Continue normal selection if the preferred Runner cannot be used.
                log.warning("钉回上一轮执行机失败: %s", type(e).__name__)
        try:
            from . import ai_remote, runner_hub
            allowed = ctx.get("_runnerAllowedClients")
            scope = set(allowed) if allowed is not None else None
            allowed_orgs = ctx.get("_runnerAllowedOrgs")
            org_scope = set(allowed_orgs) if allowed_orgs is not None else None
            if tags:
                r = runner_hub.pick_by_tags(
                    tags, client_id, scope, required, allowed_org_ids=org_scope)
                if r is not None and not any(a.get("key") == cli for a in r.agents):
                    r = None
            else:
                r = (runner_hub.pick_for(
                    client_id, cli, scope, required, allowed_org_ids=org_scope) if required
                     else runner_hub.pick_for(
                         client_id, cli, scope, allowed_org_ids=org_scope))
            if r is not None:
                aid = "%s%s:%s" % (REMOTE_PREFIX, r.id, cli)
                hit = ai_remote.resolve_assignee_sync(_runner_cfg(ctx), aid, "agent")
                if hit is not None:
                    reason = ("需求归属人的在线客户端优先"
                              if client_id and r.client_id == client_id else
                              "满足流程标签与能力要求的执行机优选" if tags else
                              "按在线状态、能力与负载自动优选")
                    return _selected(hit, "scheduler", reason)
        except Exception as e:  # noqa: BLE001 - Preserve the permitted fallback when Runner selection fails.
            log.warning("按归属人挑执行机失败: %s", type(e).__name__)
        if tags or not execution_host_policy.hub_local_allowed():
            return None
        # A backend process is not a magical all-capable Runner. In production the
        # Hub and employee desktop are commonly on different machines, so a plugin
        # asking for Browser/Computer/Office must not silently fall back to a server
        # that cannot provide it.
        if required:
            local_report = execution_capabilities.runtime_report(
                str(ctx.get("local_workspace_root") or ""))
            if not execution_capabilities.evaluate(local_report, required).get("ok"):
                return None
        return _selected(
            resolve_assignee_sync(ctx, kind, "agent"), "fallback",
            "没有合适的远程 Runner，回落到具备所需能力的后端本机执行")
    if kind == "hosted":
        d = default_assignee(ctx) or {}
        if not d.get("id"):
            return None
        return _selected(resolve_assignee_sync(ctx, d["id"], d.get("type") or "agent"),
                         "default", "使用组织配置的默认智能体")
    return None


def model_choices(ctx: dict) -> dict:
    """Return the configured default model separately from the administrator-enabled alternatives.
    The default is omitted from list because the UI already exposes an inherited-default choice.
    Administrator configuration controls availability; each task or milestone controls its
    selection. Inheriting the default must continue to follow later administrator changes rather
    than pinning a duplicate model entry."""
    llm = (_cfg_of(ctx, _ai_local) or {}).get("llm") or {}
    d = str(llm.get("model") or "").strip()
    lst, seen = [], {d}
    for x in (llm.get("models") or []):
        s = str(x).strip()
        if s and s not in seen:
            seen.add(s)
            lst.append(s)
    return {"default": d, "list": lst}


def with_llm(ctx: dict, llm: dict | None) -> dict:
    """Return a copied context with this dispatch's complete model configuration: endpoint, key,
    and model. Resolve personal settings before organization defaults. Empty llm preserves
    existing configuration.
    """
    if not llm or not (llm.get("base") and llm.get("model") and
                       (llm.get("key") or llm.get("localOnly") is True)):
        return ctx
    resolved_window = context_window.resolve({
        "contextWindow": llm.get("contextWindow") or llm.get("ctxWindow"),
        "modelName": llm.get("model"),
        "provider": llm.get("provider") or llm.get("providerId"),
    })
    out = dict(ctx or {})
    for k in ("cfg", "localCfg"):
        c = out.get(k)
        if isinstance(c, dict):
            c2 = dict(c)
            # Keep the allowed-model list; it controls selection, not this dispatch's resolved model.
            c2["llm"] = {**(c.get("llm") or {}), "base": llm["base"],
                         "key": llm.get("key") or "", "model": llm["model"],
                         "kind": llm.get("kind") or "openai-compat",
                         "localOnly": llm.get("localOnly") is True,
                         "authMode": llm.get("authMode") or "api-key",
                         "contextWindow": resolved_window["contextWindow"],
                         "contextWindowKnown": resolved_window["contextWindowKnown"],
                         "contextWindowEstimated": resolved_window["contextWindowEstimated"],
                         "contextWindowSource": resolved_window["contextWindowSource"]}
            from .runtime_images import model_fields
            for field in ("input", "imageRouting", "visionFallbackAvailable", "maxOutputTokens", "capabilityProfile", "configRevision", "runtimeRevision"):
                c2["llm"].pop(field, None)
            c2["llm"].update(model_fields(llm))
            from .model_definition_contracts import _clean_thinking_config
            for field in ("reasoning", "thinkingMode", "thinkingFormat", "thinkingAlwaysOn",
                          "supportsReasoningEffort", "thinkingLevelMap"):
                c2["llm"].pop(field, None)
            c2["llm"].update(_clean_thinking_config(llm))
            out[k] = c2
    return out


def with_git(ctx: dict, git: dict | None) -> dict:
    """Return a copied context with the complete Git identity and push credentials inside cfg and
    localCfg. Empty credentials preserve executor defaults.
    """
    if not git or not any(str(git.get(k) or "").strip() for k in ("name", "token", "key")):
        return ctx
    out = dict(ctx or {})
    for k in ("cfg", "localCfg"):
        c = out.get(k)
        if isinstance(c, dict):
            out[k] = {**c, "git": dict(git)}
    return out


async def with_task_git(session, ctx: dict, task, *, lock_to_client: bool = True) -> dict:
    """Technical contract for with task git."""
    cid = str(getattr(task, "owner_client_id", "") or "")
    out = dict(ctx or {})
    try:
        from ..models import Client
        from . import code_creds
        c = await session.get(Client, cid)
        if c is not None:
            out = with_git(out, code_creds.resolve(c))
    except Exception as e:  # noqa: BLE001 - Credential lookup failure must not disable the entire dispatch path.
        log.warning("解析任务归属人的代码账号失败: %s", type(e).__name__)
    # Employee tasks remain bound to the owner's current device.
    # Plugin release evaluation separately authorizes the organization and selected Runner.
    # Injecting Git credentials must not narrow that authorized Runner to an unrelated client device.
    return with_client_runner_scope(out, cid) if lock_to_client else out


async def with_project_context(session, extra: dict, task, repo=None) -> dict:
    """Attach one portable project descriptor to every real task dispatch.

    Repository content is intentionally not read on the Hub. Local execution
    and remote Runner execution both materialize the descriptor only after the
    exact task worktree has been prepared.
    """
    from . import project_context

    return await project_context.attach(session, extra, task, repo)

def with_model(ctx: dict, model: str) -> dict:
    """Return a copied context overriding the model inside each adapter configuration that already
    has llm. Do not create incomplete model configurations without endpoint and credentials.
    """
    model = str(model or "").strip()
    if not model:
        return ctx
    out = dict(ctx or {})
    for k in ("cfg", "localCfg"):
        c = out.get(k)
        if isinstance(c, dict) and isinstance(c.get("llm"), dict):
            c2 = dict(c)
            c2["llm"] = dict(c["llm"])
            c2["llm"]["model"] = model
            out[k] = c2
    return out


def list_assignees_sync(ctx: dict) -> dict:
    """List dispatchable agents; employee views include only online agents on the current device's
    Runner.
    """
    out = {"agents": [], "squads": []}
    current_only = bool((ctx or {}).get("_clientRunnerOnly"))
    provider = _p(ctx)
    if not current_only:
        try:
            result = provider.list_assignees_sync(ctx.get("cfg") or {}) or {}
            out["agents"] = list(result.get("agents") or [])
            out["squads"] = list(result.get("squads") or [])
            if result.get("reason"):
                out["reason"] = result["reason"]
        except Exception as error:
            log.warning("取默认智能体名单失败: %s", type(error).__name__)
            out["reason"] = "默认执行底座的名单没拉到"
        try:
            local_cfg = _cfg_of(ctx, _ai_local)
            if provider is not _ai_local and _ai_local.configured(local_cfg):
                out["agents"] += list(
                    (_ai_local.list_assignees_sync(local_cfg) or {}).get("agents") or [])
        except Exception as error:
            log.warning("取后端本机 CLI 名单失败: %s", type(error).__name__)
    try:
        from . import ai_remote
        remote_cfg = _runner_cfg(ctx)
        remote_cfg["names"] = (_cfg_of(ctx, _ai_local) or {}).get("names") or {}
        out["agents"] += list(
            (ai_remote.list_assignees_sync(remote_cfg) or {}).get("agents") or [])
    except Exception as error:
        log.warning("取 Runner 智能体名单失败: %s", type(error).__name__)
    out["agents"] = dedupe_agents(out["agents"])
    if not execution_host_policy.hub_local_allowed():
        out["agents"] = [item for item in out["agents"]
                         if not str(item.get("id") or "").startswith(LOCAL_PREFIX)]
    if current_only and not out["agents"]:
        out["reason"] = "本机 Agent 尚未在线：请确认本机 Runner 已连接，并在 Agent 管理中安装、测通后重试"
    return out


def dedupe_agents(items: list[dict]) -> list[dict]:
    """Display one seat per machine and CLI, preferring Runner transport over the legacy local
    channel.
    """
    out: list[dict] = []
    by_seat: dict[str, int] = {}
    seen_ids: set[str] = set()

    def rank(item: dict) -> int:
        aid = str(item.get("id") or "")
        if aid.startswith(REMOTE_PREFIX):
            return 3
        if aid.startswith(LOCAL_PREFIX):
            return 2
        return 1

    for raw in items or []:
        item = dict(raw or {})
        aid = str(item.get("id") or "")
        if not aid or aid in seen_ids:
            continue
        seen_ids.add(aid)
        seat = agent_naming.desk_key(
            machine=str(item.get("machineKey") or ""),
            cli=str(item.get("cli") or item.get("cliName") or ""),
            name=str(item.get("name") or ""),
            runner_id=str(item.get("runnerId") or ""),
            host=str(item.get("host") or ""),
        )
        index = by_seat.get(seat)
        if index is None:
            by_seat[seat] = len(out)
            out.append(item)
        elif rank(item) > rank(out[index]):
            out[index] = item
    return out


def resolve_assignee_sync(ctx: dict, aid: str, atype: str = "") -> dict | None:
    p = _by_assignee(aid) or _p(ctx)
    if p is _ai_local and not execution_host_policy.hub_local_allowed():
        return None
    cfg = _runner_cfg(ctx) if getattr(p, "PREFIX", "") == REMOTE_PREFIX else _cfg_of(ctx, p)
    return p.resolve_assignee_sync(cfg, aid, atype)


def resolve_requested_sync(ctx: dict, aid: str, atype: str = "",
                            client_id: str = "", prefer_runner: str = "",
                            required_capabilities=None, runner_tags=None) -> dict | None:
    """Resolve a portable agent type or specific seat to this run's executor."""
    requested = (aid or "").strip()
    current_only = bool((ctx or {}).get("_clientRunnerOnly"))
    if requested.startswith(LOCAL_PREFIX) or requested == "hosted":
        if current_only and requested == "hosted":
            return None
        return resolve_kind(ctx, requested, client_id, prefer_runner,
                            required_capabilities, runner_tags)
    picked = resolve_assignee_sync(ctx, requested, atype)
    if current_only:
        expected = str((ctx or {}).get("_dispatchClientId") or client_id or "")
        if (not picked or not requested.startswith(REMOTE_PREFIX)
                or str(picked.get("clientId") or "") != expected):
            return None
    return _selected(picked, "user", "用户在安排执行时明确选择")


def resolve_default_sync(ctx: dict, client_id: str = "", preferred_kind: str = "",
                         required_capabilities=None) -> dict | None:
    """Resolve one deterministic default on the task owner's exact device.

    Project preference wins, then the organization default, then a concrete Agent
    reported by this device.  Every candidate still passes ``resolve_requested_sync``
    so this helper cannot bypass current-device or capability guards.
    """
    candidates = []
    preferred = str(preferred_kind or "").strip()
    if preferred:
        candidates.append(preferred)
    default_id = str((default_assignee(ctx) or {}).get("id") or "").strip()
    if default_id and default_id != "hosted":
        candidates.append(default_id)
    roster = list_assignees_sync(ctx)
    candidates.extend(str(item.get("id") or "").strip()
                      for item in list(roster.get("agents") or []))
    seen = set()
    for requested in candidates:
        if not requested or requested in seen:
            continue
        seen.add(requested)
        picked = resolve_requested_sync(
            ctx, requested, "agent", client_id, "", required_capabilities)
        if picked is not None:
            selected = dict(picked)
            selected["selection"] = {
                "source": "project" if requested == preferred else "default",
                "reason": "项目默认 Agent" if requested == preferred else "本机默认可用 Agent",
            }
            return selected
    return None


def required_capabilities(t, extra: dict | None = None) -> list[str]:
    """Return the immutable work-scenario contract plus this node's requirements."""
    return execution_capabilities.required_for(t, extra)


def dispatch_sync(ctx: dict, t, files: list | None = None,
                  assignee: dict | None = None, extra: dict | None = None) -> dict:
    from .task_requirements import ensure_executable
    try:
        ensure_executable(t)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    extra = dict(extra or {})
    extra["requiredAgentCapabilities"] = required_capabilities(t, extra)
    routed = _by_assignee((assignee or {}).get("id") or "")
    if getattr(routed, "PREFIX", "") == REMOTE_PREFIX:
        extra["skills"], skipped = execution_capabilities.dispatchable_skills(
            extra.get("skills") or [], (assignee or {}).get("capabilities") or {},
            extra.get("requiredSkills") or [])
        if skipped:
            extra["capabilityWarnings"] = list(extra.get("capabilityWarnings") or []) + [
                "本机尚未授权，已跳过可选能力：" + "、".join(skipped)]
    allowed = ctx.get("_runnerAllowedClients")
    allowed_orgs = ctx.get("_runnerAllowedOrgs")
    if (ctx or {}).get("_clientRunnerOnly"):
        expected = str((ctx or {}).get("_dispatchClientId") or "")
        actual = str((assignee or {}).get("clientId") or "")
        actual_runner = str((assignee or {}).get("runnerId") or "")
        if not actual_runner:
            actual_runner = str((assignee or {}).get("id") or "")[len(REMOTE_PREFIX):].partition(":")[0]
        allowed_runners = set((ctx or {}).get("_runnerAllowedRunners") or [])
        if (getattr(routed, "PREFIX", "") != REMOTE_PREFIX or not expected
                or actual != expected or actual_runner not in allowed_runners):
            return {"ok": False, "error":
                    "这条需求只能交给当前电脑上的在线 Agent；请打开 Agent 管理确认本机已安装并测通"}
    if getattr(routed, "PREFIX", "") == REMOTE_PREFIX and (allowed is not None or allowed_orgs is not None):
        from . import ai_remote, runner_hub
        runner_id = str((assignee or {}).get("id") or "")[len(REMOTE_PREFIX):].partition(":")[0]
        live_runner = runner_hub.get(runner_id)
        personal_grant = bool(live_runner and ai_remote.personal_cloud_authorized(_runner_cfg(ctx), live_runner))
        client_id = str((assignee or {}).get("clientId") or "")
        org_id = str((assignee or {}).get("orgId") or "")
        permitted = (client_id in set(allowed or [])) if client_id else \
            bool(org_id and org_id in set(allowed_orgs or []))
        if not permitted and not personal_grant:
            return {"ok": False, "error": "这台执行机不属于需求所在组织，不能把资料派过去"}
    p = routed or _p(ctx)
    if p is _ai_local and not execution_host_policy.hub_local_allowed():
        return execution_host_policy.local_disabled_result()
    if ctx.get("_cloudExecution"):
        from . import runner_hub
        rid = str((assignee or {}).get("id") or "")[len(REMOTE_PREFIX):].partition(":")[0]
        runner = runner_hub.get(rid) if getattr(p, "PREFIX", "") == REMOTE_PREFIX else None
        if not runner or not execution_host_policy.cloud_runner_allowed(runner.id, runner.client_id):
            return {"ok": False, "code": "CLOUD_RUNNER_NOT_ALLOWED",
                    "error": "目标执行机未获准承载云端会话，请刷新列表"}
    cfg = _runner_cfg(ctx) if getattr(p, "PREFIX", "") == REMOTE_PREFIX else _cfg_of(ctx, p)
    r = p.dispatch_sync(cfg, t, files, assignee, extra)
    if isinstance(r, dict):
        # The browser selection is advisory. Persist the route selected by the
        # Hub and the adapter receipt, so task details remain correct after a
        # refresh/restart and local/remote execution cannot be confused.
        from . import execution_context
        r['executionContext'] = execution_context.build(
            extra, assignee=assignee, dispatch=r, task=t)
        # Keep local, remote, and managed execution distinct so machine provenance remains accurate.
        r["provider"] = ("runner" if getattr(p, "PREFIX", "") == REMOTE_PREFIX
                         else "local" if routed else provider_name(ctx))
    return r


def status_sync(ctx: dict, ref: str) -> dict:
    p = _by_ref(ref) or _p(ctx)
    return p.status_sync(_cfg_of(ctx, p), ref)


def fetch_attachment_for_sync(ctx: dict, ref: str, attachment_id: str) -> bytes | None:
    """Fetch an artifact from the exact execution, avoiding cross-run filename ambiguity."""
    p = _by_ref(ref) or _p(ctx)
    cfg = _cfg_of(ctx, p)
    if hasattr(p, "fetch_attachment_for_sync"):
        return p.fetch_attachment_for_sync(cfg, ref, attachment_id)
    return p.fetch_attachment_sync(cfg, attachment_id)


def runner_info_sync(ctx: dict, ref: str) -> dict:
    """Return optional execution machine and directory details. These are recovery hints; only
    attachments or accessible URLs returned to SoduWork count as delivered outputs.
    """
    p = _by_ref(ref) or _p(ctx)
    if not hasattr(p, "runner_info_sync"):
        return {}
    try:
        return p.runner_info_sync(_cfg_of(ctx, p), ref) or {}
    except Exception as e:  # noqa: BLE001 - Missing recovery hints must not interrupt execution.
        log.warning("取执行机信息失败: %s", type(e).__name__)
        return {}


def session_sync(ctx: dict, ref: str, since: int = 0) -> dict:
    """Read optional live execution activity, including messages, commands, and file changes,
    through the provider's read-only interface.
    """
    p = _by_ref(ref) or _p(ctx)
    if not hasattr(p, "session_sync"):
        return {"ok": False, "items": [], "error": "当前执行底座看不到会话"}
    try:
        return p.session_sync(_cfg_of(ctx, p), ref, since)
    except Exception as e:  # noqa: BLE001
        log.warning("取执行会话失败: %s", type(e).__name__)
        return {"ok": False, "items": [], "error": "会话拿不到"}


def console_list_sync(ctx: dict, task_ids: list[str] | None = None) -> dict:
    """List local execution consoles when supported; otherwise return an empty list."""
    if not hasattr(_ai_local, "console_list_sync"):
        return {"ok": True, "runs": []}
    try:
        return _ai_local.console_list_sync(_cfg_of(ctx, _ai_local), task_ids)
    except Exception as e:  # noqa: BLE001
        log.warning("取本机会话一览失败: %s", type(e).__name__)
        return {"ok": True, "runs": []}


def local_workdir(ref: str) -> str:
    """Return the local execution directory from memory without network access or directory scans.
    Return empty when no local directory exists.
    """
    if not ref:
        return ""
    try:
        run = getattr(_ai_local, "_RUNS", {}).get(ref)
        return (run or {}).get("ws") or ""
    except Exception:  # noqa: BLE001
        return ""


def raw_tail_sync(ctx: dict, ref: str, limit: int = 60000) -> dict:
    """Return optional raw terminal output for diagnostics."""
    p = _by_ref(ref) or _p(ctx)
    if not hasattr(p, "raw_tail_sync"):
        return {"ok": False, "text": "", "error": "这条执行没有原始输出（只有本机跑的才有）"}
    try:
        return p.raw_tail_sync(_cfg_of(ctx, p), ref, limit)
    except Exception as e:  # noqa: BLE001
        log.warning("取原始输出失败: %s", type(e).__name__)
        return {"ok": False, "text": "", "error": "原始输出拿不到"}


def comments_sync(ctx: dict, ref: str) -> dict:
    """Fetch complete execution comments when supported; planning needs the full response rather
    than the truncated status summary.
    """
    p = _by_ref(ref) or _p(ctx)
    if not hasattr(p, "comments_sync"):
        return {"ok": False, "items": [], "error": "当前执行底座读不到回复"}
    try:
        return p.comments_sync(_cfg_of(ctx, p), ref)
    except Exception as e:  # noqa: BLE001
        log.warning("取执行单评论失败: %s", type(e).__name__)
        return {"ok": False, "items": [], "error": "回复拿不到"}


def plan_draft(ctx: dict, ref: str) -> dict:
    """Parse milestones from the last agent reply that contains a valid plan. If parsing fails,
    retain the original response for manual planning.
    """
    r = comments_sync(ctx, ref)
    if not r.get("ok"):
        return {"ok": False, "items": [], "raw": "", "error": r.get("error", "")}
    raw = ""
    items: list[dict] = []
    bodies = [(c.get("body") or "") for c in (r.get("items") or [])]
    for body in bodies:
        got = parse_plan(body)
        if got:
            items, raw = got, body      # Keep the last successfully parsed response.
        elif not raw and "里程碑" in body:
            raw = body                  # Preserve recognizable plan text even when structured parsing fails.
    # Local agent responses may split a plan across multiple streamed text events.
    # Parsing individual fragments can omit later milestones.
    # Also parse the concatenated response.
    # Prefer the result with more milestones when the complete plan spans fragments.
    joined = "\n".join(b for b in bodies if b.strip())
    if joined and len(joined) > len(raw):
        got = parse_plan(joined)
        if len(got or []) > len(items):
            items, raw = got, joined
        elif not items and "里程碑" in joined:
            raw = joined
    return {"ok": True, "items": items, "raw": raw[:20000]}


def say_sync(ctx: dict, ref: str, text: str, *, record_user: bool = True, message_id: str = "") -> dict:
    """Send an optional message to the execution. Queued work incorporates it before starting;
    running work receives it after the current turn. This does not interrupt execution or attach
    a terminal.
    """
    if ctx.get("_continuationRunnerId"):
        from . import ai_remote
        p = ai_remote
    else:
        p = _by_ref(ref) or _p(ctx)
    if p is _ai_local and not execution_host_policy.hub_local_allowed():
        return execution_host_policy.local_disabled_result()
    if not hasattr(p, "comment_sync"):
        return {"ok": False, "error": "\u5f53\u524d\u6267\u884c\u5e95\u5ea7\u4e0d\u652f\u6301\u7ed9 AI \u7559\u8a00"}
    cfg = dict(_cfg_of(ctx, p) or {})
    if ctx.get("_turnFiles"):
        if getattr(p, "PREFIX", "") != REMOTE_PREFIX:
            return {"ok": False, "error": "追加文件只能发送到原远程执行机"}
        cfg["_turnFiles"] = ctx["_turnFiles"]
    if message_id:
        cfg["_messageId"] = message_id
    if record_user and p is _ai_local:
        try:
            from . import local_stream
            local_stream.record_user_sync(ref, text)
        except Exception as error:  # noqa: BLE001
            log.warning("persist local user turn failed: %s", type(error).__name__)
    elif record_user and getattr(p, "PREFIX", "") == REMOTE_PREFIX:
        cfg["_recordUser"] = True
    try:
        result = p.comment_sync(cfg, ref, text)
    except Exception as error:  # noqa: BLE001
        log.exception("send execution comment failed")
        return {"ok": False, "uncertain": getattr(p, "PREFIX", "") == REMOTE_PREFIX,
                "error": str(error)[:160] or
                "\u6267\u884c\u5e95\u5ea7\u6ca1\u6709\u63a5\u53d7\u8fd9\u6761\u7559\u8a00"}
    if not isinstance(result, dict):
        return {"ok": False, "error": "\u6267\u884c\u5e95\u5ea7\u8fd4\u56de\u4e86\u65e0\u6548\u56de\u6267"}
    return result


def can_stop(ctx: dict, ref: str) -> bool:
    """Check whether the provider supports cancellation and this execution is currently running."""
    p = _by_ref(ref)
    if not (p and hasattr(p, "stop_sync")):
        return False
    if hasattr(p, "is_running"):
        try:
            return bool(p.is_running(ref))
        except Exception:  # noqa: BLE001
            return False
    return True


def stop_sync(ctx: dict, ref: str) -> dict:
    """Stop the current execution turn when the provider supports it."""
    p = _by_ref(ref) or _p(ctx)
    if not hasattr(p, "stop_sync"):
        return {"ok": False, "error": "这条执行不支持叫停（托管的 agent 没有可取消的接口，"
                                      "只能等它跑完；本机跑的才能说停就停）"}
    return p.stop_sync(_cfg_of(ctx, p), ref)


def remind_sync(ctx: dict, ref: str, text: str) -> dict:
    """Request output delivery using the fixed REMIND_TEXT message."""
    return say_sync(ctx, ref, text, record_user=False)


# Output-delivery reminder text.
# Explicitly state that this reminder takes precedence over earlier delivery instructions.
# Otherwise conflicting instructions can cause the agent to request clarification instead of uploading.
# The task owner's explicit reminder authorizes the updated delivery instruction.
REMIND_TEXT = (
    "【交付要求 · 以本条为准，覆盖此前关于交付方式的任何说法】\n"
    "这活的产出还没回到 SoduWork。**在你本地工作目录里的文件不算交付**——那台机器别人拿不到。\n"
    "请把主产出写成工作目录里的文件（如 结果.md）；"
    "如果交付物是一个可访问的网站/服务，请在回复里直接给出可访问的 URL。\n"
    "如果确实没有可交付的文件，请回一句说明为什么。"
)


def preview(t, ctx: dict, extra: dict | None = None) -> dict:
    """Preview dispatch using the exact same composition path as actual execution."""
    return _p(ctx).preview_issue(t, ctx.get("cfg") or {}, extra)


# Provider-independent SoduWork orchestration.

async def collect_task_files(session, task_id: str, limit: int = 5,
                             max_mb: int = 10) -> list[tuple[str, bytes, str]]:
    """Collect human-uploaded task attachments as name, bytes, and content type. Exclude
    agent-prefixed uploaders to avoid feeding previous AI outputs back as inputs.
    """
    from sqlalchemy import select as _sel

    from .. import models
    from . import storage
    rows = (await session.execute(
        _sel(models.Attachment).where(models.Attachment.task_id == task_id)
        .order_by(models.Attachment.created_at)
    )).scalars().all()
    out: list[tuple[str, bytes, str]] = []
    for a in rows:
        if str(a.uploaded_by or "").startswith("agent:"):
            continue
        if a.size and a.size > max_mb * 1024 * 1024:
            continue
        try:
            data = storage.get(a.storage_key, a.backend)
        except Exception:  # noqa: BLE001 - Skip unavailable attachments without failing dispatch.
            continue
        out.append((a.filename, data, a.content_type or "application/octet-stream"))
        if len(out) >= limit:
            break
    return out


async def list_task_file_names(session, task_id: str, limit: int = 5, max_mb: int = 10) -> list[str]:
    """Collect preview file names without reading contents, using the same filtering rules as
    collect_task_files.
    """
    from sqlalchemy import select as _sel

    from .. import models
    rows = (await session.execute(
        _sel(models.Attachment).where(models.Attachment.task_id == task_id)
        .order_by(models.Attachment.created_at)
    )).scalars().all()
    out = []
    for a in rows:
        if str(a.uploaded_by or "").startswith("agent:"):
            continue
        if a.size and a.size > max_mb * 1024 * 1024:
            continue
        out.append(a.filename)
        if len(out) >= limit:
            break
    return out


async def collect_task_context(session, task_id: str, limit: int = 5) -> dict:
    """Include recent collaboration comments as dispatch context so decisions made in the task
    thread reach the agent.
    """
    from sqlalchemy import select as _sel

    from .. import models
    rows = (await session.execute(
        _sel(models.TaskComment).where(models.TaskComment.task_id == task_id)
        .order_by(models.TaskComment.created_at.desc()).limit(limit)
    )).scalars().all()
    out = [((r.author_name or "同事"), (r.body or "").strip().replace("\n", " ")[:200])
           for r in reversed(rows) if (r.body or "").strip()]
    return {"comments": out}


async def last_dispatch_event(session, tid: str):
    """Find the latest AI dispatch event, including historical multica.* events."""
    from sqlalchemy import select as _sel

    from ..models import TaskEvent
    return (await session.execute(
        _sel(TaskEvent).where(TaskEvent.task_id == tid, TaskEvent.kind.in_(KINDS_DISPATCHED))
        .order_by(TaskEvent.at.desc()).limit(1)
    )).scalars().first()


async def pull_artifacts(session: AsyncSession, tid: str, ctx: dict, s: dict, ref: str = "",
                         settle: bool = True) -> dict:
    """Compatibility entry point; artifact_ingest owns the complete output-ingestion lifecycle."""
    from . import artifact_ingest
    return await artifact_ingest.pull_artifacts(session, tid, ctx, s, ref, settle)


# Branch discovery, merging, release, and delivery checks live in services/code_delivery.py.
# Keep delivery orchestration separate from provider adaptation.
# This separation also avoids circular dependencies with task and event handling.
# Call code_delivery.check() or .ship(); the legacy auto_ship entry point is retired.
