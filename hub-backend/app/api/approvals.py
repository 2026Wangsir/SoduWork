"""Unified client approval inbox for requirements, outputs, UAT, and release decisions."""
from __future__ import annotations
import uuid

from fastapi import APIRouter, Body, Depends, File, HTTPException, UploadFile
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am
from ..config import get_settings
from ..db import get_session
from ..deps import current_client
from ..models import Attachment, Client, Role, Task, User
from ..schemas import attachment_to_api
from ..permissions import ALL_KEYS
from ..realtime import hub
from ..services import (approval_routing, code_delivery, deployments, release_control,
                        resource_access, storage, task_access, task_rework, task_trace)

router = APIRouter(prefix="/api/v1/approvals", tags=["approvals"])


async def _actor(session: AsyncSession, client: Client) -> User:
    if not client.user_ref:
        raise HTTPException(status_code=403, detail="这台 SoduWork 还没有绑定用户，不能处理审批")
    user = await session.get(User, client.user_ref)
    if user is None or not user.is_active:
        raise HTTPException(status_code=403, detail="SoduWork 绑定的用户不存在或已停用")
    if user.is_super:
        user._perms = set(ALL_KEYS)
    elif user.role_id:
        role = await session.get(Role, user.role_id)
        user._perms = set(role.permissions or []) if role else set()
    else:
        user._perms = set()
    return user


async def _item(session: AsyncSession, request: am.ApprovalRequest,
                task: Task, artifact: am.ArtifactVersion, user_id: str = "",
                my_decision: am.ApprovalDecision | None = None,
                *, decisions=None, assignment=None) -> dict:
    # List views supply prefetched decisions and assignments to avoid per-item queries.
    # Single-item detail views may query them directly when no prefetched values are supplied.
    if assignment is None and user_id:
        assignment = await approval_routing.assignment_for_user(session, request.id, user_id)
    if decisions is None:
        decisions = await release_control._decisions(session, request.id)
    return {
        **release_control.request_api(request, decisions),
        "task": {
            "id": task.id, "title": task.title, "note": task.note or "",
            "projectId": task.project_id or "", "repoId": task.repo_id or "",
            "priority": task.priority or "normal", "createdBy": task.created_by or "",
            "createdByName": task.created_by_name or "",
        },
        "artifact": release_control.artifact_api(artifact),
        "assignment": approval_routing.assignment_api(assignment),
        "myDecision": ({
            "id": my_decision.id, "decision": my_decision.decision,
            "note": my_decision.note, "userName": my_decision.user_name,
            "at": release_control._ms(my_decision.created_at),
            "gateSnapshot": resource_access.decorate(
                dict(getattr(my_decision, "gate_snapshot", None) or {})),
        } if my_decision else None),
    }


