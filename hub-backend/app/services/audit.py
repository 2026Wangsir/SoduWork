"""Administrative operation audit with scoped queries.

``add`` joins required history to a caller's transaction; ``log`` retains the
best-effort standalone behavior. Super administrators see all entries and
other administrators see actors in their department subtree.
"""
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models
from ..schemas import _ms
from . import rbac


def add(session: AsyncSession, actor, action: str, target_type: str = "",
        target_id: str | None = None, target_label: str = "", detail: dict | None = None):
    """Include required history in the caller's transaction without committing."""
    row = models.AuditLog(
        actor_id=getattr(actor, "id", None),
        actor_name=(getattr(actor, "display_name", "") or getattr(actor, "username", "")) if actor else "",
        actor_org_id=getattr(actor, "org_id", None),
        action=action, target_type=target_type, target_id=target_id,
        target_label=(target_label or "")[:200], detail=detail or {},
        at=datetime.now(timezone.utc),
    )
    session.add(row)
    return row


async def log(session: AsyncSession, actor, action: str, target_type: str = "",
              target_id: str | None = None, target_label: str = "", detail: dict | None = None) -> None:
    try:
        add(session, actor, action, target_type, target_id, target_label, detail)
        await session.commit()
    except Exception:
        await session.rollback()


def _to_api(a: models.AuditLog) -> dict:
    return {
        "id": a.id, "actorName": a.actor_name, "action": a.action,
        "targetType": a.target_type, "targetId": a.target_id, "targetLabel": a.target_label,
        "detail": a.detail or {}, "at": _ms(a.at),
    }


async def list_audit(session: AsyncSession, user, action: str | None = None,
                     limit: int = 50, offset: int = 0) -> dict:
    q = select(models.AuditLog)
    cnt = select(models.AuditLog.id)
    # Limit non-super administrators to actors in their department subtree.
    if not user.is_super:
        scope = await rbac.scope_org_ids(session, user)
        ids = scope or {"__none__"}
        q = q.where(models.AuditLog.actor_org_id.in_(ids))
        cnt = cnt.where(models.AuditLog.actor_org_id.in_(ids))
    if action:
        q = q.where(models.AuditLog.action == action)
        cnt = cnt.where(models.AuditLog.action == action)
    total = len(list((await session.execute(cnt)).all()))
    q = q.order_by(models.AuditLog.at.desc()).limit(limit).offset(offset)
    rows = (await session.execute(q)).scalars().all()
    return {"total": total, "items": [_to_api(a) for a in rows]}


async def list_plugin_activity(session: AsyncSession, user, binding_ids,
                               limit: int = 40, *, version_ids=None) -> dict:
    """Recent connector calls attributable to one enterprise plugin.

    MCP call logs contain no arguments or results. Workflow binding ids and
    installed immutable version ids preserve attribution for both entrypoints.
    """
    wanted = {str(item) for item in (binding_ids or []) if str(item)}
    versions = {str(item) for item in (version_ids or []) if str(item)}
    take = max(1, min(int(limit or 40), 100))
    scan_limit = 1000
    q = select(models.AuditLog).where(models.AuditLog.action.in_([
        "plugin.mcp_call", "plugin.mcp_failed",
    ]))
    if not user.is_super:
        scope = await rbac.scope_org_ids(session, user)
        q = q.where(models.AuditLog.actor_org_id.in_(scope or {"__none__"}))
    rows = list((await session.execute(
        q.order_by(models.AuditLog.at.desc()).limit(scan_limit)
    )).scalars().all())
    matched = [row for row in rows
               if wanted.intersection(str(item) for item in
                                      dict(row.detail or {}).get("bindingIds", []))
               or versions.intersection(str(item) for item in
                                        dict(row.detail or {}).get("versionIds", []))]
    success = sum(row.action == "plugin.mcp_call" for row in matched)
    failed = sum(row.action == "plugin.mcp_failed" for row in matched)
    durations = sorted(max(0, int(dict(row.detail or {}).get("durationMs") or 0))
                       for row in matched)
    median = durations[len(durations) // 2] if durations else None
    connectors = sorted({row.target_id or row.target_label for row in matched
                         if row.target_id or row.target_label})
    return {
        "total": len(matched), "sampled": len(rows) >= scan_limit,
        "summary": {"success": success, "failed": failed,
                    "successRate": round(success * 100 / len(matched), 1) if matched else None,
                    "medianDurationMs": median, "connectors": connectors[:20]},
        "items": [_to_api(row) for row in matched[:take]],
    }

async def list_plugin_governance_activity(
        session: AsyncSession, user, plugin_id: str, *, version_ids=None,
        binding_ids=None, run_ids=None, limit: int = 40) -> dict:
    """Recent lifecycle decisions for one plugin without exposing payloads.

    Audit rows use different stable targets as a plugin moves through import,
    evaluation, binding, rollout and execution.  This bounded read model joins
    those identities without creating a second source of truth.
    """
    plugin_id = str(plugin_id or "")
    versions = {str(item) for item in (version_ids or []) if str(item)}
    bindings = {str(item) for item in (binding_ids or []) if str(item)}
    runs = {str(item) for item in (run_ids or []) if str(item)}
    take = max(1, min(int(limit or 40), 100))
    scan_limit = 2000
    excluded = {"plugin.mcp_call", "plugin.mcp_failed"}
    q = select(models.AuditLog).where(
        models.AuditLog.action.like("plugin.%"),
        ~models.AuditLog.action.in_(excluded),
    )
    if not user.is_super:
        scope = await rbac.scope_org_ids(session, user)
        q = q.where(models.AuditLog.actor_org_id.in_(scope or {"__none__"}))
    rows = list((await session.execute(
        q.order_by(models.AuditLog.at.desc()).limit(scan_limit)
    )).scalars().all())

    def belongs(row) -> bool:
        detail = dict(row.detail or {})
        target_id = str(row.target_id or "")
        target_type = str(row.target_type or "")
        if target_type == "plugin" and target_id == plugin_id:
            return True
        if target_type == "plugin_version" and target_id in versions:
            return True
        if target_type == "plugin_binding" and target_id in bindings:
            return True
        if target_type == "workflow_run" and target_id in runs:
            return True
        if str(detail.get("pluginId") or "") == plugin_id:
            return True
        if plugin_id in {str(item) for item in detail.get("pluginIds") or []}:
            return True
        if str(detail.get("versionId") or "") in versions:
            return True
        if str(detail.get("targetVersionId") or "") in versions:
            return True
        if bindings.intersection(
                str(item) for item in detail.get("bindingIds") or []):
            return True
        return False

    matched = [row for row in rows if belongs(row)]
    return {
        "total": len(matched), "sampled": len(rows) >= scan_limit,
        "items": [_to_api(row) for row in matched[:take]],
    }
