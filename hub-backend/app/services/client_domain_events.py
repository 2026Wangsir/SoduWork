"""Post-commit invalidation hints; existing HTTP responses remain authoritative."""
import asyncio
import logging
from collections import OrderedDict
from sqlalchemy import or_, select
from ..db import SessionLocal
from ..models import Client
from . import native_discovery

log = logging.getLogger("uvicorn.error")
TOPICS = frozenset({"conversation-projects", "models", "config", "team-messages", "quota"})
MAX_PENDING = 4096
MAX_TARGETS = 10000
MAX_CONCURRENT = 32
SEND_TIMEOUT = 3
_pending = OrderedDict()
_dropped = 0
_worker = None
_signal = None
_active = False


async def account_changed(session, owner, topic):
    if owner:
        _queue(topic, str(owner), "")


async def device_changed(client, topic):
    if client.user_ref:
        _queue(topic, str(client.user_ref), str(client.id))


async def models_changed(session):
    """Organization catalog changes affect every active device's usable metadata."""
    _queue("models", "", "")


async def quota_changed(session, owner="", *, plan_ids=(), default_changed=False):
    """Queue post-commit refresh hints without exposing allowances or granting access."""
    try:
        if owner:
            await account_changed(session, owner, "quota")
            return
        if not plan_ids and not default_changed:
            return
        from sqlalchemy.orm import aliased
        from ..models import AppSetting
        from . import client_access, quota_plans
        grant, override = aliased(AppSetting), aliased(AppSetting)
        query = (select(Client.user_ref, grant.value, override.value)
                 .outerjoin(grant, grant.key == quota_plans.GRANT_PREFIX + Client.user_ref)
                 .outerjoin(override, override.key == client_access.USER_QUOTA_PREFIX + Client.user_ref)
                 .where(Client.auth_state == "active", Client.user_ref.is_not(None))
                 .distinct().order_by(Client.user_ref).limit(MAX_TARGETS + 1))
        rows = (await session.execute(query)).all()
        if len(rows) > MAX_TARGETS:
            log.warning("Quota invalidation fanout capped; remaining accounts use reconciliation")
        for uid, raw_grant, raw_override in rows[:MAX_TARGETS]:
            try:
                assigned = quota_plans.parse(raw_grant)
                named = assigned.get("mode") == "plan" and assigned.get("planId") in plan_ids
                inherited = (not assigned or assigned.get("mode") == "inherit") and default_changed
                if inherited:
                    inherited = client_access.user_quota(quota_plans.parse(raw_override))["mode"] == "inherit"
                if named or inherited:
                    _queue("quota", str(uid), "")
            except (ValueError, TypeError, KeyError):
                # Invalid policies remain unavailable; a hint cannot repair them.
                continue
    except Exception as error:
        # A failed hint must not turn an already committed admin edit into a retry.
        log.warning("Quota invalidation delayed: %s", type(error).__name__)


def _queue(topic, owner, device):
    global _dropped
    if topic not in TOPICS or (topic, "", "") in _pending or (topic, owner, device) in _pending:
        return
    if not owner:
        for item in list(_pending):
            if item[0] == topic:
                _pending.pop(item)
    if len(_pending) >= MAX_PENDING:
        _pending.popitem(last=False)
        _dropped += 1
        if _dropped & (_dropped - 1) == 0:
            log.warning("Client invalidation queue full; reconciliation will repair %d hints", _dropped)
    _pending[(topic, owner, device)] = None
    if _signal is not None:
        _signal.set()


async def _deliver(batch, sessions=None):
    try:
        global_topics = {topic for topic, owner, device in batch if not owner}
        owners = {owner for _, owner, device in batch if owner and not device}
        devices = {device for _, _, device in batch if device}
        query = select(Client.id, Client.user_ref).where(Client.auth_state == "active", Client.user_ref.is_not(None))
        if not global_topics:
            query = query.where(or_(Client.user_ref.in_(owners), Client.id.in_(devices)))
        async with (sessions or SessionLocal)() as read:
            rows = (await read.execute(query.limit(MAX_TARGETS + 1))).all()
        if len(rows) > MAX_TARGETS:
            log.warning("Client invalidation fanout capped; remaining devices use reconciliation")
            rows = rows[:MAX_TARGETS]
        # The database connection is released before any socket/broker await.
        targets = {(str(device), str(owner), topic) for device, owner in rows for topic in TOPICS
                   if topic in global_topics or (topic, str(owner), "") in batch or
                   (topic, str(owner), str(device)) in batch}
        values = list(targets)
        for start in range(0, len(values), MAX_CONCURRENT):
            await asyncio.gather(*(asyncio.wait_for(native_discovery.wake(device, owner, topic), SEND_TIMEOUT)
                                  for device, owner, topic in values[start:start + MAX_CONCURRENT]), return_exceptions=True)
    except Exception as error:
        # The bounded reconciliation remains authoritative after broker loss.
        log.warning("Client cache invalidation delayed: %s", type(error).__name__)


async def _drain(sessions=None):
    global _active
    if _active or not _pending:
        return
    batch = set(_pending)
    _pending.clear()
    _active = True
    try:
        await _deliver(batch, sessions)
    finally:
        _active = False


async def _run():
    while True:
        await _signal.wait()
        _signal.clear()
        await asyncio.sleep(0.05)
        await _drain()
        if _pending:
            _signal.set()


def start():
    global _worker, _signal
    if _worker is None or _worker.done():
        _signal = asyncio.Event()
        if _pending:
            _signal.set()
        _worker = asyncio.create_task(_run(), name="client-domain-invalidation")


async def stop():
    global _worker, _signal
    if _worker is not None:
        _worker.cancel()
        await asyncio.gather(_worker, return_exceptions=True)
    _worker = None
    _signal = None
    _pending.clear()


async def flush_for_test(sessions=None):
    while _pending or _active:
        if _active:
            await asyncio.sleep(0)
        else:
            await _drain(sessions)
