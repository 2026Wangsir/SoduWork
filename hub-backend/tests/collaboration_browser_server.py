"""Real collaboration routers with isolated identities, database and file storage."""
import os
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path

root = Path(os.environ['SODUWORK_COLLAB_E2E_ROOT']).resolve()
if root.parent != Path(tempfile.gettempdir()).resolve() or not root.name.startswith('soduwork-collab-e2e-'):
    raise RuntimeError('An isolated temporary directory is required')
os.environ['DATABASE_URL'] = 'sqlite+aiosqlite:///' + (root / 'collaboration.sqlite').as_posix()
os.environ['LIBRARY_STORAGE_DIR'] = str(root / 'library')
os.environ['LIBRARY_STORAGE_BACKEND'] = 'local'
for key in ('MINIO_ENDPOINT', 'MINIO_ACCESS_KEY', 'MINIO_SECRET_KEY', 'LIBRARY_MINIO_ENDPOINT', 'LIBRARY_MINIO_ACCESS_KEY', 'LIBRARY_MINIO_SECRET_KEY'):
    os.environ[key] = ''

from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from app.api import clients, attachments, library
from app import models
from app.db import Base, get_session
from app.deps import authenticated_client, current_client
from app.services import storage

storage._LOCAL_DIR = str(root / 'attachments')
engine = create_async_engine(os.environ['DATABASE_URL'])
sessions = async_sessionmaker(engine, expire_on_commit=False)

@asynccontextmanager
async def lifespan(_app):
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with sessions() as session:
        session.add(models.OrgUnit(id='e2e-org', name='协同验收组'))
        for key, name in [('sender', '发送验收'), ('recipient', '接收验收'), ('other', '无关验收')]:
            session.add(models.User(id=key, username=key, display_name=name, is_active=True, org_id='e2e-org'))
            session.add(models.Client(id='e2e-' + key, user_ref=key, auth_state='active'))
        await session.commit()
    yield
    await engine.dispose()

app = FastAPI(lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=['null'], allow_methods=['*'], allow_headers=['*'], expose_headers=['Content-Disposition'])
for router in (clients.router, attachments.router, library.router):
    app.include_router(router)

async def session_override():
    async with sessions() as session:
        yield session

async def identity(request: Request):
    authorization = request.headers.get('Authorization', '')
    if authorization.startswith('Device '):
        async with sessions() as session:
            return await authenticated_client(authorization=authorization,
                x_soduwork_device=None, x_soduwork_secret=None, session=session)
    key = request.headers.get('X-Soduwork-Device', '')
    if key not in ('e2e-sender', 'e2e-recipient', 'e2e-other'):
        raise HTTPException(401, 'Unknown isolated identity')
    async with sessions() as session:
        return await session.get(models.Client, key)

app.dependency_overrides[get_session] = session_override
app.dependency_overrides[current_client] = identity

@app.get('/ready')
async def ready():
    return {'ok': True, 'isolated': True}
