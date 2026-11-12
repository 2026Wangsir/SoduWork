"""Loopback-only summary export fixture using production device authentication and routers."""
import hashlib
import importlib
import os
import secrets
import tempfile
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

root = Path(os.environ["SODUWORK_COLLAB_E2E_ROOT"]).resolve()
if root.parent != Path(tempfile.gettempdir()).resolve() or not root.name.startswith("soduwork-collab-e2e-"):
    raise RuntimeError("An isolated temporary directory is required")
os.environ["SODUWORK_DATA_ROOT"] = str(root / "hub-data")
os.environ["SKIN_DATA_ROOT"] = str(root / "skin-data")
os.environ["CLUSTER_REDIS_URL"] = ""
os.environ["SODUWORK_ENV"] = "development"
os.environ["DEVICE_AUTH_COMPAT"] = "0"
os.environ["AUTH_SECRET"] = secrets.token_hex(32)
os.environ["ADMIN_PASS"] = secrets.token_urlsafe(32)

from fastapi import Body, HTTPException, Request
from fastapi.responses import JSONResponse
from sqlalchemy import func, select

from tests import collaboration_browser_server as fixture
from app import automation_models as am, db, models
from app.api import approvals, delivery, tasks, trace
from app.deps import current_client
from app.services import device_auth

for model_file in (Path(__file__).resolve().parents[1] / "app").glob("*models.py"):
    importlib.import_module("app." + model_file.stem)

app = fixture.app
app.dependency_overrides.pop(current_client, None)
for router in (tasks.router, approvals.router, delivery.router, trace.router):
    app.include_router(router)

TASKS = {"awaiting": "summary-awaiting", "approved": "summary-approved",
         "requirementOnly": "summary-shared", "revised": "summary-revised", "empty": "summary-empty"}
IDENTITIES = {"owner": "e2e-sender", "viewer": "e2e-recipient", "stranger": "e2e-other"}
base_lifespan = app.router.lifespan_context


async def _delivery(session, task, version, *, approved=False, historical=False):
    """Seed recorded facts, never dispatch a model or change real project data."""
    now = datetime.now(timezone.utc) - timedelta(minutes=2)
    aid = task.id + "-file-" + str(version)
    artifact_id = task.id + "-v" + str(version)
    approval_id = task.id + "-review-" + str(version)
    source = task.id + "-execution-" + str(version)
    content = ("HISTORICAL_DELIVERY" if historical else "Synthetic delivery version " + str(version)).encode()
    name = "historical.md" if historical else "delivery-v" + str(version) + ".md"
    storage_key = "summary-fixture/" + aid + ".md"
    digest = hashlib.sha256(content).hexdigest()
    session.add(models.Attachment(id=aid, task_id=task.id, filename=name, role="output",
        uploaded_by="e2e-sender", content_type="text/markdown", size=len(content),
        storage_key=storage_key, backend=fixture.storage.put(storage_key, content, "text/markdown"),
        source_ref=source, evidence_meta={"sha256": digest, "verification": {"state": "passed"}}))
    session.add(am.ArtifactVersion(id=artifact_id, task_id=task.id, seq=version, kind="files",
        source_ref=source, checksum=digest, state="approved" if approved else "candidate", created_at=now,
        manifest={"schemaVersion": "soduwork.delivery/1", "complete": True, "problems": [],
                  "primary": [{"id": aid, "name": name, "sha256": digest,
                               "validation": {"state": "passed", "reason": "Synthetic recorded file check"}}],
                  "supporting": [], "runtimeConfig": "PRIVATE_RUNTIME_CONFIG"}))
    session.add(am.ApprovalRequest(id=approval_id, task_id=task.id, artifact_version_id=artifact_id,
        action="review", status="approved" if approved else "pending", required_count=1,
        created_at=now, resolved_at=now + timedelta(seconds=30) if approved else None,
        context={"gate": {"criteria": [{"id": "criterion-1", "label": "Fixed delivery criterion"}]},
                 "aiAcceptanceReports": {"sender": {"artifactVersionId": artifact_id,
                    "requirementVersion": int(task.requirement_version or 1),
                    "execution": {"agent": "Synthetic acceptance agent", "conversationId": "PRIVATE_CONVERSATION"},
                    "report": {"checks": [{"label": "Recorded synthetic check", "result": "pass",
                                           "evidence": "Synthetic validation evidence"}]}}} if approved else {}}))
    session.add(am.ApprovalAssignment(request_id=approval_id, user_id="sender", user_name="Synthetic owner"))
    if approved:
        session.add(am.ApprovalDecision(request_id=approval_id, user_id="sender", user_name="Synthetic reviewer",
            decision="approve", note="HISTORICAL_APPROVAL" if historical else "Accepted this fixed synthetic delivery",
            created_at=now + timedelta(seconds=30), gate_snapshot={"subject": {"artifactVersionId": artifact_id},
                "evidence": [{"kind": "check", "title": "Recorded gate check", "summary": "Recorded gate evidence",
                              "verification": {"state": "passed"}}]}))
    session.add(am.ExecutionSession(task_id=task.id, ref=source, state="done", engine="synthetic-agent",
        model="synthetic-model", finished_at=now - timedelta(seconds=1), updated_at=now - timedelta(seconds=1),
        metadata_={"executionIdentity": {"agentSessionId": "synthetic-session", "agentName": "Synthetic delivery agent"},
                   "privateConfig": "PRIVATE_EXECUTION_CONFIG"}))
    return artifact_id


