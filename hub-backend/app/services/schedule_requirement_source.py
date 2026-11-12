"""Authorized requirement provenance and retry identity for independent drafts."""
import hashlib
import json
import re
from uuid import NAMESPACE_URL, uuid5

from fastapi import HTTPException
from sqlalchemy import select

from .. import models
from . import schedule_access, task_requirements


def request_identity(body, client):
    source = body.get("sourceRequirement")
    if source is None:
        return None
    if (not isinstance(source, dict) or set(source) != {"id", "requirementVersion"}
            or not isinstance(source["id"], str) or not source["id"] or len(source["id"]) > 64
            or type(source["requirementVersion"]) is not int or source["requirementVersion"] < 1):
        raise HTTPException(400, "来源需求格式无效，请重新打开需求")
    key = body.get("creationRequestId")
    if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,160}", key):
        raise HTTPException(400, "缺少有效的草稿创建标识，请重新打开需求")
    identity = json.dumps([client.id, client.user_ref or "", key], ensure_ascii=True)
    sid = str(uuid5(NAMESPACE_URL, "soduwork:requirement-automation:" + identity))
    # Only a digest is persisted. Unknown request data never becomes provenance.
    payload = {**body, "enabled": False}
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=True,
                                      separators=(",", ":")).encode()).hexdigest()
    return sid, digest


def public(source):
    value = source if isinstance(source, dict) else {}
    return {key: value[key] for key in ("id", "title", "requirementVersion") if key in value}


async def replay(session, identity, client):
    if identity is None:
        return None
    schedule = await session.get(models.AiSchedule, identity[0])
    if schedule is None:
        return None
    if (not schedule_access.is_owner(schedule, client)
            or (schedule.source_requirement or {}).get("_requestHash") != identity[1]):
        raise HTTPException(409, "该草稿创建请求已使用，请到自动化管理中查看原结果")
    return schedule


async def snapshot(session, source, client, *, lock=False):
    if lock and session.bind.dialect.name == "sqlite":
        # SQLite's legacy driver does not BEGIN on SELECT. Acquire its write
        # reservation before reading the source, so archive/edit cannot race creation.
        connection = await session.connection()
        raw = await connection.get_raw_connection()
        if not raw.driver_connection.in_transaction:
            await connection.exec_driver_sql("BEGIN IMMEDIATE")
    query = select(models.Task).where(models.Task.id == source["id"])
    if lock:
        query = query.with_for_update()
    task = (await session.execute(query.execution_options(populate_existing=True))).scalar_one_or_none()
    if task is None or not await task_requirements.can_manage(session, client, task):
        raise HTTPException(404, "无法管理此来源需求")
    if task.archived_at:
        raise HTTPException(409, "请先恢复已归档的需求，再创建自动化草稿")
    version = int(task.requirement_version or 1)
    if source["requirementVersion"] != version:
        raise HTTPException(409, "来源需求已更新，请重新打开需求后创建草稿")
    return {"id": task.id, "title": str(task_requirements.public_content(task)["title"] or ""),
            "requirementVersion": version}
