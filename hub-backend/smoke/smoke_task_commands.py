# -*- coding: utf-8 -*-
"""Offline task command contracts: Hub is authoritative, client replay is idempotent, and deletion
is explicit. Use a temporary database without starting services or accessing development data.
"""
import asyncio
import os
import sys
from datetime import datetime, timezone

DB = os.path.abspath(".smoke-task-commands.db")
for suffix in ("", "-shm", "-wal"):
    try:
        os.remove(DB + suffix)
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
sys.path.insert(0, ".")

from sqlalchemy import func, select, text  # noqa: E402
from sqlalchemy.exc import IntegrityError  # noqa: E402
from fastapi import HTTPException  # noqa: E402

from app import automation_models as am  # noqa: E402
from app import models  # noqa: E402
from app.db import SessionLocal, init_db  # noqa: E402
from app.services import storage, tasks as task_service  # noqa: E402

passed = failed = 0


def check(name, condition, extra=""):
    global passed, failed
    if condition:
        passed += 1
        print("  PASS  " + name)
    else:
        failed += 1
        print("  FAIL  " + name + ("  << " + str(extra) if extra else ""))


async def child_counts(session, task_id):
    result = {}
    for key, model in (
        ("events", models.TaskEvent), ("comments", models.TaskComment),
        ("milestones", models.Milestone), ("attachments", models.Attachment),
        ("artifacts", am.ArtifactVersion), ("approvals", am.ApprovalRequest),
        ("deployments", am.DeploymentRun), ("workflows", am.WorkflowRun),
        ("evaluations", am.TaskEvaluation), ("evolution", am.EvolutionProposal),
        ("sessions", am.ExecutionSession),
    ):
        result[key] = (await session.execute(
            select(func.count()).select_from(model).where(model.task_id == task_id)
        )).scalar_one()
    ids = {
        "request": "approval-" + task_id,
        "run": "run-" + task_id,
        "session": "session-" + task_id,
    }
    for key, model, column, value in (
        ("assignments", am.ApprovalAssignment, am.ApprovalAssignment.request_id, ids["request"]),
        ("decisions", am.ApprovalDecision, am.ApprovalDecision.request_id, ids["request"]),
        ("nodes", am.NodeRun, am.NodeRun.run_id, ids["run"]),
        ("outbox", am.WorkflowOutbox, am.WorkflowOutbox.run_id, ids["run"]),
        ("workflow_events", am.WorkflowEvent, am.WorkflowEvent.run_id, ids["run"]),
        ("execution_events", am.ExecutionEvent, am.ExecutionEvent.session_id, ids["session"]),
    ):
        result[key] = (await session.execute(
            select(func.count()).select_from(model).where(column == value)
        )).scalar_one()
    return result


def seed_task_children(session, task_id):
    request_id, run_id, session_id = (
        "approval-" + task_id, "run-" + task_id, "session-" + task_id)
    artifact_id, evaluation_id = "artifact-" + task_id, "evaluation-" + task_id
    storage_key = "smoke/%s/a.md" % task_id
    storage.put(storage_key, b"evidence", "text/markdown")
    session.add_all([
        models.TaskEvent(task_id=task_id, kind="test", detail={}),
        models.TaskComment(task_id=task_id, body="comment"),
        models.Milestone(task_id=task_id, title="一步", status="todo"),
        models.Attachment(task_id=task_id, filename="a.md", storage_key=storage_key,
                          backend="local", size=8),
        am.ArtifactVersion(id=artifact_id, task_id=task_id, checksum="a" * 64),
        am.ApprovalRequest(id=request_id, task_id=task_id,
                           artifact_version_id=artifact_id, action="review"),
        am.ApprovalAssignment(request_id=request_id, user_id="user-a"),
        am.ApprovalDecision(request_id=request_id, user_id="user-a", decision="approve"),
        am.DeploymentRun(task_id=task_id, artifact_version_id=artifact_id,
                         environment_id="env-a", target_id="target-a",
                         idempotency_key="deploy-" + task_id),
        am.WorkflowRun(id=run_id, task_id=task_id, plugin_id="plugin",
                       plugin_version_id="v1", binding_id="binding"),
        am.NodeRun(run_id=run_id, node_key="work", node_type="ai",
                   idempotency_key="node-" + task_id),
        am.WorkflowOutbox(run_id=run_id, topic="dispatch"),
        am.WorkflowEvent(run_id=run_id, kind="started"),
        am.TaskEvaluation(id=evaluation_id, task_id=task_id, evaluator_id="user-a"),
        am.EvolutionProposal(task_id=task_id, evaluation_id=evaluation_id),
        am.ExecutionSession(id=session_id, task_id=task_id, ref="ref-" + task_id),
        am.ExecutionEvent(session_id=session_id, seq=1, text="done"),
    ])
    return storage_key


