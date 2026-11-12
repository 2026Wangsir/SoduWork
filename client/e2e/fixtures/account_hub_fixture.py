"""Loopback-only temporary Hub for client E2E; never loads production .env."""
import argparse
import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import secrets
import socket
import ssl
import sys
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument("--root", required=True)
args = parser.parse_args()
root = Path(args.root).resolve()
if root.parent != Path(tempfile.gettempdir()).resolve() or not root.name.startswith("soduwork-account-http-"):
    raise RuntimeError("The E2E requires a dedicated system temporary directory")
root.mkdir(exist_ok=True)
os.chdir(root)
repo = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(repo / "hub-backend"))
os.environ.update(DATABASE_URL="sqlite+aiosqlite:///" + (root / ".smoke-account-http.db").as_posix(),
                  AUTH_SECRET=secrets.token_urlsafe(40), ADMIN_PASS=secrets.token_urlsafe(24),
                  SODUWORK_ENV="development", DEVICE_AUTH_COMPAT="false", CLUSTER_REDIS_URL="",
                  LIBRARY_STORAGE_BACKEND="local", LIBRARY_STORAGE_DIR=str(root / "library"),
                  MINIO_ENDPOINT="", LIBRARY_MINIO_ENDPOINT="", LIBRARY_NFS_HOST="")
from app.config import Settings
Settings.model_config["env_file"] = None
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import func, select
from app import models
from app.api import client_auth, client_email_auth, clients, account_profile
from app.db import Base, SessionLocal, engine
from app.auth import hash_password, sign_token
from app.deps import current_user
from app.mail_models import MailOutbox
from app.account_models import EmailChallenge
from app.account_privacy_models import AccountPrivacyRequest
from app.services import account_legal, account_mail, account_privacy, client_access, device_auth
from account_smtp_fixture import TLSSMTP

control_key = secrets.token_urlsafe(24)
smtp = TLSSMTP(root)
trusted = ssl.create_default_context(cafile=str(smtp.cert))
original_context = account_mail.ssl.create_default_context
account_mail.ssl.create_default_context = lambda *a, **k: trusted


@asynccontextmanager
async def lifespan(app):
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    async with SessionLocal() as session:
        session.add(models.OrgUnit(id="fixture-default-org", name="E2E default organization"))
        session.add(models.Role(id="fixture-normal-role", name="E2E member", permissions=[]))
        await session.commit()
        session.add(models.User(id="fixture-legacy-email-user", username="legacy.email@example.test",
            password_hash=hash_password("Legacy-password-2026"), is_active=True,
            org_id="fixture-default-org", role_id="fixture-normal-role"))
        session.add(models.User(id="fixture-passwordless-user", username="passwordless@example.test",
            email="passwordless@example.test", email_normalized="passwordless@example.test",
            email_verified_at=datetime.now(timezone.utc), password_hash="", is_active=True,
            org_id="fixture-default-org", role_id="fixture-normal-role"))
        await session.commit()
        await client_access.update_policy(session, {"defaultOrgId": "fixture-default-org", "defaultRoleId": "fixture-normal-role"})
        await account_legal.save_settings(session, {"operatorName": "Isolated E2E operator", "contactEmail": "privacy@example.test"})
        await account_mail.save_settings(session, {"enabled": True, "host": "localhost", "port": smtp.server_address[1],
            "security": "ssl", "username": "sender@example.test", "senderAddress": "sender@example.test",
            "senderName": "SoduWork E2E", "password": "fixture-smtp-password"})
        await session.commit()
    async def mail_loop():
        while True:
            await account_mail.process_one(SessionLocal)
            await asyncio.sleep(0.15)
    jobs = [asyncio.create_task(mail_loop()), asyncio.create_task(account_privacy.tick_loop())]
    print("ACCOUNT_FIXTURE_READY " + json.dumps({"port": sock.getsockname()[1], "key": control_key}), flush=True)
    try:
        yield
    finally:
        for job in jobs:
            job.cancel()
        await asyncio.gather(*jobs, return_exceptions=True)
        await engine.dispose()
        smtp.shutdown()
        smtp.server_close()
        account_mail.ssl.create_default_context = original_context


app = FastAPI(lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["null"], allow_methods=["*"], allow_headers=["*"])
for router in (client_auth.router, client_email_auth.router, clients.router, account_profile.router):
    app.include_router(router)


@app.get("/__fixture__/mail/{challenge_id}")
async def delivered_mail(challenge_id: str, x_fixture_key: str = Header(default="")):
    if x_fixture_key != control_key:
        raise HTTPException(403)
    async with SessionLocal() as session:
        row = await session.scalar(select(MailOutbox).where(MailOutbox.challenge_id == challenge_id))
        if row is None or row.state != "sent":
            return {"ready": False}
        challenge = await session.get(EmailChallenge, challenge_id)
        recipient = challenge.email_normalized
    # Only actual SMTP DATA accepted by the loopback server can yield a code.
    code = smtp.last_code(recipient)
    if code:
        return {"ready": True, "code": code, "smtpDelivered": True}
    return {"ready": False}


