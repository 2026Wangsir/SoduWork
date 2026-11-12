# -*- coding: utf-8 -*-
"""Plugin audience HTTP smoke; isolated database and full cleanup."""
import asyncio
from datetime import datetime, timedelta, timezone
import os
import shutil
import sys
import tempfile

import httpx
from sqlalchemy import delete, select

sys.path.insert(0, ".")
_TEMP = tempfile.TemporaryDirectory(prefix="soduwork-smoke-plugin-audience-")
DB = os.path.join(_TEMP.name, "test.db")
DATA = os.path.join(_TEMP.name, "data")
for suffix in ("", "-shm", "-wal"):
    try: os.remove(DB + suffix)
    except FileNotFoundError: pass
shutil.rmtree(DATA, ignore_errors=True)
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
os.environ["SODUWORK_DATA_ROOT"] = DATA

from app import auth, automation_models as am, models  # noqa: E402
from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.main import app  # noqa: E402
from app.services import device_auth, plugin_audience, plugin_mcp_gateway  # noqa: E402

ORG = "o-smoke-plugin-audience"
ORG_CHILD, ORG_SIBLING = "o-smoke-plugin-child", "o-smoke-plugin-sibling"
USER_A, USER_B = "u-smoke-plugin-a", "u-smoke-plugin-b"
USER_C, USER_D = "u-smoke-plugin-c", "u-smoke-plugin-d"
CLIENT_A, CLIENT_B = "c-smoke-plugin-a", "c-smoke-plugin-b"
CLIENT_C, CLIENT_D = "c-smoke-plugin-c", "c-smoke-plugin-d"
PLUGIN, VERSION, BINDING = "p-smoke-audience", "v-smoke-audience", "b-smoke-audience"
TEAM_PLUGIN, TEAM_VERSION = "p-smoke-team", "v-smoke-team"
TEAM_BINDING = "b-smoke-team"
TOKENS = {}
passed = failed = 0


def check(name, condition, extra=""):
    global passed, failed
    if condition: passed += 1
    else:
        failed += 1
        print("FAIL", name, str(extra)[:500])


def headers(key): return {"Authorization": "Device " + TOKENS[key]}


async def purge():
    async with SessionLocal() as session:
        await session.execute(delete(models.AuditLog).where(
            models.AuditLog.action.in_([
                "plugin.conversation_use", "plugin.personal_publish",
                "plugin.approve", "plugin.reject", "plugin.revoke",
            ])))
        await session.execute(delete(am.PluginInstallation).where(
            am.PluginInstallation.user_id.in_(
                [USER_A, USER_B, USER_C, USER_D])))
        await session.execute(delete(am.PluginAudience).where(am.PluginAudience.org_id == ORG))
        await session.execute(delete(am.PluginBinding).where(am.PluginBinding.org_id == ORG))
        plugin_ids = list((await session.execute(select(am.Plugin.id).where(
            am.Plugin.org_id == ORG))).scalars().all())
        if plugin_ids:
            await session.execute(delete(am.PluginVersion).where(
                am.PluginVersion.plugin_id.in_(plugin_ids)))
            await session.execute(delete(am.Plugin).where(am.Plugin.id.in_(plugin_ids)))
        await session.execute(delete(models.Client).where(
            models.Client.id.in_([CLIENT_A, CLIENT_B, CLIENT_C, CLIENT_D])))
        await session.execute(delete(models.User).where(
            models.User.id.in_([USER_A, USER_B, USER_C, USER_D])))
        await session.execute(delete(models.OrgUnit).where(
            models.OrgUnit.id.in_([ORG_CHILD, ORG_SIBLING, ORG])))
        await session.commit()


