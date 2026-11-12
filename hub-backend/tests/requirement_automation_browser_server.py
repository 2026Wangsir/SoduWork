"""Loopback-only requirement draft fixture with production Device authentication."""
import importlib
import os
import secrets
import tempfile
from contextlib import asynccontextmanager
from datetime import datetime, timezone
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
from sqlalchemy import select

from tests import collaboration_browser_server as fixture
from app import db, models
from app.api import tasks
from app.deps import current_client
from app.services import device_auth

for model_file in (Path(__file__).resolve().parents[1] / "app").glob("*models.py"):
    importlib.import_module("app." + model_file.stem)

app = fixture.app
app.dependency_overrides.pop(current_client, None)
app.include_router(tasks.router)
TASKS = {key: "automation-source-" + key for key in ("ready", "stale", "archive", "switch", "shared")}
base_lifespan = app.router.lifespan_context


@asynccontextmanager
async def lifespan(application):
    async with base_lifespan(application):
        async with fixture.sessions() as session:
            for key, tid in TASKS.items():
                session.add(models.Task(id=tid, title="PRIVATE_EXECUTION_TITLE", note="PRIVATE_EXECUTION_NOTE",
                    requirement_content={"title": "独立自动化草稿 · " + key, "note": "仅复制公开需求说明，不修改原需求。"},
                    created_by="sender", assignee_user_id="sender", owner_client_id="e2e-sender",
                    shared_org_id="e2e-org" if key == "shared" else None,
                    status="todo", triage_stage="ready", requirement_version=3,
                    acceptance_criteria=["保留来源并保持停用"],
                    work_routing={"modelName": "local:private:model", "privateConfig": "PRIVATE_TASK_CONFIG"}))
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


@app.get("/e2e/automation-bootstrap")
async def bootstrap():
    async with fixture.sessions() as session:
        identities = {}
        for name, cid in (("owner", "e2e-sender"), ("viewer", "e2e-recipient")):
            client = await session.get(models.Client, cid)
            token, ttl = device_auth.issue_session(client)
            identities[name] = {"ok": True, "stored": True, "clientId": client.id,
                                "user": {"id": client.user_ref}, "session": token, "expiresIn": ttl}
        return {"isolated": True, "identities": identities, "tasks": TASKS}


@app.post("/e2e/automation-revise")
async def revise(body: dict = Body(default_factory=dict)):
    tid = str(body.get("taskId") or "")
    if tid not in TASKS.values():
        raise HTTPException(404, "Unknown synthetic task")
    async with fixture.sessions() as session:
        task = await session.get(models.Task, tid)
        task.requirement_version += 1
        if body.get("archive"):
            task.archived_at = datetime.now(timezone.utc)
        else:
            task.requirement_content = {**task.requirement_content, "note": "Updated synthetic requirement"}
        await session.commit()
        return {"ok": True}


@app.get("/e2e/automation-state")
async def state():
    async with fixture.sessions() as session:
        tasks = {}
        for tid in TASKS.values():
            row = await session.get(models.Task, tid)
            tasks[tid] = {column.key: getattr(row, column.key) for column in models.Task.__table__.columns}
        plans = list((await session.scalars(select(models.AiSchedule))).all())
        return {"tasks": tasks, "schedules": [{"id": row.id, "enabled": row.enabled,
            "sourceRequirement": {k: v for k, v in (row.source_requirement or {}).items() if not k.startswith("_")}}
            for row in plans]}
