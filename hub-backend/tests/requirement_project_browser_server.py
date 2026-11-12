"""Loopback-only project picker fixture with production Device authentication."""
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
TASKS = {key: "project-selection-" + key for key in
         ("ready", "stale", "archived", "executed", "repo", "unavailable", "shared", "switch")}
PROJECTS = {key: "picker-project-" + key for key in ("own", "second", "public", "foreign", "retired")}
base_lifespan = app.router.lifespan_context


@asynccontextmanager
async def lifespan(application):
    async with base_lifespan(application):
        async with fixture.sessions() as session:
            session.add(models.OrgUnit(id="e2e-foreign-org", name="Other synthetic organization"))
            (await session.get(models.User, "other")).org_id = "e2e-foreign-org"
            for key, pid in PROJECTS.items():
                session.add(models.Project(id=pid, name={"own": "协作示例项目", "second": "文档示例项目",
                    "public": "公共示例项目", "foreign": "其他组织示例项目", "retired": "已归档示例项目"}[key],
                    org_id=None if key == "public" else "e2e-foreign-org" if key == "foreign" else "e2e-org",
                    status="archived" if key == "retired" else "active"))
            session.add(models.Repo(id="picker-repository", project_id=PROJECTS["own"], name="Synthetic repository"))
            for key, tid in TASKS.items():
                session.add(models.Task(id=tid, title="项目选择示例 · " + key,
                    note="仅使用合成需求验证项目选择，不连接真实业务数据。",
                    created_by="sender", assignee_user_id="sender", owner_client_id="e2e-sender",
                    requester_user_id="recipient" if key == "shared" else None,
                    shared_org_id="e2e-org" if key == "shared" else None,
                    status="todo", triage_stage="ready", requirement_version=3,
                    archived_at=datetime.now(timezone.utc) if key == "archived" else None,
                    actual_start_at=datetime.now(timezone.utc) if key == "executed" else None,
                    project_id=PROJECTS["own"] if key == "repo" else PROJECTS["retired"] if key == "unavailable" else None,
                    repo_id="picker-repository" if key == "repo" else ""))
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


@app.get("/e2e/project-bootstrap")
async def bootstrap():
    async with fixture.sessions() as session:
        identities = {}
        for name, cid in (("owner", "e2e-sender"), ("viewer", "e2e-recipient"), ("outsider", "e2e-other")):
            client = await session.get(models.Client, cid)
            token, ttl = device_auth.issue_session(client)
            identities[name] = {"ok": True, "stored": True, "clientId": client.id,
                                "user": {"id": client.user_ref}, "session": token, "expiresIn": ttl}
        return {"isolated": True, "identities": identities, "tasks": TASKS, "projects": PROJECTS}


@app.post("/e2e/project-revise")
async def revise(body: dict = Body(default_factory=dict)):
    tid, pid = str(body.get("taskId") or ""), str(body.get("projectId") or "")
    if not ((tid in TASKS.values() and not pid) or (pid in PROJECTS.values() and not tid)):
        raise HTTPException(404, "Unknown synthetic target")
    async with fixture.sessions() as session:
        if pid:
            (await session.get(models.Project, pid)).status = "archived"
        else:
            task = await session.get(models.Task, tid)
            task.requirement_version += 1
            if body.get("archive"):
                task.archived_at = datetime.now(timezone.utc)
            elif body.get("execute"):
                task.actual_start_at = datetime.now(timezone.utc)
            else:
                task.note = "Updated synthetic requirement"
        await session.commit()
        return {"ok": True}


@app.get("/e2e/project-state")
async def state():
    async with fixture.sessions() as session:
        rows = (await session.scalars(select(models.Task))).all()
        return {"tasks": {row.id: {"title": row.title, "projectId": row.project_id,
            "repoId": row.repo_id, "requirementVersion": row.requirement_version,
            "status": row.status, "ownerClientId": row.owner_client_id,
            "ownerUserId": row.owner_user_id} for row in rows}}