async def seed():
    await purge()
    async with SessionLocal() as session:
        session.add_all([
            models.OrgUnit(id=ORG, name="Audience organization"),
            models.OrgUnit(id=ORG_CHILD, name="Product team", parent_id=ORG),
            models.OrgUnit(id=ORG_SIBLING, name="Operations team", parent_id=ORG),
        ])
        session.add_all([
            models.User(id=USER_A, username="audience-a", display_name="Member A",
                        org_id=ORG, is_active=True, is_super=True),
            models.User(id=USER_B, username="audience-b", display_name="Member B",
                        org_id=ORG, is_active=True),
            models.User(id=USER_C, username="audience-c", display_name="Member C",
                        org_id=ORG_CHILD, is_active=True),
            models.User(id=USER_D, username="audience-d", display_name="Member D",
                        org_id=ORG_SIBLING, is_active=True),
            models.Client(id=CLIENT_A, name="Client A", auth_state="active", user_ref=USER_A),
            models.Client(id=CLIENT_B, name="Client B", auth_state="active", user_ref=USER_B),
            models.Client(id=CLIENT_C, name="Client C", auth_state="active", user_ref=USER_C),
            models.Client(id=CLIENT_D, name="Client D", auth_state="active", user_ref=USER_D),
            am.Plugin(id=PLUGIN, org_id=ORG, key="restricted-method", name="Restricted method",
                      description="Only selected members", enabled=True, source_kind="soduwork"),
            am.PluginVersion(id=VERSION, plugin_id=PLUGIN, version="1.0.0",
                             checksum="audience-checksum", manifest={"name": "Restricted method"},
                             workflow={"nodes": [{"key": "work", "type": "ai", "name": "Work"}]},
                             capability_report={}, trust_state="approved", visibility="users",
                             enabled=True),
            am.PluginAudience(plugin_id=PLUGIN, version_id=VERSION, org_id=ORG,
                              principal_type="user", principal_id=USER_A),
            am.PluginBinding(id=BINDING, plugin_id=PLUGIN, version_id=VERSION,
                             org_id=ORG, project_id="", enabled=True),
            am.PluginInstallation(
                plugin_id=PLUGIN, version_id=VERSION, user_id=USER_A,
                enabled=True),
            am.Plugin(id=TEAM_PLUGIN, org_id=ORG, key="team-method", name="Team method",
                      description="Only one team", enabled=True, source_kind="soduwork"),
            am.PluginVersion(
                id=TEAM_VERSION, plugin_id=TEAM_PLUGIN, version="1.0.0",
                checksum="team-audience-checksum", manifest={"name": "Team method"},
                workflow={"nodes": [{"key": "work", "type": "ai", "name": "Work"}]},
                capability_report={}, trust_state="approved", visibility="org_units",
                enabled=True),
            am.PluginAudience(
                plugin_id=TEAM_PLUGIN, version_id=TEAM_VERSION, org_id=ORG,
                principal_type="org_unit", principal_id=ORG_CHILD),
            am.PluginBinding(
                id=TEAM_BINDING, plugin_id=TEAM_PLUGIN, version_id=TEAM_VERSION,
                org_id=ORG, project_id="", enabled=True),
            am.PluginInstallation(
                plugin_id=TEAM_PLUGIN, version_id=TEAM_VERSION, user_id=USER_C,
                enabled=True),
        ])
        await session.commit()
        TOKENS["a"] = device_auth.issue_session(await session.get(models.Client, CLIENT_A))[0]
        TOKENS["b"] = device_auth.issue_session(await session.get(models.Client, CLIENT_B))[0]
        TOKENS["c"] = device_auth.issue_session(await session.get(models.Client, CLIENT_C))[0]
        TOKENS["d"] = device_auth.issue_session(await session.get(models.Client, CLIENT_D))[0]