@router.get("")
async def inbox(view: str = "pending", limit: int = 60,
                client: Client = Depends(current_client),
                session: AsyncSession = Depends(get_session)):
    """Return this user's pending queue or their own immutable decision history."""
    user = await _actor(session, client)
    view = "done" if str(view).lower() == "done" else "pending"
    limit = min(100, max(1, int(limit or 60)))
    request_ids = set((await session.execute(select(am.ApprovalAssignment.request_id).where(
        am.ApprovalAssignment.user_id == user.id
    ))).scalars().all())
    pending_rows = list((await session.execute(select(am.ApprovalRequest).where(
        am.ApprovalRequest.status == "pending",
        am.ApprovalRequest.id.in_(request_ids or {"__none__"}),
        # A co-sign gate can remain pending after this person has voted. It is
        # waiting for the other reviewers, not a second decision from them.
        ~select(am.ApprovalDecision.id).where(
            am.ApprovalDecision.request_id == am.ApprovalRequest.id,
            am.ApprovalDecision.user_id == user.id,
        ).exists(),
    ).order_by(am.ApprovalRequest.created_at, am.ApprovalRequest.id))).scalars().all())
    pending_task_ids = {row.task_id for row in pending_rows}
    pending_tasks = {row.id: row for row in (await session.execute(select(Task).where(
        Task.id.in_(pending_task_ids or {"__none__"})
    ))).scalars().all()}
    pending = []
    for request in pending_rows:
        task = pending_tasks.get(request.task_id)
        if task is None:
            continue
        allowed, _ = await release_control.can_decide(session, task, request, user)
        if allowed:
            pending.append(request)
    done_count = int((await session.scalar(select(func.count(am.ApprovalDecision.id)).where(
        am.ApprovalDecision.user_id == user.id))) or 0)
    done_pairs = []
    if view == "done":
        done_pairs = list((await session.execute(
            select(am.ApprovalRequest, am.ApprovalDecision)
            .join(am.ApprovalDecision,
                  am.ApprovalDecision.request_id == am.ApprovalRequest.id)
            .where(am.ApprovalDecision.user_id == user.id)
            .order_by(am.ApprovalDecision.created_at.desc())
            .limit(limit)
        )).all())
    my_decisions = {request.id: decision for request, decision in done_pairs}
    rows = ([request for request, _ in done_pairs]
            if view == "done" else pending[:limit])
    task_ids = {row.task_id for row in rows}
    artifact_ids = {row.artifact_version_id for row in rows}
    tasks = {row.id: row for row in (await session.execute(select(Task).where(
        Task.id.in_(task_ids or {"__none__"})))).scalars().all()}
    artifacts = {row.id: row for row in (await session.execute(
        select(am.ArtifactVersion).where(
            am.ArtifactVersion.id.in_(artifact_ids or {"__none__"}))
    )).scalars().all()}
    # Prefetch decisions and assignments for all requests in the batch.
    # Avoid N+1 queries, especially when approvals use a remote database.
    row_ids = [r.id for r in rows]
    dec_bulk = await release_control.decisions_bulk(session, row_ids)
    asg_bulk = await approval_routing.assignments_for_user_bulk(session, row_ids, user.id)
    items = []
    for request in rows:
        task, artifact = tasks.get(request.task_id), artifacts.get(request.artifact_version_id)
        if task is None or artifact is None:
            continue
        items.append(await _item(
            session, request, task, artifact, user.id, my_decisions.get(request.id),
            decisions=dec_bulk.get(request.id, []), assignment=asg_bulk.get(request.id)))
    # Include approval gates on the user's tasks even when assigned to someone else.
    # Otherwise tasks waiting for confirmation appear to have no corresponding approval.
    # Expose the assignee, waiting time, and missing assignments so blocked work can be resolved.
    mine_waiting = []
    if view == "pending":
        my_rows = list((await session.execute(
            select(am.ApprovalRequest, Task)
            .join(Task, Task.id == am.ApprovalRequest.task_id)
            .where(am.ApprovalRequest.status == "pending",
                   task_access.owner_clause(client))
            .order_by(am.ApprovalRequest.created_at))).all())
        visible = {row.id for row in pending}
        hidden = [(request, task) for request, task in my_rows
                  if request.id not in visible]
        asg_names: dict[str, list] = {}
        for row in (await session.execute(select(am.ApprovalAssignment).where(
                am.ApprovalAssignment.request_id.in_(
                    [request.id for request, _ in hidden] or ["__none__"])
        ))).scalars().all():
            asg_names.setdefault(row.request_id, []).append(row.user_name)
        for request, task in hidden:
            mine_waiting.append({
                "id": request.id, "taskId": task.id,
                "taskTitle": task.title or "需求",
                "action": request.action,
                "createdAt": release_control._ms(request.created_at),
                "waitingOn": asg_names.get(request.id, []),
            })
    return {"items": items, "count": len(items), "view": view,
            "pendingCount": len(pending), "doneCount": done_count,
            # The requirement board needs the complete relationship, not just
            # the first page of detailed approval cards. Never include evidence.
            "pendingTasks": [{"taskId": row.task_id, "id": row.id,
                              "action": row.action, "artifactVersionId": row.artifact_version_id} for row in pending],
            "mineWaiting": mine_waiting}