async def main():
    await init_db()
    async with SessionLocal() as session:
        session.add_all([
            models.Client(id="client-a", name="A"),
            models.Client(id="client-b", name="B"),
            models.Project(id="project-x", name="Synthetic public project", org_id=None),
        ])
        await session.commit()

        # Retrying PUT with the same client-generated ID updates fields without creating duplicates.
        first = await task_service.put_local_task(
            session, "client-a", "task-offline-1",
            {"title": "离线创建", "status": "todo", "tags": ["离线"]},
        )
        second = await task_service.put_local_task(
            session, "client-a", "task-offline-1",
            {"title": "重放后更新", "status": "doing", "tags": ["离线", "重放"]},
        )
        rows = (await session.execute(
            select(models.Task).where(models.Task.id == "task-offline-1")
        )).scalars().all()
        check("同一客户端 id 重放后仍只有一条任务", len(rows) == 1, len(rows))
        check("重放收敛为最新字段", second and second["title"] == "重放后更新"
              and second["status"] == "doing", second)
        check("首次和重放返回同一个任务 id", first and first["id"] == second["id"])

        # Preserve non-primary-key database errors instead of reporting an occupied task ID.
        await session.execute(text(
            "CREATE TRIGGER reject_test_task BEFORE INSERT ON task "
            "WHEN NEW.id = 'task-constraint-error' "
            "BEGIN SELECT RAISE(ABORT, 'forced task constraint'); END"))
        await session.commit()
        propagated = False
        try:
            await task_service.put_local_task(
                session, "client-a", "task-constraint-error", {"title": "constraint"})
        except IntegrityError:
            propagated = True
        check("非编号约束错误不会被伪装成编号冲突", propagated)
        await session.execute(text("DROP TRIGGER reject_test_task"))
        await session.commit()
        # Definition editing remains supported before execution begins.
        draft = await task_service.put_local_task(session, "client-a", "task-draft", {"title": "未执行需求"})
        selected = await task_service.update_task(session, "client-a", "task-draft",
            {"due": 1893456000000, "projectId": "project-x", "requirementVersion": draft["requirementVersion"]})
        check("Project selection persists before clearing", selected["projectId"] == "project-x", selected)
        cleared = await task_service.update_task(session, "client-a", "task-draft",
            {"due": None, "projectId": None, "requirementVersion": selected["requirementVersion"]})
        check("显式 null 能清空日期和项目归属",
              cleared["due"] is None and cleared["projectId"] is None, cleared)

        # A single-task write must preserve unrelated server-created tasks.
        server_task = models.Task(id="task-server", owner_client_id="client-a",
                                  title="服务端派发", status="todo")
        session.add(server_task)
        await session.commit()
        await task_service.update_task(session, "client-a", "task-draft", {"note": "只改这一条"})
        check("单任务更新不会误删服务端其他任务",
              await session.get(models.Task, "task-server") is not None)

        # An ID cannot be claimed across devices or convert an aggregate task into a local task.
        conflict = await task_service.put_local_task(
            session, "client-b", "task-offline-1", {"title": "抢占"})
        check("其他 SoduWork 不能抢占同一任务 id", conflict is None, conflict)
        external = models.Task(id="task-external", owner_client_id="client-a",
                               title="GitLab 工单", origin="gitlab")
        session.add(external)
        await session.commit()
        external_put = await task_service.put_local_task(
            session, "client-a", "task-external", {"title": "覆盖来源"})
        check("幂等创建不能覆盖聚合来源任务", external_put is None, external_put)

        # Ordinary PATCH requests cannot override server-owned workflow status.
        running = models.Task(id="task-running", owner_client_id="client-a",
                              title="流程任务", status="doing")
        session.add(running)
        session.add(am.WorkflowRun(id="run-1", task_id="task-running", plugin_id="plugin",
                                   plugin_version_id="v1", binding_id="binding", state="running"))
        await session.commit()
        frozen = False
        try:
            await task_service.update_task(
                session, "client-a", "task-running", {"status": "done", "title": "不应改动"})
        except HTTPException as exc:
            frozen = exc.status_code == 409
        running = await session.get(models.Task, "task-running")
        check("执行中定义与混合状态命令不能覆盖原需求",
              frozen and running.title == "流程任务" and running.status == "doing")
        await session.rollback()
        changed = await task_service.update_task(session, "client-a", "task-running", {"status": "done"})
        check("引擎执行中状态仍由服务端控制", changed["status"] == "doing", changed)
        check("状态命令保留原需求定义", changed["title"] == "流程任务", changed)

        # Explicit deletion removes the complete task aggregate and physical attachments.
        storage_key = seed_task_children(session, "task-offline-1")
        await session.commit()
        before = await child_counts(session, "task-offline-1")
        blocked = None
        try:
            await task_service.delete_task(session, "client-a", "task-offline-1")
        except HTTPException as exc:
            blocked = exc
        check("未结束的执行证据阻止显式删除",
              blocked is not None and blocked.status_code == 409, blocked)
        check("拒绝删除保留完整证据与物理附件",
              await child_counts(session, "task-offline-1") == before
              and storage.get(storage_key, "local") == b"evidence")

        # The cascade fixture represents retained history only after the
        # workflow and its execution session have authoritative terminal states.
        workflow = await session.get(am.WorkflowRun, "run-task-offline-1")
        execution = await session.get(am.ExecutionSession, "session-task-offline-1")
        workflow.state, execution.state = "succeeded", "done"
        completed = await session.get(models.Task, "task-offline-1")
        completed.status, completed.reviewed_at = "done", datetime.now(timezone.utc)
        approval = await session.get(am.ApprovalRequest, "approval-task-offline-1")
        approval.status = "approved"
        await session.commit()
        deleted = await task_service.delete_task(session, "client-a", "task-offline-1")
        after = await child_counts(session, "task-offline-1")
        expected_children = {key: 1 for key in before}
        expected_children["events"] = 2  # The manual start also retained its execution audit event.
        check("显式删除前证据挂件存在", before == expected_children, before)
        check("显式删除任务成功", deleted.get("ok") is True, deleted)
        check("显式删除级联清理挂件", all(value == 0 for value in after.values()), after)
        physical_gone = False
        try:
            storage.get(storage_key, "local")
        except FileNotFoundError:
            physical_gone = True
        check("显式删除同时清理物理附件", physical_gone)
        check("未被点名的服务端任务仍然存在",
              await session.get(models.Task, "task-server") is not None)

        done = models.Task(id="task-done", owner_client_id="client-a",
                           title="待批量清理", status="done", reviewed_at=datetime.now(timezone.utc))
        session.add(done)
        session.add(models.TaskEvent(task_id="task-done", kind="test", detail={}))
        await session.commit()
        cleaned = await task_service.clear_done(session, "client-a")
        done_children = await child_counts(session, "task-done")
        check("清理已完成任务也走同一级联删除口径",
              cleaned["removed"] == 1 and all(value == 0 for value in done_children.values()),
              (cleaned, done_children))

    root = os.path.dirname(os.path.dirname(__file__))
    with open(os.path.join(root, "app", "api", "tasks.py"), encoding="utf-8") as handle:
        api_source = handle.read()
    with open(os.path.join(root, "..", "client", "api.js"), encoding="utf-8") as handle:
        client_api = handle.read()
    with open(os.path.join(root, "..", "client", "core", "store.js"), encoding="utf-8") as handle:
        store_source = handle.read()
    check("服务端已退役整表同步路由", '"/tasks/sync"' not in api_source)
    check("客户端已退役 syncTasks", "syncTasks(tasks)" not in client_api)
    check("离线操作队列按账号作用域持久化",
          "_taskStorageKey('ops','soduwork_work_task_ops_v1')" in store_source
          and "localStorage.setItem(LS_TASK_OPS(),JSON.stringify(rows||[]))" in store_source)
    check("删除由携带最新 Hub 快照的显式 removeTask 命令触发",
          "removeTask(id,delay,latest)" in store_source)

    print("\ntask commands smoke: %d passed, %d failed" % (passed, failed))
    return 1 if failed else 0


sys.exit(asyncio.run(main()))