async def main():
    await init_db(); await seed()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        people = await client.get("/api/v1/plugins/audience-candidates", headers=headers("a"))
        body = people.json() if people.status_code == 200 else {}
        ids = {row.get("id") for row in body.get("items", [])}
        org_ids = {row.get("id") for row in body.get("orgUnits", [])}
        check("publisher can select active members and teams in its organization subtree",
              people.status_code == 200
              and ids == {USER_A, USER_B, USER_C, USER_D}
              and org_ids == {ORG, ORG_CHILD, ORG_SIBLING}, people.text)

        catalog_a = await client.get("/api/v1/plugins/catalog", headers=headers("a"))
        catalog_b = await client.get("/api/v1/plugins/catalog", headers=headers("b"))
        items_a = catalog_a.json().get("items", []) if catalog_a.status_code == 200 else []
        items_b = catalog_b.json().get("items", []) if catalog_b.status_code == 200 else []
        check("selected member discovers restricted plugin",
              any(row.get("pluginId") == PLUGIN and row.get("audienceLimited") for row in items_a),
              catalog_a.text)
        check("unselected member cannot discover restricted plugin",
              not any(row.get("pluginId") == PLUGIN for row in items_b), catalog_b.text)

        resolved_a = await client.post("/api/v1/plugins/conversation-context", headers=headers("a"),
                                       json={"pluginIds": [PLUGIN]})
        resolved_b = await client.post("/api/v1/plugins/conversation-context", headers=headers("b"),
                                       json={"pluginIds": [PLUGIN]})
        check("selected member resolves restricted plugin in conversation",
              resolved_a.status_code == 200 and
              resolved_a.json()["items"][0].get("scopeLabel") == "指定人员授权",
              resolved_a.text)
        check("guessed plugin id cannot bypass audience",
              resolved_b.status_code == 409, resolved_b.text)

        catalog_c = await client.get("/api/v1/plugins/catalog", headers=headers("c"))
        catalog_d = await client.get("/api/v1/plugins/catalog", headers=headers("d"))
        check("child-team member inherits parent-published team plugin",
              catalog_c.status_code == 200 and any(
                  row.get("pluginId") == TEAM_PLUGIN
                  and row.get("audienceLabel") == "指定团队"
                  for row in catalog_c.json().get("items", [])), catalog_c.text)
        check("unselected sibling team cannot discover team plugin",
              catalog_d.status_code == 200 and not any(
                  row.get("pluginId") == TEAM_PLUGIN
                  for row in catalog_d.json().get("items", [])), catalog_d.text)

        resolved_c = await client.post(
            "/api/v1/plugins/conversation-context", headers=headers("c"),
            json={"pluginIds": [TEAM_PLUGIN]})
        resolved_d = await client.post(
            "/api/v1/plugins/conversation-context", headers=headers("d"),
            json={"pluginIds": [TEAM_PLUGIN]})
        check("child-team member resolves inherited plugin in conversation",
              resolved_c.status_code == 200
              and resolved_c.json()["items"][0].get("scopeLabel") == "团队授权",
              resolved_c.text)
        check("guessed team plugin id cannot bypass department audience",
              resolved_d.status_code == 409, resolved_d.text)

        async with SessionLocal() as session:
            await plugin_mcp_gateway.validate_bindings(
                session, await session.get(models.Client, CLIENT_C), [TEAM_BINDING])
            check("connector grant accepts inherited parent binding for selected child team", True)
            try:
                await plugin_mcp_gateway.validate_bindings(
                    session, await session.get(models.Client, CLIENT_D), [TEAM_BINDING])
            except ValueError:
                check("connector grant rejects unselected sibling team", True)
            else:
                check("connector grant rejects unselected sibling team", False)

        draft = {"template": "method", "name": "Personal published method", "version": "0.1.0",
                 "description": "Explicit personal upload", "instructions": "Produce and verify result."}
        uploaded = await client.post("/api/v1/plugins/personal-publish", headers=headers("a"),
                                     json={"draft": draft, "visibility": "users",
                                           "userIds": [USER_B]})
        check("personal upload persists planned selected-member audience",
              uploaded.status_code == 200 and uploaded.json().get("audienceCount") == 1,
              uploaded.text)
        submitted_version_id = dict(
            uploaded.json().get("plugin") or {}).get("latestVersion", {}).get("id")
        team_draft = {
            "template": "method", "name": "Personal team method", "version": "0.1.0",
            "description": "Explicit team upload",
            "instructions": "Produce and verify a team result.",
        }
        team_uploaded = await client.post(
            "/api/v1/plugins/personal-publish", headers=headers("a"),
            json={"draft": team_draft, "visibility": "org_units",
                  "orgUnitIds": [ORG_CHILD]})
        check("personal upload persists planned team audience",
              team_uploaded.status_code == 200
              and team_uploaded.json().get("audienceCount") == 1,
              team_uploaded.text)
        async with SessionLocal() as session:
            version = await session.get(am.PluginVersion, submitted_version_id)
            audience = list((await session.execute(select(am.PluginAudience).where(
                am.PluginAudience.version_id == version.id))).scalars().all()) if version else []
            check("quarantined immutable version stores only chosen member ids",
                   version is not None and version.visibility == "users"
                   and version.trust_state == "quarantined"
                   and [row.principal_id for row in audience] == [USER_B], audience)
            member_rows = await plugin_audience.members(session, VERSION)
            check("management audience details resolve exact members without leaking through catalog",
                  member_rows == [{
                      "id": USER_A, "name": "Member A", "username": "audience-a",
                      "active": True, "type": "user",
                  }], member_rows)
            team_member_rows = await plugin_audience.members(session, TEAM_VERSION)
            check("management audience details resolve exact team principals",
                  team_member_rows == [{
                      "id": ORG_CHILD, "name": "Product team", "username": "",
                      "active": True, "type": "org_unit",
                   }], team_member_rows)

        rejected = await client.post(
            "/api/v1/admin/plugins/versions/" + submitted_version_id + "/trust",
            headers={"Authorization": "Bearer " + auth.sign_token(USER_A, ttl_hours=1)},
            json={"enabled": False, "note": "补齐异常路径、失败回退和可验收证据"})
        check("administrator can reject a quarantined version with actionable feedback",
              rejected.status_code == 200
              and rejected.json().get("trustState") == "revoked", rejected.text)
        reviewed_catalog = await client.get(
            "/api/v1/plugins/catalog", headers=headers("a"))
        submissions = (reviewed_catalog.json().get("submissions", [])
                       if reviewed_catalog.status_code == 200 else [])
        reviewed = next((row for row in submissions
                         if row.get("pluginId") ==
                         uploaded.json().get("plugin", {}).get("id")), {})
        check("publisher receives rejection reason, reviewer and timestamp in client catalog",
              reviewed.get("reviewDecision") == "reject"
              and reviewed.get("reviewNote") == "补齐异常路径、失败回退和可验收证据"
              and reviewed.get("reviewedBy") == "Member A"
              and int(reviewed.get("reviewedAt") or 0) > 0,
              reviewed_catalog.text)
        first_review = reviewed.get("reviewHistory", [])
        check("the first review is retained as a public event on its exact version",
              len(first_review) == 1
              and first_review[0].get("decision") == "reject"
              and first_review[0].get("note") == reviewed.get("reviewNote")
              and first_review[0].get("reviewedAt") == reviewed.get("reviewedAt"),
              first_review)

        review_at = datetime.now(timezone.utc) + timedelta(seconds=1)
        plugin_id = uploaded.json().get("plugin", {}).get("id")
        original_review_id = first_review[0]["id"] if first_review else "missing-review"
        review_ids = ["history-02-revoke", "history-01-approve", original_review_id]
        async with SessionLocal() as session:
            version = await session.get(am.PluginVersion, submitted_version_id)
            original_audit = await session.get(models.AuditLog, original_review_id)
            original_detail = dict(original_audit.detail or {}) if original_audit else {}
            session.add_all([
                am.PluginVersion(
                    id="history-own-v2", plugin_id=plugin_id, version="0.2.0",
                    checksum="history-own-v2", created_by=USER_A,
                    manifest={**version.manifest, "version": "0.2.0"},
                    created_at=review_at + timedelta(seconds=1)),
                am.PluginVersion(
                    id="history-other-v3", plugin_id=plugin_id, version="0.3.0",
                    checksum="history-other-v3", created_by=USER_B,
                    manifest={**version.manifest, "version": "0.3.0"},
                    created_at=review_at + timedelta(seconds=2)),
                *[models.AuditLog(
                    id=event_id, actor_id=USER_A, actor_name="Member A", actor_org_id=ORG,
                    action="plugin." + decision, target_type="plugin_version",
                    target_id=submitted_version_id, at=review_at,
                    detail={"decision": decision, "note": note,
                            "privateContext": {"packagePath": "fixture-private-path"}},
                ) for event_id, decision, note in (
                    ("history-01-approve", "approve", "Approved after review"),
                    ("history-02-revoke", "revoke", "Publication withdrawn"),
                )],
                models.AuditLog(
                    id="history-other-review", actor_id=USER_A, actor_name="Member A",
                    actor_org_id=ORG, action="plugin.reject", target_type="plugin_version",
                    target_id="history-other-v3", at=review_at,
                    detail={"note": "Other publisher's feedback"}),
                models.AuditLog(
                    id="history-unrelated-event", actor_id=USER_A, actor_name="Member A",
                    actor_org_id=ORG, action="plugin.evaluation_review",
                    target_type="plugin_version", target_id=submitted_version_id,
                    at=review_at, detail={"note": "Internal evaluation detail"}),
            ])
            await session.commit()

        history_response = await client.get("/api/v1/plugins/catalog", headers=headers("a"))
        own_receipts = [row for row in history_response.json().get("submissions", [])
                        if row["pluginId"] == plugin_id]
        check("each own submitted version remains visible without another publisher's version",
              [row["versionId"] for row in own_receipts] == ["history-own-v2", submitted_version_id],
              own_receipts)
        old_receipt = next((row for row in own_receipts
                            if row["versionId"] == submitted_version_id), {})
        history = old_receipt.get("reviewHistory", [])
        check("all reviews survive a newer submission with stable ordering for equal timestamps",
              [row.get("id") for row in history] == review_ids
              and [row.get("decision") for row in history] == ["revoke", "approve", "reject"]
              and old_receipt.get("reviewDecision") == "revoke"
              and old_receipt.get("reviewNote") == "Publication withdrawn",
              old_receipt)
        check("review history only exposes public feedback fields",
              all(set(row) == {"id", "decision", "note", "reviewedAt", "reviewedBy"}
                  for row in history)
              and "fixture-private-path" not in history_response.text
              and "Internal evaluation detail" not in history_response.text,
              history)
        check("unreviewed versions have an empty history and no inherited review summary",
              own_receipts[0].get("reviewHistory") == []
              and own_receipts[0].get("reviewDecision") == ""
              and own_receipts[0].get("reviewNote") == ""
              and own_receipts[0].get("reviewedAt") == 0,
              own_receipts)
        other_response = await client.get("/api/v1/plugins/catalog", headers=headers("b"))
        other_receipts = [row for row in other_response.json().get("submissions", [])
                          if row["pluginId"] == plugin_id]
        check("another publisher only receives their own exact version and feedback",
              [row["versionId"] for row in other_receipts] == ["history-other-v3"]
              and [row["id"] for row in other_receipts[0]["reviewHistory"]] == ["history-other-review"],
              other_receipts)
        async with SessionLocal() as session:
            original_audit = await session.get(models.AuditLog, original_review_id)
            check("reading newer versions never rewrites an earlier review audit",
                  original_audit is not None and original_audit.detail == original_detail)
            author = await session.get(models.User, USER_A)
            author.org_id = ORG_CHILD
            await session.commit()
        changed_org = await client.get("/api/v1/plugins/catalog", headers=headers("a"))
        check("changing the current organization does not expose previous organization submissions",
              changed_org.status_code == 200 and changed_org.json().get("submissions") == [],
              changed_org.text)
        async with SessionLocal() as session:
            author = await session.get(models.User, USER_A)
            author.org_id = ORG
            await session.commit()


async def guarded():
    try: await main()
    finally:
        await purge(); await engine.dispose()


asyncio.run(guarded())
print("PASS=%d FAIL=%d" % (passed, failed))
for suffix in ("", "-shm", "-wal"):
    try: os.remove(DB + suffix)
    except FileNotFoundError: pass
shutil.rmtree(DATA, ignore_errors=True)
sys.exit(1 if failed else 0)