@router.get("/{request_id}")
async def detail(request_id: str, client: Client = Depends(current_client),
                 session: AsyncSession = Depends(get_session)):
    user = await _actor(session, client)
    request = await session.get(am.ApprovalRequest, request_id)
    if request is None:
        raise HTTPException(status_code=404, detail="审批项不存在")
    task, artifact = await session.get(Task, request.task_id), await session.get(
        am.ArtifactVersion, request.artifact_version_id)
    if task is None or artifact is None:
        raise HTTPException(status_code=404, detail="审批对象已经不存在")
    my_decision = (await session.execute(select(am.ApprovalDecision).where(
        am.ApprovalDecision.request_id == request.id,
        am.ApprovalDecision.user_id == user.id,
    ).limit(1))).scalar_one_or_none()
    allowed, why = await release_control.can_decide(session, task, request, user)
    if not allowed and my_decision is None:
        # Return the actual access-denial reason and current approvers instead of a generic incomplete-load result.
        # ensure_assignments is idempotent; use existing assignments to explain who can act.
        names = [a.user_name for a in await approval_routing.ensure_assignments(
            session, task, request) if a.user_name]
        suffix = f"（当前验收人：{'、'.join(names)}）" if names else ""
        raise HTTPException(status_code=403, detail=f"{why}{suffix}")
    item = await _item(session, request, task, artifact, user.id, my_decision)



    if request.action == "uat" and request.environment_id:
        env = await session.get(am.Environment, request.environment_id)
        if env is not None:
            receipt = await deployments._receipt_context(session, task, artifact, env)
            if not receipt.get("runs"):
                # CI/CD receipts live in validate-node outputs rather than DeploymentRun records.
                node_run_id = str(dict(request.context or {}).get("nodeRunId") or "")
                node_run = await session.get(am.NodeRun, node_run_id) if node_run_id else None
                out = dict((node_run.output if node_run else {}) or {})
                if out.get("checks"):
                    receipt = {
                        "version": str(out.get("artifactSha") or out.get("mergedCommit") or "")[:12],
                        "runs": [{
                            "targetName": f"{out.get('customer') or 'CICD'} · {out.get('environment') or env.name}",
                            "state": "succeeded" if str(out.get("deployStatus") or "") == "SUCCESS" else str(out.get("deployStatus") or ""),
                            "commit": str(out.get("artifactSha") or "")[:12],
                            "finishedAt": None,
                            "checks": [{
                                "name": str(c.get("name") or "")[:100],
                                "ok": bool(c.get("ok")),
                                "detail": str(c.get("detail") or "")[:300],
                                "type": str(c.get("type") or "")[:24],
                            } for c in list(out.get("checks") or []) if isinstance(c, dict)][:16],
                        }],
                        "screenshots": [str(x) for x in list(out.get("screenshots") or []) if x][:6],
                    }
            shots = []
            for aid in list(receipt.get("screenshots") or []):
                att = await session.get(Attachment, aid)
                if att is None:
                    continue
                meta = dict(att.evidence_meta or {})
                shots.append({"id": aid,
                              "url": resource_access.attachment_url(aid),
                              "label": str(meta.get("label") or att.filename or "上线回执"),
                              "pageUrl": str(meta.get("url") or "")})
            item["context"] = {**dict(item.get("context") or {}), "receipt": receipt}
            item["receiptShots"] = shots
    trace = await task_trace.trace(session, task)
    gate = next((row.get("gate") for row in trace.get("approvals") or []
                 if str(row.get("id") or "") == request.id), None)
    frozen_gate = resource_access.decorate(
        dict(getattr(my_decision, "gate_snapshot", None) or {})) if my_decision else {}
    item["gate"] = frozen_gate if frozen_gate.get("schemaVersion") else gate
    item["gateIsSnapshot"] = bool(frozen_gate.get("schemaVersion"))
    return {
        "item": item,
        # The unified trace already includes release, deployment, workflow, evidence, and audit facts.
        # Return item and trace without first duplicating legacy detail queries.
        "trace": trace,
    }