@app.get("/__fixture__/mail-counts")
async def mail_counts(x_fixture_key: str = Header(default="")):
    """Expose only fixture row counts to prove rejected requests have no mail side effects."""
    if x_fixture_key != control_key:
        raise HTTPException(403)
    async with SessionLocal() as session:
        return {"challenges": await session.scalar(select(func.count()).select_from(EmailChallenge)),
                "outbox": await session.scalar(select(func.count()).select_from(MailOutbox))}


@app.get("/__fixture__/account/{user_id}")
async def account_state(user_id: str, x_fixture_key: str = Header(default="")):
    """Read-only lifecycle evidence for isolated E2E accounts; never expose secrets."""
    if x_fixture_key != control_key:
        raise HTTPException(403)
    async with SessionLocal() as session:
        # Read both states in one SQL snapshot. Separate SELECTs could observe
        # an old User and a newly completed job across the worker's commit.
        result = (await session.execute(select(models.User, AccountPrivacyRequest)
            .outerjoin(AccountPrivacyRequest, (AccountPrivacyRequest.user_id == models.User.id)
                & (AccountPrivacyRequest.kind == "deletion"))
            .where(models.User.id == user_id))).first()
        if result is None:
            raise HTTPException(404)
        user, job = result
        return {"active": user.is_active, "deleted": user.account_deleted_at is not None,
                "emailCleared": not bool(user.email), "passwordCleared": not bool(user.password_hash),
                "deletionStatus": job.status if job else None}


@app.post("/__fixture__/account/{user_id}/devices")
async def seed_devices(user_id: str, x_fixture_key: str = Header(default="")):
    """Add isolated device records without touching the signed-in device."""
    if x_fixture_key != control_key:
        raise HTTPException(403)
    async with SessionLocal() as session:
        if await session.get(models.User, user_id) is None:
            raise HTTPException(404)
        current = await session.scalar(select(models.Client).where(
            models.Client.user_ref == user_id, models.Client.auth_state == "active"))
        if current is None:
            raise HTTPException(409)
        other_id, history_id = "fixture-other-" + user_id, "fixture-history-" + user_id
        session.add_all([
            models.Client(id=other_id, name="另一台隔离电脑", platform="Windows",
                user_ref=user_id, auth_state="active", auth_version=3),
            models.Client(id=history_id, name="已退出的隔离电脑", platform="macOS",
                user_ref=user_id, auth_state="revoked", auth_version=5),
        ])
        await session.commit()
        return {"currentId": current.id, "currentAuthVersion": current.auth_version,
                "otherId": other_id, "historyId": history_id}


@app.get("/__fixture__/device/{device_id}")
async def device_state(device_id: str, x_fixture_key: str = Header(default="")):
    """Expose association/version evidence only; never device credentials."""
    if x_fixture_key != control_key:
        raise HTTPException(403)
    async with SessionLocal() as session:
        device = await session.get(models.Client, device_id)
        if device is None:
            raise HTTPException(404)
        return {"userRef": device.user_ref, "authState": device.auth_state,
                "authVersion": device.auth_version}


@app.post("/__fixture__/account/{user_id}/session-probes")
async def session_probes(user_id: str, x_fixture_key: str = Header(default="")):
    """Create an isolated second device and pre-change auth probes only."""
    if x_fixture_key != control_key:
        raise HTTPException(403)
    async with SessionLocal() as session:
        user = await session.get(models.User, user_id)
        if user is None:
            raise HTTPException(404)
        device = models.Client(id="fixture-password-secondary-" + user_id,
            user_ref=user_id, name="密码验证辅助电脑", auth_state="active", auth_version=2,
            secret_hash=device_auth.hash_secret(secrets.token_urlsafe(32)))
        session.add(device)
        await session.commit()
        return {"deviceId": device.id, "deviceSession": device_auth.issue_session(device)[0],
                "bearer": sign_token(user.id, user.auth_version)}


@app.get("/__fixture__/bearer-profile")
async def bearer_profile(user=Depends(current_user), x_fixture_key: str = Header(default="")):
    """Exercise the actual administrative bearer dependency in the fixture."""
    if x_fixture_key != control_key:
        raise HTTPException(403)
    return {"id": user.id}


if __name__ == "__main__":
    import uvicorn
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    config = uvicorn.Config(app, host="127.0.0.1", port=sock.getsockname()[1], log_level="error", access_log=False)
    asyncio.run(uvicorn.Server(config).serve(sockets=[sock]))
