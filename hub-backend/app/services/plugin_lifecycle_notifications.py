"""Transactional plugin lifecycle notices in the existing account inbox.

The reserved conversation namespace carries only immutable routing context.
HTTP inbox reconciliation is authoritative; socket messages only reduce delay.
"""
import json
import logging
import re
import uuid

from sqlalchemy import or_, select, update

from .. import automation_models as am, models
from . import rbac
from .agent_messages import descriptor

PREFIX = "plugin-lifecycle:"


def context(row):
    value = str(row.conversation_id or "")
    if not value.startswith(PREFIX) or not str(row.client_message_id or "").startswith(PREFIX):
        return None
    try:
        parts = json.loads(value[len(PREFIX):])
    except (ValueError, TypeError):
        return None
    if (not isinstance(parts, list) or len(parts) != 4 or
            not all(isinstance(part, str) for part in parts) or
            parts[3] not in {"unpublished", "revoked"} or not parts[1]):
        return None
    return dict(zip(("orgId", "pluginId", "pluginVersionId", "pluginEvent"), parts))


def public_metadata(row):
    value = context(row)
    if value is None:
        return {}
    # Names and immutable version labels remain user content, never UI keys.
    if value["pluginEvent"] == "unpublished":
        match = re.fullmatch(r"「([\s\S]*)」已从企业市场下架。", row.text)
        key, params = "notification.plugin_unpublished", {"name": match[1]} if match else {}
    else:
        match = re.fullmatch(r"「([\s\S]*)」的 v([\s\S]*) 版本已撤销，无法继续使用。", row.text)
        key, params = "notification.plugin_version_revoked", {"name": match[1], "version": match[2]} if match else {}
    result = {"kind": "plugin_lifecycle", **{key: value[key] for key in
              ("pluginId", "pluginVersionId", "pluginEvent")}}
    if match:
        result["textMessage"] = descriptor(key, row.text, params=params)
    return result


async def _company_identity(session, org_id):
    """Snapshot the root, so moving a department cannot move old notices."""
    rows = (await session.execute(select(models.OrgUnit.id, models.OrgUnit.parent_id))).all()
    parents = {str(oid): str(parent or "") for oid, parent in rows}
    root, seen = str(org_id or ""), set()
    while root in parents and parents[root]:
        if root in seen:
            return "", set()
        seen.add(root)
        root = parents[root]
    if root not in parents:
        return "", set()
    return root, await rbac.company_org_ids_for_org(session, root, parents=parents)


async def inbox_visibility(session, user):
    """Ordinary coworker messages keep their existing account-only boundary."""
    if user.is_super:
        return None, ["*"]
    company, _ = await _company_identity(session, user.org_id)
    column = models.MateMessage.conversation_id
    prefixes = [PREFIX + json.dumps([org], separators=(",", ":"))[:-1] + ","
                for org in sorted({"", company})]
    return (or_(~column.startswith(PREFIX, autoescape=True),
                *(column.startswith(prefix, autoescape=True) for prefix in prefixes)), [company])


async def visible_to(session, user, row):
    if not str(row.conversation_id or "").startswith(PREFIX):
        return True
    if user is None or not user.is_active or user.account_deleted_at:
        return False
    value = context(row)
    if value is None:
        return False
    if not value["orgId"] or user.is_super:
        return True
    company, _ = await _company_identity(session, user.org_id)
    return value["orgId"] == company


async def lock_plugin(session, plugin):
    # A no-op write serializes lifecycle transitions on both PostgreSQL and
    # SQLite. SELECT FOR UPDATE alone would leave SQLite retries racing.
    await session.execute(update(am.Plugin).where(am.Plugin.id == plugin.id)
        .values(updated_at=am.Plugin.updated_at).execution_options(synchronize_session=False))
    await session.refresh(plugin)


async def create(session, plugin, actor, event, *, version=None):
    """Add one notice per affected account, without committing or publishing."""
    installation = select(am.PluginInstallation.user_id).where(
        am.PluginInstallation.plugin_id == plugin.id,
        am.PluginInstallation.enabled.is_(True))
    publisher_ids = {str(plugin.created_by or "")}
    if version is not None:
        installation = installation.where(am.PluginInstallation.version_id == version.id)
        publisher_ids.add(str(version.created_by or ""))
    else:
        publisher_ids.update(await session.scalars(select(am.PluginVersion.created_by).where(
            am.PluginVersion.plugin_id == plugin.id,
            am.PluginVersion.trust_state == "approved")))
    recipient_ids = publisher_ids | set(await session.scalars(installation))
    recipient_ids.discard("")
    if not recipient_ids:
        return []
    query = select(models.User).where(models.User.id.in_(recipient_ids),
        models.User.is_active.is_(True), models.User.account_deleted_at.is_(None))
    company = ""
    if plugin.org_id:
        company, scope = await _company_identity(session, plugin.org_id)
        query = query.where(models.User.org_id.in_(scope))
    recipients = list(await session.scalars(query))
    event_id = PREFIX + str(uuid.uuid4())
    routing = PREFIX + json.dumps([company, str(plugin.id),
        str(version.id if version else ""), event], separators=(",", ":"))
    if len(routing) > 180:
        raise ValueError("Plugin notification routing exceeds the inbox contract")
    text = (f"「{plugin.name}」已从企业市场下架。" if event == "unpublished" else
            f"「{plugin.name}」的 v{version.version} 版本已撤销，无法继续使用。")
    rows = [models.MateMessage(sender_id=actor.id, recipient_id=recipient.id,
        client_message_id=event_id, conversation_id=routing, text=text,
        status="accepted", attachments=[], website={}) for recipient in recipients]
    session.add_all(rows)
    await session.flush()
    return rows


async def publish(session, rows):
    """Only call after commit; missed delivery is repaired by the inbox sync."""
    try:
        await _publish(session, rows)
    except Exception as error:
        logging.getLogger("uvicorn.error").warning(
            "Plugin notices are saved; live notification is delayed: %s", type(error).__name__)


async def _publish(session, rows):
    from . import mate_messages, task_assignment
    from .client_domain_events import account_changed
    for row in rows:
        sender = await session.get(models.User, row.sender_id, populate_existing=True)
        recipient = await session.get(models.User, row.recipient_id, populate_existing=True)
        for uid in {row.sender_id, row.recipient_id}:
            await account_changed(session, uid, "team-messages")
        if not recipient or not recipient.is_active or not await visible_to(session, recipient, row):
            continue
        value = mate_messages.public(row, sender, recipient)
        event = {**value, "type": "notice", "serverMessageId": row.id,
                 "sentAt": value["createdAt"]}
        for device in await task_assignment.active_devices(session, recipient.id):
            await mate_messages.publish_event(device.id, event, user_id=recipient.id)