@router.post("/{request_id}/evidence")
async def upload_evidence(request_id: str, file: UploadFile = File(...),
                          client: Client = Depends(current_client),
                          session: AsyncSession = Depends(get_session)):
    """Attach a screenshot to one immutable approval gate."""
    user = await _actor(session, client)
    request = await session.get(am.ApprovalRequest, request_id)
    if request is None:
        raise HTTPException(status_code=404, detail="\u5ba1\u6279\u9879\u4e0d\u5b58\u5728")
    if request.status != "pending":
        raise HTTPException(status_code=409, detail="\u8fd9\u9879\u5ba1\u6279\u5df2\u7ecf\u5904\u7406\u8fc7\u4e86")
    task = await session.get(Task, request.task_id)
    artifact = await session.get(am.ArtifactVersion, request.artifact_version_id)
    if task is None or artifact is None:
        raise HTTPException(status_code=404, detail="\u5ba1\u6279\u5bf9\u8c61\u5df2\u7ecf\u4e0d\u5b58\u5728")
    allowed, why = await release_control.can_decide(session, task, request, user)
    if not allowed:
        raise HTTPException(status_code=403, detail=why)
    data = await file.read()
    max_bytes = get_settings().attach_max_mb * 1024 * 1024
    if len(data) > max_bytes:
        raise HTTPException(status_code=413, detail="\u9a8c\u6536\u622a\u56fe\u8d85\u8fc7\u4e0a\u4f20\u4e0a\u9650")
    if not data:
        raise HTTPException(status_code=400, detail="\u8bf7\u9009\u62e9\u4e00\u5f20\u9a8c\u6536\u622a\u56fe")
    content_type = str(file.content_type or "").strip().lower()
    if not resource_access.is_inline_image(content_type):
        raise HTTPException(status_code=415, detail="\u9a8c\u6536\u8bc1\u636e\u8bf7\u4e0a\u4f20 PNG\u3001JPG \u6216 WebP \u56fe\u7247")
    from ..services import delivery_manifest
    image_ext = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp",
                 "image/gif": ".gif"}.get(content_type, "")
    proof = delivery_manifest.validate_bytes("evidence" + image_ext, data, content_type) \
        if image_ext else {"ok": False}
    if str(proof.get("state") or "") != "passed":
        raise HTTPException(status_code=415,
                            detail="\u9a8c\u6536\u8bc1\u636e\u4e0d\u662f\u6709\u6548\u7684\u56fe\u7247\u6587\u4ef6")
    name = (file.filename or "evidence.png").replace("/", "_").replace("\\", "_").strip()
    name = name[:200] or "evidence.png"
    evidence_id = str(uuid.uuid4())
    who = user.display_name or user.username or user.id
    row = Attachment(
        id=evidence_id, task_id=task.id, filename=name, content_type=content_type,
        size=len(data), uploaded_by="user:" + user.id, role="verification",
        source_ref=str(artifact.source_ref or ""),
        evidence_meta={"kind": "screenshot", "gateRequestId": request.id,
                       "verification": {"state": "passed", "by": who}},
    )
    row.storage_key = f"att/{task.id}/{evidence_id}/{name}"
    row.backend = storage.put(row.storage_key, data, content_type)
    session.add(row)
    await session.commit()
    await session.refresh(row)
    from ..services import gate_contract
    gate = await gate_contract.packet(session, task, request, artifact)
    return {"item": attachment_to_api(row), "gate": gate}


@router.post("/{request_id}/rework-materials")
async def upload_rework_material(request_id: str, file: UploadFile = File(...),
                                 client: Client = Depends(current_client),
                                 session: AsyncSession = Depends(get_session)):
    """Store rejection reference materials as rework_input, separate from deliverables and
    acceptance evidence. Only the assigned reviewer may upload them.
    """
    user = await _actor(session, client)
    request = await session.get(am.ApprovalRequest, request_id)
    if request is None:
        raise HTTPException(status_code=404, detail="审批项不存在")
    if request.status != "pending":
        raise HTTPException(status_code=409, detail="这项审批已经处理过了")
    if request.action != "review":
        raise HTTPException(status_code=409, detail="只有交付验收可以添加返修资料")
    task = await session.get(Task, request.task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="审批对象已经不存在")
    allowed, why = await release_control.can_decide(session, task, request, user)
    if not allowed:
        raise HTTPException(status_code=403, detail=why)
    data = await file.read()
    limit = get_settings().attach_max_mb * 1024 * 1024
    if not data:
        raise HTTPException(status_code=400, detail="请选择一份返修参考资料")
    if len(data) > limit:
        raise HTTPException(status_code=413, detail=f"文件超过 {get_settings().attach_max_mb}MB 上限")
    name = (file.filename or "rework-material").replace("/", "_").replace("\\", "_").strip()
    name = name[:200] or "rework-material"
    content_type = str(file.content_type or "application/octet-stream")[:120]
    attachment_id = str(uuid.uuid4())
    row = Attachment(
        id=attachment_id, task_id=task.id, filename=name, content_type=content_type,
        size=len(data), uploaded_by="user:" + user.id, role="rework_input",
        source_ref="approval-rework:" + request.id,
        evidence_meta={"kind": "rework_context", "approvalId": request.id,
                       "uploadedBy": user.display_name or user.username or user.id},
    )
    row.storage_key = f"att/{task.id}/{attachment_id}/{name}"
    row.backend = storage.put(row.storage_key, data, content_type)
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return {"ok": True, "attachment": attachment_to_api(row)}