@asynccontextmanager
async def lifespan(application):
    async with base_lifespan(application):
        async with fixture.sessions() as session:
            session.add(models.OrgUnit(id="summary-outside", name="Synthetic outside organization"))
            stranger = await session.get(models.User, "other")
            stranger.org_id = "summary-outside"
            for key, tid in TASKS.items():
                approved = key in {"approved", "requirementOnly"}
                task = models.Task(id=tid, title="PRIVATE_EXECUTION_TITLE", note="PRIVATE_EXECUTION_NOTE",
                    requirement_content={"title": "验收摘要示例 · " + key, "note": "合成需求说明，仅用于隔离验收。"},
                    created_by="sender", assignee_user_id="sender", owner_client_id="e2e-sender", owner_user_id="sender",
                    shared_org_id="e2e-org", status="done" if approved else "doing", triage_stage="ready",
                    requirement_version=3 if key == "revised" else 1,
                    acceptance_criteria=["当前需求标准"], work_routing={"privateConfig": "PRIVATE_TASK_CONFIG"})
                session.add(task)
                if key == "empty":
                    continue
                if key == "revised":
                    await _delivery(session, task, 1, approved=True, historical=True)
                    await _delivery(session, task, 2)
                else:
                    await _delivery(session, task, 1, approved=approved)
                if approved:
                    task.reviewed_at = datetime.now(timezone.utc) - timedelta(minutes=1)
                    task.reviewed_by = "sender"
                    task.reviewed_by_name = "Synthetic reviewer"
            await session.commit()
        try:
            yield
        finally:
            await db.engine.dispose()


app.router.lifespan_context = lifespan


@app.middleware("http")
async def loopback_only(request: Request, call_next):
    if request.client is None or request.client.host not in {"127.0.0.1", "::1"}:
        return JSONResponse({"detail": "This isolated fixture is loopback-only"}, status_code=403)
    return await call_next(request)


async def _task_info(session, task):
    artifact = await session.scalar(select(am.ArtifactVersion).where(
        am.ArtifactVersion.task_id == task.id).order_by(am.ArtifactVersion.seq.desc()).limit(1))
    return {"id": task.id, "requirementVersion": int(task.requirement_version or 1),
            "artifactVersionId": artifact.id if artifact else None}


@app.get("/e2e/summary-bootstrap")
async def bootstrap():
    async with fixture.sessions() as session:
        identities = {}
        for name, client_id in IDENTITIES.items():
            client = await session.get(models.Client, client_id)
            token, ttl = device_auth.issue_session(client)
            identities[name] = {"clientId": client.id, "userId": client.user_ref,
                                "session": token, "expiresIn": ttl}
        values = {name: await _task_info(session, await session.get(models.Task, tid))
                  for name, tid in TASKS.items()}
        return {"isolated": True, "identities": identities, "tasks": values}


@app.post("/e2e/summary-revise")
async def revise(body: dict = Body(default_factory=dict)):
    tid = str(body.get("taskId") or TASKS["revised"])
    if tid not in TASKS.values():
        raise HTTPException(404, "Unknown synthetic task")
    async with fixture.sessions() as session:
        task = await session.get(models.Task, tid)
        if not body.get("keepRequirementVersion"):
            task.requirement_version = int(task.requirement_version or 1) + 1
            task.requirement_content = {**dict(task.requirement_content or {}), "note": "合成需求已更新，请重新加载后导出。"}
        task.status = "doing"
        task.reviewed_at = None
        task.reviewed_by = None
        task.reviewed_by_name = ""
        for request in (await session.scalars(select(am.ApprovalRequest).where(
                am.ApprovalRequest.task_id == tid, am.ApprovalRequest.status == "pending"))).all():
            request.status = "cancelled"
        version = int((await session.scalar(select(func.max(am.ArtifactVersion.seq)).where(
            am.ArtifactVersion.task_id == tid))) or 0) + 1
        await _delivery(session, task, version)
        await session.commit()
        return {"ok": True, **await _task_info(session, task)}
