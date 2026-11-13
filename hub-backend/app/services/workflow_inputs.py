"""Workflow inputs, attachment evidence and declarative output validation."""
from __future__ import annotations

import hashlib
import json
import re

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am
from .. import models
from . import plugin_packages, skills, storage, workflow_contracts


_DECISION_REASONS = {
    "ready", "missing_toolchain", "missing_credentials", "missing_input",
    "no_reproducible_issue", "unsafe_change", "other",
}
_DECISION_LIMIT = 256 * 1024
_AI_INPUT_FILE_LIMIT = 20
_AI_INPUT_FILE_BYTES = 20 * 1024 * 1024


def _logical_filename(value: str) -> str:
    """Return a stable identity for one task attachment.

    Workflow retries intentionally keep every historical attachment for audit,
    but an executor must only receive the newest value of a logical file. The
    Runner otherwise has to suffix duplicates (``code-review-2.json`` ...), and
    those stale reports can consume the whole model context before work starts.
    """
    raw = str(value or "").strip().replace("\\", "/")
    parts = [part for part in raw.split("/") if part not in ("", ".", "..")]
    return "/".join(parts).casefold()


def _same_or_after(value, boundary) -> bool:
    if boundary is None:
        return True
    if value is None:
        return False
    # SQLite may return naive datetimes while PostgreSQL keeps timezone information.
    if value.tzinfo is None and boundary.tzinfo is not None:
        boundary = boundary.replace(tzinfo=None)
    elif value.tzinfo is not None and boundary.tzinfo is None:
        value = value.replace(tzinfo=None)
    return value >= boundary


