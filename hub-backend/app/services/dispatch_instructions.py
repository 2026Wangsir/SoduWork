"""Immutable, explicit dispatch notes; never infer them from prompts or routing."""
from fastapi import HTTPException
from sqlalchemy import select
from ..models import TaskEvent
from . import task_events

KIND = "execution.instructions"


def confirmed_turn(task, claimed) -> dict:
    """Correlate a Runner receipt only with the currently admitted queue head."""
    current = (task.work_routing or {}).get("conversationTurn") or {}
    if (not isinstance(claimed, dict) or current.get("executor") != "dispatch"
            or current.get("state") != "running"):
        return {}
    keys = ("conversationId", "turnId")
    if any(not isinstance(current.get(key), str) or not current[key]
           or current[key] != claimed.get(key) for key in keys):
        return {}
    return {key: current[key] for key in keys}


def submitted(body: dict, effective_mode: str) -> dict | None:
    if "dispatchInstructions" not in body:
        return None
    value = body["dispatchInstructions"]
    if (not isinstance(value, dict) or not isinstance(value.get("note"), str)
            or len(value["note"]) > 2000
            or not isinstance(value.get("submissionMode"), str)
            or value.get("submissionMode") not in {"default", "manual", "auto"}):
        raise HTTPException(422, "派发说明格式无效，补充内容不能超过 2000 字符")
    selected = value["submissionMode"]
    if selected != "default" and selected != effective_mode:
        raise HTTPException(422, "派发说明的提交方式与本次执行不一致")
    return {"schemaVersion": 1, "note": value["note"], "submissionMode": selected,
            "effectiveSubmissionMode": effective_mode}


async def preserve_retry(session, task_id: str, current: dict, snapshot: dict | None):
    """Reject changed metadata without backfilling unknown historical requests."""
    if snapshot is None:
        return
    events = (await session.scalars(select(TaskEvent).where(
        TaskEvent.task_id == task_id, TaskEvent.kind == KIND))).all()
    for event in events:
        detail = event.detail or {}
        if (detail.get("conversationId") == current.get("conversationId")
                and detail.get("turnId") == current.get("turnId")):
            if any(detail.get(key) != value for key, value in snapshot.items()):
                raise HTTPException(409, "本次派发说明已保存，不能通过重试覆盖")
            return


def record(session, task_id: str, snapshot: dict | None, scope: dict, actor: str):
    if snapshot is None:
        return
    task_events.record(session, task_id, KIND, {**snapshot,
        **{key: scope[key] for key in ("conversationId", "turnId", "executor")}}, actor)