def _decision_error(out: dict) -> HTTPException:
    reason = str(out.get("reason") or "")
    status = 403 if reason == "forbidden" else 409
    detail = {
        "stale": "审批对象已经产生新版本，请刷新后重新判断",
        "resolved": "这项审批已经处理过了",
        "duplicate": "你已经做过决定",
        "decision": "决定只能是 approve 或 reject",
        "note": "退回时请写清楚需要修改的地方",
        "gate_evidence": str(out.get("detail") or "\u8bf7\u5148\u8865\u9f50\u95e8\u7981\u8bc1\u636e"),
        "invalid_artifact": str(out.get("detail") or "\u5f53\u524d\u6210\u679c\u8fd8\u4e0d\u80fd\u9a8c\u6536"),
    }.get(reason, str(out.get("detail") or "审批没有生效"))
    return HTTPException(status_code=status, detail=detail)


async def _rework_note(session: AsyncSession, task: Task, request_id: str,
                       note: str, raw_ids) -> str:
    """Reference uploaded rework materials by stable attachment IDs in rework instructions."""
    ids = []
    for value in raw_ids if isinstance(raw_ids, list) else []:
        value = str(value or "").strip()
        if value and value not in ids:
            ids.append(value)
    if not ids:
        return note
    if len(ids) > 20:
        raise HTTPException(status_code=400, detail="返修资料最多添加 20 个文件")
    rows = list((await session.execute(select(Attachment).where(
        Attachment.task_id == task.id,
        Attachment.id.in_(ids),
        Attachment.role == "rework_input",
        Attachment.source_ref == "approval-rework:" + request_id,
    ))).scalars().all())
    by_id = {str(row.id): row for row in rows}
    if any(value not in by_id for value in ids):
        raise HTTPException(status_code=400, detail="返修资料已失效，请重新添加")
    lines = ["- " + str(by_id[value].filename or "返修资料")[:200] +
             "（附件 ID: " + value + "）" for value in ids]
    return (note[:1000] + "\n\n【返修参考资料】\n" + "\n".join(lines))[:1800]