async def code_review_report(session: AsyncSession, task_id: str, started_at=None,
                             *, attachment_id: str = "") -> dict:
    """Read and strictly validate the report produced by the current AI-review attempt.

    ``attachment_id`` pins the exact report to validate.  SoduWork's own Gerrit reviewer
    writes the report itself and must not re-discover it by timestamp: database clocks
    are coarse (whole seconds on SQLite, transaction start on PostgreSQL), so a
    just-written file can look "older" than the node attempt that produced it.
    """
    rows = list((await session.execute(select(models.Attachment).where(
        models.Attachment.task_id == task_id
    ).order_by(models.Attachment.created_at.desc(), models.Attachment.id.desc()))).scalars().all())
    row = next((item for item in rows if item.id == attachment_id), None) if attachment_id \
        else next((item for item in rows
                   if item.filename.replace("\\", "/").rsplit("/", 1)[-1] == "code-review.json"
                   and _same_or_after(item.created_at, started_at)), None)
    if row is None:
        raise workflow_contracts.WorkflowContractError(
            "AI 代码审查没有交付本轮的 code-review.json")
    if int(row.size or 0) > 1024 * 1024:
        raise workflow_contracts.WorkflowContractError("AI 代码审查报告超过 1 MB")
    try:
        raw = storage.get(row.storage_key, row.backend)
        data = json.loads(raw.decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise workflow_contracts.WorkflowContractError(
            "code-review.json 不是有效的 UTF-8 JSON") from exc
    if not isinstance(data, dict) or int(data.get("schemaVersion") or 0) != 1:
        raise workflow_contracts.WorkflowContractError("代码审查报告 schemaVersion 必须是 1")
    verdict = str(data.get("verdict") or "").strip().lower()
    if verdict not in ("pass", "changes_requested"):
        raise workflow_contracts.WorkflowContractError(
            "代码审查结论只能是 pass 或 changes_requested")
    raw_findings = data.get("findings") or []
    raw_checks = data.get("checks") or []
    if not isinstance(raw_findings, list) or not isinstance(raw_checks, list):
        raise workflow_contracts.WorkflowContractError("代码审查 findings 与 checks 必须是数组")
    findings = []
    for item in raw_findings[:100]:
        if not isinstance(item, dict):
            raise workflow_contracts.WorkflowContractError("代码审查 finding 必须是对象")
        severity = str(item.get("severity") or "").strip().lower()
        message = str(item.get("message") or "").strip()
        if severity not in ("blocker", "major", "minor") or not message:
            raise workflow_contracts.WorkflowContractError(
                "每条代码问题必须有 blocker/major/minor 严重级别和说明")
        findings.append({
            "severity": severity,
            "file": str(item.get("file") or "")[:300],
            "line": max(0, int(item.get("line") or 0)),
            "message": message[:1200],
            "suggestion": str(item.get("suggestion") or "")[:1200],
        })
    if verdict == "pass" and any(x["severity"] in ("blocker", "major") for x in findings):
        raise workflow_contracts.WorkflowContractError(
            "代码审查标记为 pass，但仍包含 blocker 或 major 问题")
    if verdict == "changes_requested" and not any(
            x["severity"] in ("blocker", "major") for x in findings):
        raise workflow_contracts.WorkflowContractError(
            "要求返修时必须至少指出一条 blocker 或 major 问题")
    checks = [str(x).strip()[:500] for x in raw_checks[:100] if str(x).strip()]
    summary = str(data.get("summary") or "").strip()[:2000]
    if not summary:
        raise workflow_contracts.WorkflowContractError("代码审查报告缺少 summary")
    return {
        "schemaVersion": 1, "verdict": verdict, "summary": summary,
        "findings": findings, "checks": checks, "attachmentId": row.id,
        "reportChecksum": hashlib.sha256(raw).hexdigest(),
    }


async def node_decision(session: AsyncSession, task_id: str, path: str,
                        started_at=None, *, node_run_id: str = "") -> dict:
    """Validate the current node attempt's continue/blocked outcome. Bind new evidence by
    node_run_id; use time boundaries only for legacy records so rework cannot reuse a prior
    attempt's conclusion.
    """
    wanted = str(path or "").strip().replace(chr(92), "/").lstrip("/")
    rows = list((await session.execute(select(models.Attachment).where(
        models.Attachment.task_id == task_id
    ).order_by(models.Attachment.created_at.desc(), models.Attachment.id.desc()))).scalars().all())

    def matches(item) -> bool:
        filename = str(item.filename or "").replace(chr(92), "/").lstrip("/")
        return filename == wanted

    if node_run_id:
        row = next((item for item in rows
                    if matches(item) and str(item.node_run_id or "") == node_run_id), None)
    else:
        row = next((item for item in rows
                    if matches(item) and _same_or_after(item.created_at, started_at)), None)
    if row is None:
        raise workflow_contracts.WorkflowContractError(
            f"AI 没有交付本轮的节点决策 {wanted or 'workflow-decision.json'}")
    if int(row.size or 0) > _DECISION_LIMIT:
        raise workflow_contracts.WorkflowContractError("节点决策文件超过 256 KB")
    try:
        raw = storage.get(row.storage_key, row.backend)
        if len(raw) > _DECISION_LIMIT:
            raise ValueError("too large")
        data = json.loads(raw.decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise workflow_contracts.WorkflowContractError(
            "节点决策不是有效的 UTF-8 JSON，或文件超过 256 KB") from exc
    try:
        schema_version = int(data.get("schemaVersion") or 0) if isinstance(data, dict) else 0
    except (TypeError, ValueError):
        schema_version = 0
    if not isinstance(data, dict) or schema_version != 1:
        raise workflow_contracts.WorkflowContractError("节点决策 schemaVersion 必须是 1")
    outcome = str(data.get("outcome") or "").strip().lower()
    if outcome not in {"proceed", "blocked"}:
        raise workflow_contracts.WorkflowContractError(
            "节点决策 outcome 只能是 proceed 或 blocked")
    summary = str(data.get("summary") or "").strip()[:2000]
    if not summary:
        raise workflow_contracts.WorkflowContractError("节点决策缺少 summary")
    reason_code = str(data.get("reasonCode") or ("ready" if outcome == "proceed" else "")).strip()
    if reason_code not in _DECISION_REASONS:
        raise workflow_contracts.WorkflowContractError("节点决策 reasonCode 不受支持")
    next_action = str(data.get("nextAction") or "").strip()[:2000]
    if outcome == "blocked" and (reason_code == "ready" or not next_action):
        raise workflow_contracts.WorkflowContractError(
            "阻断结论必须给出非 ready 的 reasonCode 和 nextAction")
    if outcome == "proceed" and reason_code != "ready":
        raise workflow_contracts.WorkflowContractError("允许继续时 reasonCode 必须是 ready")
    raw_evidence = data.get("evidence") or []
    if not isinstance(raw_evidence, list):
        raise workflow_contracts.WorkflowContractError("节点决策 evidence 必须是数组")
    evidence = [str(item).strip()[:600] for item in raw_evidence[:40] if str(item).strip()]
    return {
        "schemaVersion": 1, "outcome": outcome, "summary": summary,
        "reasonCode": reason_code, "evidence": evidence, "nextAction": next_action,
        "attachmentId": row.id, "path": wanted,
        "checksum": hashlib.sha256(raw).hexdigest(),
    }


async def all_files(session: AsyncSession, task_id: str, *,
                    exclude_names: set[str] | None = None) -> list[tuple[str, bytes, str]]:
    """Load the latest logical task inputs for an executor.

    Attachments remain append-only in the database for audit. Dispatch input is
    a materialized current view: latest file wins, deterministic ties use the
    attachment id, and control outputs can be excluded by the caller. This is
    deliberately filename based rather than content based because two website
    paths may validly contain identical bytes.
    """
    rows = list((await session.execute(select(models.Attachment).where(
        models.Attachment.task_id == task_id
    ).order_by(models.Attachment.created_at, models.Attachment.id))).scalars().all())
    excluded = {_logical_filename(name) for name in (exclude_names or set())}
    latest: dict[str, tuple[int, models.Attachment]] = {}
    for index, row in enumerate(rows):
        logical = _logical_filename(row.filename)
        basename = logical.rsplit("/", 1)[-1]
        if not logical or logical in excluded or basename in excluded:
            continue
        latest[logical] = (index, row)
    selected = [item[1] for item in sorted(latest.values())][-_AI_INPUT_FILE_LIMIT:]
    out = []
    for row in selected:
        if row.size and row.size > _AI_INPUT_FILE_BYTES:
            continue
        try:
            out.append((row.filename, storage.get(row.storage_key, row.backend), row.content_type))
        except Exception:  # noqa: BLE001
            continue
    return out


async def requirement_manifest(session: AsyncSession, task: models.Task,
                               config: dict) -> dict:
    """Extract acceptance criteria, assumptions and risks from requirements.md."""
    wanted = [str(x) for x in (config.get("files") or ["requirements.md"])]
    rows = list((await session.execute(select(models.Attachment).where(
        models.Attachment.task_id == task.id
    ).order_by(models.Attachment.created_at))).scalars().all())
    latest = {}
    for row in rows:
        if row.filename in wanted:
            latest[row.filename] = row
    selected = [latest[name] for name in wanted if name in latest]
    if not selected:
        raise workflow_contracts.WorkflowContractError("需求分析节点没有产出 requirements.md")
    files, sections = [], {"acceptanceCriteria": [], "assumptions": [], "risks": []}
    heading_map = {
        "验收": "acceptanceCriteria", "acceptance": "acceptanceCriteria",
        "假设": "assumptions", "assumption": "assumptions",
        "风险": "risks", "risk": "risks",
    }
    pattern = (
        r"^(?:"
        r"[-*+]\s+(?:\[(?:[ xX]|[A-Za-z][A-Za-z0-9_-]{0,15})\]\s*)?"
        r"|\d+[.)、]\s+"
        r"|(?:AC|[A-Za-z])[-_ ]?\d+[.)、:：]?\s*"
        r")"
    )
    for row in selected:
        files.append({"id": row.id, "name": row.filename, "size": int(row.size or 0),
                      "contentType": row.content_type or "text/markdown"})
        try:
            text = storage.get(row.storage_key, row.backend).decode(
                "utf-8", errors="replace")[:300000]
        except Exception as exc:  # noqa: BLE001
            raise ValueError("需求说明读不出来（%s）" % type(exc).__name__) from exc
        active = ""
        active_level = 0
        for line in text.splitlines():
            stripped = line.strip()
            if stripped.startswith("#"):
                level = len(stripped) - len(stripped.lstrip("#"))
                low = stripped[level:].strip().lower()
                section = next((value for key, value in heading_map.items() if key in low), "")
                if section:
                    active, active_level = section, level
                elif not active or level <= active_level:
                    active, active_level = "", 0
                continue
            if active and re.match(pattern, stripped):
                value = re.sub(pattern, "", stripped).strip()
                if value and value not in sections[active]:
                    sections[active].append(value[:500])
    if not sections["acceptanceCriteria"]:
        raise workflow_contracts.WorkflowContractError(
            "requirements.md 没有可识别的逐条验收标准")
    return {"files": files, **sections}


async def plugin_skills(session: AsyncSession, version: am.PluginVersion,
                        names: list[str] | None = None) -> list[dict]:
    report = dict(version.capability_report or {})
    bundled = plugin_packages.materialize_skills(
        version.package_path, version.checksum, report)
    selected = set(str(x) for x in names) if names is not None else None
    bundled_names = {x["name"] for x in bundled}
    bundled = [x for x in bundled if selected is None or x["name"] in selected]
    required = set(report.get("externalSkills") or [])
    # Versions created before bundledSkills/externalSkills existed keep the original behavior.
    if "externalSkills" not in report:
        required = set(report.get("skills") or []) - bundled_names
    if selected is not None:
        required &= selected
    if not required:
        return bundled
    cfg, rows = await skills.catalog_with_policy(session, include_runner=False)
    denied = required - set(cfg.get("allowed") or [])
    if denied:
        raise ValueError("插件需要但组织尚未开放的技能：" + "、".join(sorted(denied)))
    found = {x["name"]: x for x in rows}
    missing = required - set(found)
    if missing:
        raise ValueError("执行环境缺少技能：" + "、".join(sorted(missing)))
    return bundled + [found[x] for x in sorted(required)]


async def validate(session: AsyncSession, task: models.Task, node: dict) -> dict:
    rows = list((await session.execute(select(models.Attachment).where(
        models.Attachment.task_id == task.id))).scalars().all())
    by_name = {x.filename: x for x in rows}
    results = []
    for rule in dict(node.get("config") or {}).get("rules") or []:
        kind, name = rule.get("type"), rule.get("name") or "检查"
        passed, detail = False, ""
        if kind == "file":
            row = by_name.get(str(rule.get("nameEquals") or ""))
            passed = row is not None and int(row.size or 0) >= int(rule.get("minBytes") or 1)
            detail = "已找到" if passed else "文件不存在或过小"
        elif kind == "html-self-contained":
            row = by_name.get(str(rule.get("file") or ""))
            if row:
                try:
                    text = storage.get(row.storage_key, row.backend).decode(
                        "utf-8", errors="replace")
                    external = re.search(
                        r'<(?:script|img|link|source)\b[^>]*(?:src|href)=["\']https?://',
                        text, re.I)
                    passed = "<html" in text.lower() and "</html>" in text.lower() and not external
                    detail = "HTML 自包含" if passed else "HTML 不完整或仍依赖外部资源"
                except Exception as exc:  # noqa: BLE001
                    detail = "文件读不出来（%s）" % type(exc).__name__
            else:
                detail = "没有这个 HTML 文件"
        results.append({"name": name, "ok": passed, "detail": detail})
        if not passed:
            raise ValueError(f"{name}：{detail}")
    return {"checks": results}
