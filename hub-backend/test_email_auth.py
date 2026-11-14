"""Isolated HTTP and concurrent database tests; never contacts SMTP or a business DB."""
import asyncio
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch
from datetime import timedelta

_temp = tempfile.TemporaryDirectory(prefix="soduwork-email-auth-")
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + (Path(_temp.name) / ".smoke-email-auth.db").as_posix()
os.environ["SODUWORK_DATA_ROOT"] = str(Path(_temp.name) / "data")
os.environ["AUTH_SECRET"] = "isolated-email-account-tests-secret-20261023"
os.environ["SODUWORK_ENV"] = "development"
os.environ["ADMIN_PASS"] = "isolated-admin-test-password"
os.environ["CLUSTER_REDIS_URL"] = ""
os.environ["DEVICE_AUTH_COMPAT"] = "false"
from app.config import Settings
Settings.model_config["env_file"] = None

import httpx
from fastapi import FastAPI
from sqlalchemy import delete, select, update, func
from sqlalchemy.ext.asyncio import AsyncSession
from app import models
from app.account_models import EmailChallenge, EmailRateLimit, UserConsent
from app.mail_models import MailOutbox
from app.auth import hash_password, verify_password, sign_token
from app.deps import current_user
from app.db import Base, SessionLocal, engine
from app.api import client_auth, client_email_auth, clients
from app.services import account_mail, client_access, device_auth, device_connections, email_auth
from app.services.account_legal import required_versions

app = FastAPI()
for router in (client_auth.router, client_email_auth.router, clients.router):
    app.include_router(router)
TABLES = [models.User.__table__, models.Client.__table__, models.OrgUnit.__table__, models.Role.__table__,
          models.AppSetting.__table__, models.AIUsageEvent.__table__, models.AIUsageDaily.__table__,
          models.AuditLog.__table__,
          EmailChallenge.__table__, EmailRateLimit.__table__, UserConsent.__table__, MailOutbox.__table__]


class EmailAuthTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from tests.traceback_source_cache import snapshot_loaded_sources
        self.addCleanup(snapshot_loaded_sources())
        async with engine.begin() as connection:
            await connection.run_sync(lambda c: Base.metadata.create_all(c, tables=TABLES))
            for table in reversed(TABLES):
                await connection.execute(delete(table))
        client_access._policy_cache = None
        client_access.invalidate_quota()
        async with SessionLocal() as session:
            session.add(models.OrgUnit(id="root", name="Default organization"))
            session.add(models.OrgUnit(id="configured", name="Configured organization"))
            session.add(models.Role(id="normal-role", name="Normal employee", permissions=[]))
            for i in (1, 2):
                session.add(models.Client(id=f"email-device-{i}", secret_hash=device_auth.hash_secret(str(i) * 48),
                                          auth_state="pending", auth_version=1))
            await session.commit()
            await client_access.update_policy(session, {"defaultOrgId": "configured", "defaultRoleId": "normal-role"})
            await account_mail.save_settings(session, {"enabled": True, "host": "smtp.example.test", "port": 465,
                "security": "ssl", "username": "sender@example.test", "senderAddress": "sender@example.test",
                "senderName": "SoduWork Test", "password": "isolated-mail-test-password"})
            await session.commit()
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://auth.test")

    async def asyncTearDown(self):
        await self.http.aclose()
        await engine.dispose()

    async def post(self, path, body, device=1):
        return await self.http.post("/api/v1/client-auth" + path,
            headers={"X-Device-Key": str(device) * 48}, json={"device": f"email-device-{device}", **body})

    async def proof(self, email="person@example.test", purpose="register", device=1):
        response = await self.post("/email-challenges", {"email": email, "purpose": purpose}, device)
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertNotIn("code", payload)
        async with SessionLocal() as session:
            mail = await session.scalar(select(MailOutbox).where(MailOutbox.challenge_id == payload["challengeId"]))
            code = account_mail.unseal(mail.payload_encrypted)["code"]
            self.assertNotIn(code, mail.payload_encrypted)
        return {"email": email, "challengeId": payload["challengeId"], "code": code}

    async def register(self, email="person@example.test", device=1):
        proof = await self.proof(email=email, device=device)
        response = await self.post("/register", {**proof, "password": "Original-password-123",
            "displayName": "Test person", "consents": required_versions()}, device)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json(), proof

    async def test_explicit_registration_is_active_and_uses_configured_organization(self):
        result, proof = await self.register()
        self.assertTrue(result["created"])
        self.assertTrue(result["user"]["emailVerified"])
        self.assertEqual(result["user"]["orgId"], "configured")
        self.assertEqual(result["user"]["roleId"], "normal-role")
        self.assertTrue(result["quota"]["enabled"])
        self.assertEqual(result["quota"]["planId"], "trial")
        self.assertEqual(result["quota"]["limit"], 100_000)
        me = await self.http.get("/api/v1/client-auth/me", headers={"Authorization": "Device " + result["session"]})
        self.assertEqual(me.status_code, 200)
        self.assertEqual(me.json()["quota"]["planId"], "trial")
        async with SessionLocal() as session:
            user = await email_auth.verified_user(session, proof["email"])
            self.assertTrue(user.is_active)
            self.assertFalse(user.is_super)
            self.assertTrue(verify_password("Original-password-123", user.password_hash))
            self.assertEqual(await session.scalar(select(func.count()).select_from(UserConsent)), 2)
            challenge = await session.get(EmailChallenge, proof["challengeId"])
            self.assertIsNotNone(challenge.consumed_at)

    async def test_consent_is_required_and_does_not_spend_code(self):
        proof = await self.proof()
        bad = await self.post("/register", {**proof, "password": "Original-password-123", "consents": {}})
        self.assertEqual(bad.status_code, 422)
        async with SessionLocal() as session:
            self.assertIsNone((await session.get(EmailChallenge, proof["challengeId"])).consumed_at)
            self.assertEqual(await session.scalar(select(func.count()).select_from(models.User)), 0)
        good = await self.post("/register", {**proof, "password": "Original-password-123", "consents": required_versions()})
        self.assertEqual(good.status_code, 200, good.text)

    async def test_device_key_is_required_for_public_operations(self):
        response = await self.http.post("/api/v1/client-auth/email-challenges",
            json={"device": "email-device-1", "email": "person@example.test", "purpose": "register"})
        self.assertIn(response.status_code, (401, 422))
        async with SessionLocal() as session:
            self.assertEqual(await session.scalar(select(func.count()).select_from(MailOutbox)), 0)

    async def test_mail_policy_unavailable_and_no_fake_send(self):
        async with SessionLocal() as session:
            await account_mail.save_settings(session, {"enabled": False})
            await session.commit()
        policy = (await self.http.get("/api/v1/client-auth/policy")).json()
        self.assertFalse(policy["mailReady"])
        self.assertEqual(policy["loginMethods"], ["password"])
        self.assertEqual(policy["requiredConsentVersions"], required_versions())
        response = await self.post("/email-challenges", {"email": "person@example.test", "purpose": "login"})
        self.assertEqual(response.status_code, 503)

    async def test_login_challenge_rejects_unknown_email_before_creating_mail_or_account(self):
        response = await self.post("/email-challenges", {"email": "New.Person@Example.Test", "purpose": "login"})
        self.assertEqual(response.status_code, 404, response.text)
        self.assertEqual(response.json()["detail"]["code"], "ACCOUNT_NOT_REGISTERED")
        async with SessionLocal() as session:
            for table in (EmailChallenge, MailOutbox, models.User):
                self.assertEqual(await session.scalar(select(func.count()).select_from(table)), 0)
            device = await session.get(models.Client, "email-device-1")
            self.assertEqual(device.auth_state, "pending")
            self.assertIsNone(device.user_ref)
        # The login check does not consume the separate registration cooldown.
        await self.register("new.person@example.test")

    async def test_login_challenge_validates_email_before_lookup_or_mail(self):
        for address in ("not-an-email", "name@example", "name..part@example.test", "name@-example.test"):
            with self.subTest(address=address):
                response = await self.post("/email-challenges", {"email": address, "purpose": "login"})
                self.assertEqual(response.status_code, 422, response.text)
                self.assertEqual(response.json()["detail"]["code"], "EMAIL_INVALID")
        async with SessionLocal() as session:
            for table in (EmailChallenge, MailOutbox, EmailRateLimit):
                self.assertEqual(await session.scalar(select(func.count()).select_from(table)), 0)

    async def test_login_challenge_lookup_requires_device_credentials(self):
        for headers, expected, code in (({}, 422, "DEVICE_AUTH_FAILED"),
                                        ({"X-Device-Key": "9" * 48}, 401, "DEVICE_KEY_INVALID")):
            response = await self.http.post("/api/v1/client-auth/email-challenges", headers=headers,
                json={"device": "email-device-1", "email": "unknown@example.test", "purpose": "login"})
            self.assertEqual(response.status_code, expected, response.text)
            self.assertEqual(response.json()["detail"]["code"], code)
        async with SessionLocal() as session:
            self.assertEqual(await session.scalar(select(func.count()).select_from(EmailRateLimit)), 0)

    async def test_unknown_login_checks_share_durable_email_device_and_ip_limits(self):
        first = await self.post("/email-challenges", {"email": "new@example.test", "purpose": "login"})
        self.assertEqual(first.status_code, 404, first.text)
        second = await self.post("/email-challenges", {"email": "NEW@example.test", "purpose": "login"}, 2)
        self.assertEqual(second.status_code, 429, second.text)
        self.assertEqual(second.json()["detail"]["code"], "AUTH_RATE_LIMITED")
        async with SessionLocal() as session:
            for identity in ("send-cooldown:login:new@example.test", "send-email:new@example.test",
                             "send-device:email-device-1", "send-ip:127.0.0.1"):
                budget = await session.get(EmailRateLimit, email_auth._digest("account-rate\0" + identity))
                self.assertIsNotNone(budget, identity)
                self.assertEqual(budget.count, 1)
            # A fresh address must not bypass the device-wide budget.
            await session.execute(update(EmailRateLimit).where(
                EmailRateLimit.key == email_auth._digest("account-rate\0send-device:email-device-1")
            ).values(count=30))
            await session.commit()
        limited = await self.post("/email-challenges", {"email": "different@example.test", "purpose": "login"})
        self.assertEqual(limited.status_code, 429, limited.text)
        async with SessionLocal() as session:
            self.assertEqual(await session.scalar(select(func.count()).select_from(MailOutbox)), 0)

    async def test_login_challenge_normalizes_registered_email_and_preserves_otp_login(self):
        registered, _ = await self.register("person@example.test")
        proof = await self.proof(" PERSON@EXAMPLE.TEST ", "login", 2)
        async with SessionLocal() as session:
            challenge = await session.get(EmailChallenge, proof["challengeId"])
            self.assertEqual(challenge.email_normalized, "person@example.test")
            self.assertEqual(challenge.purpose, "login")
        result = await self.post("/login/email-code", proof, 2)
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()["user"]["id"], registered["user"]["id"])

    async def test_unknown_login_with_registration_disabled_does_not_offer_registration(self):
        registered, _ = await self.register()
        async with SessionLocal() as session:
            await client_access.update_policy(session, {"allowSelfRegistration": False})
        response = await self.post("/email-challenges", {"email": "new@example.test", "purpose": "login"}, 2)
        self.assertEqual(response.status_code, 403, response.text)
        self.assertEqual(response.json()["detail"]["code"], "SELF_REGISTRATION_DISABLED")
        async with SessionLocal() as session:
            self.assertEqual(await session.scalar(select(func.count()).select_from(MailOutbox)), 1)
        proof = await self.proof(purpose="login", device=2)
        result = await self.post("/login/email-code", proof, 2)
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()["user"]["id"], registered["user"]["id"])

    async def test_login_challenge_routes_legacy_or_unverified_accounts_without_issuing_proof(self):
        async with SessionLocal() as session:
            session.add(models.User(id="legacy-name", username="Legacy@Example.Test",
                                    password_hash=hash_password("Original-password-123"), is_active=True))
            session.add(models.User(id="unverified-email", username="unverified.employee",
                                    email="reserved@example.test", email_normalized="reserved@example.test",
                                    password_hash=hash_password("Original-password-123"), is_active=True))
            session.add(models.User(id="retired-alias", username="old@example.test",
                                    email="current@example.test", email_normalized="current@example.test",
                                    email_verified_at=email_auth.now(),
                                    password_hash=hash_password("Original-password-123"), is_active=True))
            await session.commit()
        for address in ("legacy@example.test", "RESERVED@EXAMPLE.TEST", "old@example.test"):
            response = await self.post("/email-challenges", {"email": address, "purpose": "login"})
            self.assertEqual(response.status_code, 409, response.text)
            self.assertEqual(response.json()["detail"]["code"], "LEGACY_EMAIL_BINDING_REQUIRED")
        async with SessionLocal() as session:
            self.assertEqual(await session.scalar(select(func.count()).select_from(MailOutbox)), 0)
            self.assertEqual(await session.scalar(select(func.count()).select_from(EmailChallenge)), 0)
            self.assertEqual(await session.scalar(select(func.count()).select_from(models.User)), 3)

    async def test_challenge_acknowledges_queue_and_reports_only_confirmed_send(self):
        response = await self.post("/email-challenges", {"email": "person@example.test", "purpose": "register"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["queued"])
        self.assertEqual(response.json()["deliveryState"], "queued")
        challenge_id = response.json()["challengeId"]
        path = "/api/v1/client-auth/email-challenges/" + challenge_id
        headers = {"X-Device-Key": "1" * 48}
        queued = await self.http.get(path, params={"device": "email-device-1"}, headers=headers)
        self.assertEqual(queued.status_code, 200, queued.text)
        self.assertEqual(queued.headers["cache-control"], "no-store")
        self.assertEqual(queued.json(), {"challengeId": challenge_id, "deliveryState": "queued", "errorCode": ""})
        self.assertTrue(await account_mail.process_one(SessionLocal, sender=lambda *_: None))
        sent = await self.http.get(path, params={"device": "email-device-1"}, headers=headers)
        self.assertEqual(sent.json(), {"challengeId": challenge_id, "deliveryState": "sent", "errorCode": ""})

    async def test_challenge_delivery_reports_failures_without_leaking_mail_payload(self):
        proof = await self.proof()
        path = "/api/v1/client-auth/email-challenges/" + proof["challengeId"]
        headers = {"X-Device-Key": "1" * 48}
        def reject(*_):
            raise account_mail.MailDeliveryError("SMTP_AUTH_FAILED")
        self.assertTrue(await account_mail.process_one(SessionLocal, sender=reject))
        failed = await self.http.get(path, params={"device": "email-device-1"}, headers=headers)
        self.assertEqual(failed.json(), {"challengeId": proof["challengeId"], "deliveryState": "failed", "errorCode": "SMTP_AUTH_FAILED"})
        for state, error, expected_state, expected_error in (
                ("sending", "", "sending", ""),
                ("retry", "SMTP_CONNECTION_FAILED", "retry", "SMTP_CONNECTION_FAILED"),
                ("unknown", "SMTP_RESULT_UNKNOWN", "unknown", "SMTP_RESULT_UNKNOWN"),
                ("failed", "SMTP_RECIPIENT_REJECTED", "failed", "SMTP_RECIPIENT_REJECTED"),
                ("failed", proof["code"] + " person@example.test", "failed", "MAIL_INTERNAL_ERROR"),
                ("unexpected", "", "unknown", "MAIL_INTERNAL_ERROR")):
            with self.subTest(state=state, expected_error=expected_error):
                async with SessionLocal() as session:
                    await session.execute(update(MailOutbox).values(state=state, error_code=error))
                    await session.commit()
                status = await self.http.get(path, params={"device": "email-device-1"}, headers=headers)
                self.assertEqual(status.json(), {"challengeId": proof["challengeId"], "deliveryState": expected_state, "errorCode": expected_error})
                self.assertNotIn(proof["code"], status.text)
                self.assertNotIn(proof["email"], status.text)

    async def test_challenge_delivery_expiry_and_missing_queue_are_explicit(self):
        proof = await self.proof()
        path = "/api/v1/client-auth/email-challenges/" + proof["challengeId"]
        headers = {"X-Device-Key": "1" * 48}
        async with SessionLocal() as session:
            await session.execute(delete(MailOutbox))
            await session.commit()
        missing = await self.http.get(path, params={"device": "email-device-1"}, headers=headers)
        self.assertEqual(missing.json(), {"challengeId": proof["challengeId"], "deliveryState": "failed", "errorCode": "MAIL_DELIVERY_UNAVAILABLE"})
        async with SessionLocal() as session:
            await session.execute(update(EmailChallenge).values(expires_at=email_auth.now() - timedelta(seconds=1)))
            await session.commit()
        expired = await self.http.get(path, params={"device": "email-device-1"}, headers=headers)
        self.assertEqual(expired.json(), {"challengeId": proof["challengeId"], "deliveryState": "expired", "errorCode": "MAIL_EXPIRED"})

    async def test_challenge_delivery_requires_requesting_device_and_public_context(self):
        proof = await self.proof()
        path = "/api/v1/client-auth/email-challenges/" + proof["challengeId"]
        headers = {"X-Device-Key": "1" * 48}
        no_key = await self.http.get(path, params={"device": "email-device-1"})
        self.assertIn(no_key.status_code, (401, 422))
        wrong_key = await self.http.get(path, params={"device": "email-device-1"}, headers={"X-Device-Key": "2" * 48})
        self.assertEqual(wrong_key.status_code, 401)
        other = await self.http.get(path, params={"device": "email-device-2"}, headers={"X-Device-Key": "2" * 48})
        self.assertEqual(other.status_code, 404)
        unknown = await self.http.get("/api/v1/client-auth/email-challenges/not-found", params={"device": "email-device-1"}, headers=headers)
        self.assertEqual(unknown.status_code, 404)
        self.assertEqual(other.json(), unknown.json())
        for values in ({"purpose": "reauthentication"}, {"purpose": "register", "user_id": "some-user"}):
            async with SessionLocal() as session:
                await session.execute(update(EmailChallenge).values(**values))
                await session.commit()
            denied = await self.http.get(path, params={"device": "email-device-1"}, headers=headers)
            self.assertEqual(denied.status_code, 404)
        async with SessionLocal() as session:
            await session.execute(update(models.Client).where(models.Client.id == "email-device-1").values(auth_state="revoked"))
            await session.commit()
        revoked = await self.http.get(path, params={"device": "email-device-1"}, headers=headers)
        self.assertEqual(revoked.status_code, 403)

    async def test_password_and_code_login_share_user_and_do_not_autoregister(self):
        registered, _ = await self.register()
        password = await self.post("/login/password", {"email": "PERSON@EXAMPLE.TEST", "password": "Original-password-123"}, 2)
        self.assertEqual(password.status_code, 200, password.text)
        self.assertEqual(password.json()["user"]["id"], registered["user"]["id"])
        proof = await self.proof(purpose="login")
        code = await self.post("/login/email-code", proof)
        self.assertEqual(code.status_code, 200, code.text)
        unknown = await self.post("/login/password", {"email": "unknown@example.test", "password": "Original-password-123"})
        self.assertEqual(unknown.status_code, 401)
        unknown_code = await self.post("/email-challenges", {"email": "unknown@example.test", "purpose": "login"})
        self.assertEqual(unknown_code.status_code, 404)
        self.assertEqual(unknown_code.json()["detail"]["code"], "ACCOUNT_NOT_REGISTERED")
        async with SessionLocal() as session:
            self.assertEqual(await session.scalar(select(func.count()).select_from(models.User)), 1)

    async def test_email_code_login_rechecks_registration_after_issuing_proof(self):
        registered, _ = await self.register()
        proof = await self.proof(purpose="login", device=2)
        async with SessionLocal() as session:
            await session.execute(update(models.User).where(models.User.id == registered["user"]["id"])
                                  .values(email="replacement@example.test", email_normalized="replacement@example.test"))
            await session.commit()
        result = await self.post("/login/email-code", proof, 2)
        self.assertEqual(result.status_code, 404, result.text)
        self.assertEqual(result.json()["detail"]["code"], "ACCOUNT_NOT_REGISTERED")
        async with SessionLocal() as session:
            self.assertEqual(await session.scalar(select(func.count()).select_from(models.User)), 1)
            self.assertIsNotNone((await session.get(EmailChallenge, proof["challengeId"])).consumed_at)
            self.assertIsNone((await session.get(models.Client, "email-device-2")).user_ref)

    async def test_legacy_username_login_retained_without_silent_creation(self):
        async with SessionLocal() as session:
            session.add(models.User(username="legacy.employee", password_hash=hash_password("Original-password-123"), is_active=True))
            await session.commit()
        legacy = await self.post("/login", {"account": "legacy.employee", "password": "Original-password-123"})
        self.assertEqual(legacy.status_code, 200, legacy.text)
        unknown = await self.post("/login", {"account": "new.employee", "password": "Original-password-123"})
        self.assertEqual(unknown.status_code, 401)
        async with SessionLocal() as session:
            self.assertEqual(await session.scalar(select(func.count()).select_from(models.User)), 1)

    async def test_password_login_distinguishes_missing_account_and_wrong_password(self):
        async with SessionLocal() as session:
            session.add(models.User(id="password-feedback-user", username="known.employee",
                email="known@example.test", email_normalized="known@example.test",
                email_verified_at=email_auth.now(), password_hash=hash_password("Original-password-123"),
                is_active=True))
            await session.commit()
        for route, key, known, missing in (
            ("/login/password", "email", "known@example.test", "missing@example.test"),
            ("/login", "account", "known.employee", "missing.employee"),
        ):
            for account, code, message in (
                (missing, "ACCOUNT_NOT_FOUND", "未找到该账号，请检查输入是否正确。"),
                (known, "PASSWORD_INCORRECT", "密码不正确，请重新输入。"),
            ):
                with self.subTest(route=route, code=code):
                    response = await self.post(route, {key: account, "password": "Wrong-password"})
                    self.assertEqual(response.status_code, 401, response.text)
                    self.assertEqual(response.json()["detail"], {"code": code, "message": message})
                    async with SessionLocal() as session:
                        budget = await session.get(EmailRateLimit,
                            email_auth._digest("account-rate\0password-account:" + account))
                        self.assertEqual(budget.count, 1)
        async with SessionLocal() as session:
            self.assertEqual(await session.scalar(select(func.count()).select_from(models.User)), 1)
            device = await session.get(models.Client, "email-device-1")
            self.assertEqual(device.auth_state, "pending")
            self.assertIsNone(device.user_ref)
            user = await session.get(models.User, "password-feedback-user")
            self.assertTrue(verify_password("Original-password-123", user.password_hash))

    async def test_email_shaped_legacy_username_password_login_without_otp_takeover(self):
        address = "legacy.person@example.test"
        async with SessionLocal() as session:
            session.add(models.User(id="legacy-email-name", username=address,
                password_hash=hash_password("Old-account-password"), is_active=True))
            await session.commit()
        wrong = await self.post("/login/password", {"email": address, "password": "Wrong-password"})
        self.assertEqual(wrong.status_code, 401, wrong.text)
        signed_in = await self.post("/login/password", {
            "email": address.upper(), "password": "Old-account-password"})
        self.assertEqual(signed_in.status_code, 200, signed_in.text)
        self.assertEqual(signed_in.json()["user"]["id"], "legacy-email-name")
        self.assertFalse(signed_in.json()["user"]["emailVerified"])
        self.assertFalse(signed_in.json()["created"])

        # A previously issued proof must not survive removal of the verified
        # binding or promote the remaining legacy username into email ownership.
        async with SessionLocal() as session:
            await session.execute(update(models.User).where(models.User.id == "legacy-email-name")
                                  .values(email=address, email_normalized=address, email_verified_at=email_auth.now()))
            await session.commit()
        login_proof = await self.proof(address, "login", 2)
        async with SessionLocal() as session:
            await session.execute(update(models.User).where(models.User.id == "legacy-email-name")
                                  .values(email=None, email_normalized=None, email_verified_at=None))
            await session.commit()
        code_login = await self.post("/login/email-code", login_proof, 2)
        self.assertEqual(code_login.status_code, 404, code_login.text)
        reset_proof = await self.proof(address, "reset_password", 2)
        reset = await self.post("/password/reset", {
            **reset_proof, "newPassword": "Email-holder-password"}, 2)
        self.assertEqual(reset.status_code, 401, reset.text)
        async with SessionLocal() as session:
            user = await session.get(models.User, "legacy-email-name")
            self.assertIsNone(user.email_normalized)
            self.assertIsNone(user.email_verified_at)
            self.assertTrue(verify_password("Old-account-password", user.password_hash))
            self.assertEqual(await session.scalar(select(func.count()).select_from(models.User)), 1)
            other_device = await session.get(models.Client, "email-device-2")
            self.assertEqual(other_device.auth_state, "pending")
            self.assertIsNone(other_device.user_ref)

    async def test_current_verified_email_wins_over_a_colliding_legacy_username(self):
        registered, _ = await self.register()
        uid = registered["user"]["id"]
        async with SessionLocal() as session:
            await session.execute(update(models.User).where(models.User.id == uid).values(username="canonical-owner"))
            session.add(models.User(id="legacy-collision", username="person@example.test", is_active=True,
                password_hash=hash_password("Legacy-password-456")))
            await session.commit()
        for route, key in (("/login/password", "email"), ("/login", "account")):
            with self.subTest(route=route):
                wrong = await self.post(route, {key: "person@example.test", "password": "Legacy-password-456"})
                self.assertEqual(wrong.status_code, 401, wrong.text)
                current = await self.post(route, {key: "person@example.test", "password": "Original-password-123"})
                self.assertEqual(current.status_code, 200, current.text)
                self.assertEqual(current.json()["user"]["id"], uid)
        proof = await self.proof("PERSON@EXAMPLE.TEST", "login", 2)
        code_login = await self.post("/login/email-code", proof, 2)
        self.assertEqual(code_login.status_code, 200, code_login.text)
        self.assertEqual(code_login.json()["user"]["id"], uid)
        async with SessionLocal() as session:
            await session.execute(update(models.User).where(models.User.id == uid).values(is_active=False))
            await session.commit()
        for route, key in (("/login/password", "email"), ("/login", "account")):
            with self.subTest(route=route, disabled=True):
                wrong = await self.post(route, {key: "person@example.test", "password": "Legacy-password-456"})
                self.assertEqual(wrong.status_code, 401, wrong.text)
                disabled = await self.post(route, {key: "person@example.test", "password": "Original-password-123"})
                self.assertEqual(disabled.status_code, 403, disabled.text)

    async def test_non_email_legacy_username_survives_a_verified_email_binding(self):
        registered, _ = await self.register()
        uid = registered["user"]["id"]
        async with SessionLocal() as session:
            await session.execute(update(models.User).where(models.User.id == uid).values(username="employee@internal"))
            await session.commit()
        response = await self.post("/login", {"account": "employee@internal", "password": "Original-password-123"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["user"]["id"], uid)

    async def test_email_shaped_legacy_account_cannot_be_taken_over_by_registration(self):
        async with SessionLocal() as session:
            session.add(models.User(username="person@example.test", password_hash=hash_password("Old-account-password"), is_active=True))
            await session.commit()
        proof = await self.proof()
        response = await self.post("/register", {**proof, "password": "New-password-123", "consents": required_versions()})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["detail"]["code"], "LEGACY_EMAIL_BINDING_REQUIRED")
        async with SessionLocal() as session:
            user = await client_access.find_user(session, "person@example.test")
            self.assertIsNone(user.email_verified_at)
            self.assertTrue(verify_password("Old-account-password", user.password_hash))

    async def test_code_is_bound_to_purpose_device_and_email(self):
        proof = await self.proof()
        wrong_purpose = await self.post("/login/email-code", proof)
        wrong_device = await self.post("/register", {**proof, "password": "Original-password-123", "consents": required_versions()}, 2)
        wrong_email = await self.post("/register", {**proof, "email": "other@example.test", "password": "Original-password-123", "consents": required_versions()})
        self.assertEqual([wrong_purpose.status_code, wrong_device.status_code, wrong_email.status_code], [400, 400, 400])
        good = await self.post("/register", {**proof, "password": "Original-password-123", "consents": required_versions()})
        self.assertEqual(good.status_code, 200, good.text)

    async def test_five_wrong_guesses_lock_proof_even_after_http_rollback(self):
        proof = await self.proof()
        wrong = "000000" if proof["code"] != "000000" else "000001"
        for _ in range(5):
            response = await self.post("/register", {**proof, "code": wrong, "password": "Original-password-123", "consents": required_versions()})
            self.assertEqual(response.status_code, 400)
        good = await self.post("/register", {**proof, "password": "Original-password-123", "consents": required_versions()})
        self.assertEqual(good.status_code, 400)
        async with SessionLocal() as session:
            self.assertEqual((await session.get(EmailChallenge, proof["challengeId"])).attempts, 5)

    async def test_expired_proof_is_rejected(self):
        proof = await self.proof()
        async with SessionLocal() as session:
            await session.execute(update(EmailChallenge).values(expires_at=email_auth.now() - timedelta(seconds=1)))
            await session.commit()
        response = await self.post("/register", {**proof, "password": "Original-password-123", "consents": required_versions()})
        self.assertEqual(response.status_code, 400)

    async def test_concurrent_consumption_has_exactly_one_winner(self):
        proof = await self.proof()
        async def attempt():
            async with SessionLocal() as session:
                try:
                    await email_auth.consume_challenge(session, challenge_id=proof["challengeId"], email=proof["email"],
                        purpose="register", device_id="email-device-1", code=proof["code"])
                    await session.commit()
                    return "ok"
                except client_access.ClientAccessError:
                    return "invalid"
        self.assertCountEqual(await asyncio.gather(attempt(), attempt()), ["ok", "invalid"])

    async def test_concurrent_send_uses_database_cooldown(self):
        responses = await asyncio.gather(*[self.post("/email-challenges", {"email": "person@example.test", "purpose": "register"}) for _ in range(3)])
        self.assertCountEqual([r.status_code for r in responses], [200, 429, 429])
        async with SessionLocal() as session:
            self.assertEqual(await session.scalar(select(func.count()).select_from(MailOutbox)), 1)

    async def test_resend_invalidates_old_proof(self):
        first = await self.proof()
        async with SessionLocal() as session:
            await session.execute(update(EmailRateLimit).values(expires_at=email_auth.now() - timedelta(seconds=1)))
            await session.commit()
        second = await self.proof()
        old = await self.post("/register", {**first, "password": "Original-password-123", "consents": required_versions()})
        self.assertEqual(old.status_code, 400)
        good = await self.post("/register", {**second, "password": "Original-password-123", "consents": required_versions()})
        self.assertEqual(good.status_code, 200, good.text)

    async def test_password_reset_revokes_all_devices_and_old_password(self):
        first, _ = await self.register()
        second = await self.post("/login/password", {"email": "person@example.test", "password": "Original-password-123"}, 2)
        async with SessionLocal() as session:
            session.add(models.Client(id="blocked-device", user_ref=first["user"]["id"],
                secret_hash=device_auth.hash_secret("blocked-key"), auth_state="revoked", auth_version=2))
            await session.commit()
        proof = await self.proof(purpose="reset_password")
        reset = await self.post("/password/reset", {**proof, "newPassword": "Changed-password-456"})
        self.assertEqual(reset.status_code, 200, reset.text)
        self.assertEqual(reset.json()["signedOutDevices"], 2)
        async with SessionLocal() as session:
            blocked = await session.get(models.Client, "blocked-device")
            self.assertEqual(blocked.auth_state, "revoked")
            self.assertEqual(blocked.auth_version, 2)
        for token in (first["session"], second.json()["session"]):
            response = await self.http.get("/api/v1/client-auth/me", headers={"Authorization": "Device " + token})
            self.assertIn(response.status_code, (401, 403))
        old = await self.post("/login/password", {"email": "person@example.test", "password": "Original-password-123"})
        self.assertEqual(old.status_code, 401)
        new = await self.post("/login/password", {"email": "person@example.test", "password": "Changed-password-456"})
        self.assertEqual(new.status_code, 200, new.text)

    async def test_disabled_registration_and_sensitive_public_purpose_rejected(self):
        async with SessionLocal() as session:
            await client_access.update_policy(session, {"allowSelfRegistration": False})
        blocked = await self.post("/email-challenges", {"email": "person@example.test", "purpose": "register"})
        sensitive = await self.post("/email-challenges", {"email": "person@example.test", "purpose": "reauthentication"})
        self.assertEqual(blocked.status_code, 403)
        self.assertEqual(sensitive.status_code, 422)

    async def test_deleted_account_cannot_be_restored_by_active_flag(self):
        registered, _ = await self.register()
        async with SessionLocal() as session:
            user = await session.get(models.User, registered["user"]["id"])
            user.account_deleted_at = email_auth.now()
            user.is_active = True  # Simulate an administrator accidentally toggling this flag.
            await session.commit()
            token = sign_token(user.id, user.auth_version)
            with self.assertRaises(Exception) as caught:
                await current_user(authorization="Bearer " + token, session=session)
            self.assertEqual(caught.exception.status_code, 401)
        me = await self.http.get("/api/v1/client-auth/me", headers={"Authorization": "Device " + registered["session"]})
        self.assertEqual(me.status_code, 403)
        renewal = await self.http.post("/api/v1/clients/enroll", headers={"X-Device-Key": "1" * 48},
            json={"device": "email-device-1"})
        self.assertEqual(renewal.status_code, 403)
        login = await self.post("/login/password", {"email": "person@example.test", "password": "Original-password-123"})
        self.assertEqual(login.status_code, 403)

    async def test_login_rechecks_credentials_changed_during_authentication(self):
        registered, _ = await self.register()
        async with SessionLocal() as stale:
            user = await stale.get(models.User, registered["user"]["id"])
            client = await stale.get(models.Client, "email-device-1")
            async with SessionLocal() as revoker:
                await revoker.execute(update(models.User).where(models.User.id == user.id)
                    .values(auth_version=models.User.auth_version + 1))
                await revoker.commit()
            with self.assertRaises(client_access.ClientAccessError) as caught:
                await client_auth.complete_login(stale, client, user,
                    client_email_auth.DeviceEmail(device=client.id, email=user.email))
            self.assertEqual(caught.exception.code, "ACCOUNT_AUTH_CHANGED")
            await stale.rollback()
        async with SessionLocal() as stale:
            user = await stale.get(models.User, registered["user"]["id"])
            client = await stale.get(models.Client, "email-device-1")
            async with SessionLocal() as revoker:
                await revoker.execute(update(models.Client).where(models.Client.id == client.id)
                    .values(auth_state="revoked"))
                await revoker.commit()
            with self.assertRaises(client_access.ClientAccessError) as caught:
                await client_auth.complete_login(stale, client, user,
                    client_email_auth.DeviceEmail(device=client.id, email=user.email))
            self.assertEqual(caught.exception.code, "DEVICE_AUTH_FAILED")

    async def test_password_change_does_not_overwrite_concurrent_reset(self):
        registered, _ = await self.register()
        original = email_auth.password_budget
        async def reset_after_budget(session, account, device_id):
            await original(session, account, device_id)
            async with SessionLocal() as other:
                await other.execute(update(models.User).where(models.User.id == registered["user"]["id"])
                    .values(password_hash=hash_password("Concurrent-reset-password"),
                            auth_version=models.User.auth_version+1))
                await other.commit()
        with patch.object(email_auth, "password_budget", side_effect=reset_after_budget):
            response = await self.http.post("/api/v1/client-auth/change-password",
                headers={"Authorization": "Device " + registered["session"]},
                json={"currentPassword":"Original-password-123", "newPassword":"Stale-password-change"})
        self.assertEqual(response.status_code, 401, response.text)
        async with SessionLocal() as session:
            user = await session.get(models.User, registered["user"]["id"])
            self.assertTrue(verify_password("Concurrent-reset-password", user.password_hash))

    async def test_logout_preserves_concurrent_administrator_revocation(self):
        await self.register()
        original = client_auth._device_with_key
        async def revoke_after_validation(session, device_id, key):
            client = await original(session, device_id, key)
            async with SessionLocal() as admin:
                await admin.execute(update(models.Client).where(models.Client.id == device_id)
                    .values(auth_state="revoked", auth_version=models.Client.auth_version+1))
                await admin.commit()
            return client
        with patch.object(client_auth, "_device_with_key", side_effect=revoke_after_validation):
            response = await self.post("/logout", {})
        self.assertEqual(response.status_code, 403, response.text)
        async with SessionLocal() as session:
            self.assertEqual((await session.get(models.Client, "email-device-1")).auth_state, "revoked")

    async def test_reset_disconnects_only_devices_it_actually_unbound(self):
        registered, _ = await self.register()
        async with SessionLocal() as session:
            session.add(models.User(id="other-owner", username="other-owner", is_active=True))
            await session.execute(update(models.Client).where(models.Client.id == "email-device-2")
                .values(user_ref=registered["user"]["id"], auth_state="active"))
            await session.commit()
        proof = await self.proof(purpose="reset_password")
        original_execute = AsyncSession.execute
        moved = False
        async def transfer_at_device_write(session, statement, *args, **kwargs):
            nonlocal moved
            if (not moved and getattr(statement, "is_update", False)
                    and getattr(getattr(statement, "table", None), "name", "") == models.Client.__tablename__):
                # Simulate ownership changing after the reset's reads, immediately before
                # its device write. SQLite serializes writers; this controls that boundary.
                moved = True
                await original_execute(session, update(models.Client).where(models.Client.id == "email-device-2")
                    .values(user_ref="other-owner", auth_version=models.Client.auth_version+1))
            return await original_execute(session, statement, *args, **kwargs)
        with patch.object(AsyncSession, "execute", new=transfer_at_device_write), \
                patch.object(device_connections, "disconnect", new_callable=AsyncMock) as disconnect:
            response = await self.post("/password/reset", {**proof, "newPassword":"Changed-password-456"})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertTrue(moved)
            self.assertEqual(response.json()["signedOutDevices"], 1)
            disconnect.assert_awaited_once_with("email-device-1", 4401)
        async with SessionLocal() as session:
            moved_device = await session.get(models.Client, "email-device-2")
            self.assertEqual(moved_device.user_ref, "other-owner")
            self.assertEqual(moved_device.auth_state, "active")


if __name__ == "__main__":
    unittest.main()