@router.post("/{request_id}/decision")
async def decide(request_id: str, body: dict = Body(default_factory=dict),
                 client: Client = Depends(current_client),
                 session: AsyncSession = Depends(get_session)):
    user = await _actor(session, client)
    request = await session.get(am.ApprovalRequest, request_id)
    if request is None:
        raise HTTPException(status_code=404, detail="审批项不存在")
    task = await session.get(Task, request.task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="审批对象已经不存在")
    decision = str(body.get("decision") or "").strip().lower()
    note = str(body.get("note") or "").strip()
    if decision == "reject" and not note:
        raise HTTPException(status_code=400, detail="退回时请写清楚需要修改的地方")
    rework_note = await _rework_note(
        session, task, request.id, note,
        body.get("reworkAttachmentIds") if decision == "reject" else [],
    )
    out = await release_control.decide(
        session, task, user, action=request.action, decision=decision, note=rework_note,
        artifact_version_id=request.artifact_version_id,
        environment_id=request.environment_id,
    )
    if not out.get("ok"):
        raise _decision_error(out)

    rework = None
    if decision == "reject" and request.action == "review":
        # Ordinary rejection returns feedback to the executor without starting work.
        # rework=False returns the task to the backlog for manual reassignment.
        if body.get("rework") is False:
            rework = await task_rework.return_to_backlog(
                session, task, rework_note, request_id=request.id,
                actor=user.display_name or user.username)
        else:
            # Workflow tasks rewind through their graph; direct tasks wait for
            # the executor to explicitly continue from the rejected delivery.
            rework = await task_rework.resume_after_rejection(
                session, task, rework_note, artifact_version_id=request.artifact_version_id,
                request_id=request.id, actor=user.display_name or user.username,
                fallback_on_missing_ref=True, wait_for_executor=True)

    execution = None
    who = user.display_name or user.username
    # Direct AI tasks and plugin nodes share the idempotent rework service.
    if decision == "approve" and request.action == "merge":
        execution = await code_delivery.merge_approved(session, task, who=who)
    elif decision == "approve" and request.action == "deploy":
        execution = await deployments.request_environment(
            session, task, request.environment_id, who)
    elif decision == "approve" and request.action == "uat":
        execution = await deployments.continue_after_acceptance(
            session, task, request.environment_id, who)

    closed = False
    task_blocked = None
    if decision == "approve" and request.action == "review":
        # Direct AI work may complete after fixed-version acceptance; workflow and code tasks continue through their remaining gates.
        # Keep completion decisions in the shared completion gate, not duplicated API logic.
        # Report gate failures explicitly so accepted tasks cannot remain active without an explanation.
        from ..services import receipts, task_status
        before = task.status
        applied = await task_status.mark(session, task, "done", why="当前成果验收通过")
        closed = before != "done" and task.status == "done"
        if not applied and not closed and task.status != "done":
            from ..services import delivery_truth
            truth = await delivery_truth.evaluate(session, task)
            # Waiting for merge or release after acceptance is a valid intermediate state, not necessarily a blockage.
            task_blocked = delivery_truth.blocked_summary(task, truth.get("blockers"))
        if closed:
            await session.commit()
            await receipts.notify_on_close(session, task, task.owner_client_id)

    owner = await session.get(Client, task.owner_client_id) if task.owner_client_id else None
    if owner and task_access.is_owner(task, owner) and owner.id != client.id:
        verb = "批准" if decision == "approve" else "退回"
        if rework and rework.get("mode") == "backlog":
            suffix = "，已退回待开始，回需求池等人工重新安排"
        elif rework and rework.get("waitingForExecutor"):
            suffix = "，请在需求详情中继续修正"
        elif rework and rework.get("started"):
            suffix = "，已自动进入返修"
        elif rework and not rework.get("started") and rework.get("error"):
            suffix = f"；自动返修未启动（{rework.get('error')}），请重新发起执行"
        else:
            suffix = ""
        if task_blocked:
            suffix += ("；任务等待工作流推进" if task_blocked.get("awaitingWorkflow")
                       else "；任务暂未办结：") + task_blocked["reason"]
        await task_access.publish_owner(session, task, {
            "type": "notice", "taskId": task.id,
            "text": f"{who}{verb}了「{task.title}」的{request.action}环节{suffix}",
        })
    if execution is not None:
        artifact = await session.get(am.ArtifactVersion, request.artifact_version_id)
        if artifact is not None:
            out["artifact"] = release_control.artifact_api(artifact)
    from ..services import tasks as task_service
    await task_access.publish_task(session, task, "task.updated",
                                   await task_service.task_to_api_live(session, task))
    return {**out, "execution": execution, "rework": rework, "taskClosed": closed,
            "taskBlocked": task_blocked}


@router.post("/{request_id}/revoke")
async def revoke(request_id: str, body: dict = Body(default_factory=dict),
                 client: Client = Depends(current_client),
                 session: AsyncSession = Depends(get_session)):
    """Revoke an approval by creating a new review request while preserving history. Reject
    revocation after irreversible merge or release actions and require a forward fix.
    """
    user = await _actor(session, client)
    request = await session.get(am.ApprovalRequest, request_id)
    if request is None:
        raise HTTPException(status_code=404, detail="审批项不存在")
    task = await session.get(Task, request.task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="审批对象已经不存在")
    out = await release_control.revoke_approval(
        session, task, user, request_id, note=str(body.get("note") or ""))
    if not out.get("ok"):
        raise HTTPException(status_code=409, detail=out.get("error") or "撤回没有成功")
    who = user.display_name or user.username
    owner = await session.get(Client, task.owner_client_id) if task.owner_client_id else None
    if owner and task_access.is_owner(task, owner) and owner.id != client.id:
        await task_access.publish_owner(session, task, {
            "type": "notice", "taskId": task.id,
            "text": f"{who}撤回了「{task.title}」的{request.action}批准，这一环将重新走审",
        })
    from ..services import tasks as task_service
    await task_access.publish_task(session, task, "task.updated",
                                   await task_service.task_to_api_live(session, task))
    return out
