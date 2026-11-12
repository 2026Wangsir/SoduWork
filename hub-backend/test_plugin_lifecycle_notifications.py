"""Plugin unpublish/revoke notices use the durable, scoped employee inbox."""
import os
import secrets
import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ.setdefault("AUTH_SECRET", secrets.token_hex(32))
os.environ.setdefault("ADMIN_PASS", secrets.token_hex(24))

from fastapi import HTTPException
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import automation_models as am, models, realtime
from app.api import plugins
from app.services import mate_messages, plugin_lifecycle_notifications as notices
from tests.sqlite_schema import create_fresh_sqlite_schema


class PluginLifecycleNotificationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.addAsyncCleanup(self.engine.dispose)
        async with self.engine.begin() as connection:
            await create_fresh_sqlite_schema(connection, models.Base.metadata)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        self.session = self.sessions()
        self.addAsyncCleanup(self.session.close)
        self.session.add_all([
            models.OrgUnit(id="company", name="Company"),
            models.OrgUnit(id="publisher-team", name="Publisher team", parent_id="company"),
            models.OrgUnit(id="consumer-team", name="Consumer team", parent_id="company"),
            models.OrgUnit(id="outside-company", name="Other company"),
            *[models.User(id=uid, username=uid, org_id=org, is_active=uid != "disabled",
                          is_super=uid == "admin") for uid, org in (
                ("admin", "company"), ("publisher", "publisher-team"),
                ("consumer", "consumer-team"), ("older-consumer", "consumer-team"),
                ("uninstalled", "consumer-team"), ("other", "consumer-team"),
                ("outside", "outside-company"), ("disabled", "consumer-team"))],
            *[models.Client(id="device-" + uid, user_ref=uid, auth_state="active") for uid in
              ("admin", "publisher", "consumer", "older-consumer", "uninstalled", "other", "outside", "disabled")],
            models.Client(id="consumer-second-device", user_ref="consumer", auth_state="active"),
            am.Plugin(id="plugin", key="fixture", name="Fixture method", org_id="publisher-team",
                      enabled=True, created_by="publisher"),
            *[am.PluginVersion(id=vid, plugin_id="plugin", version=version, checksum=vid,
                created_by="publisher", trust_state=trust, enabled=enabled,
                manifest={"name": "Fixture method"}) for vid, version, trust, enabled in
              (("old", "1.0.0", "approved", True), ("current", "2.0.0", "approved", True),
               ("pending", "3.0.0", "quarantined", False))],
            *[am.PluginInstallation(plugin_id="plugin", version_id=version, user_id=uid, enabled=enabled)
              for uid, version, enabled in (("consumer", "current", True), ("older-consumer", "old", True),
                  ("publisher", "current", True), ("uninstalled", "current", False),
                  ("outside", "current", True), ("disabled", "current", True))],
        ])
        await self.session.commit()
        self.admin = await self.session.get(models.User, "admin")
        self.publish = AsyncMock()
        patcher = patch.object(realtime.hub, "publish", self.publish)
        patcher.start()
        self.addCleanup(patcher.stop)

    async def policy(self, **body):
        return await plugins.update_catalog_policy("plugin", body, self.admin, self.session)

    async def inbox(self, uid="consumer", **kwargs):
        client = await self.session.get(models.Client, "device-" + uid)
        return await mate_messages.list_for(self.session, client, **kwargs)

    async def all_rows(self):
        return list(await self.session.scalars(select(models.MateMessage)))

    async def test_unpublish_is_durable_for_publishers_and_current_installers_and_retries_deduplicate(self):
        self.publish.side_effect = ConnectionError("isolated transport unavailable")
        await self.policy(installation="not_available")
        await self.policy(installation="not_available")
        await self.policy(category="method")
        rows = await self.all_rows()
        self.assertEqual({row.recipient_id for row in rows}, {"publisher", "consumer", "older-consumer"})
        self.assertEqual(len(rows), 3, "publisher who installed receives one notice")
        # A new HTTP session reads durable notices after a missed socket event.
        async with self.sessions() as reconnected:
            client = await reconnected.get(models.Client, "device-consumer")
            page = await mate_messages.list_for(reconnected, client)
        value = page["items"][0]
        self.assertEqual(value["kind"], "plugin_lifecycle")
        self.assertEqual(value["pluginId"], "plugin")
        self.assertEqual(value["pluginEvent"], "unpublished")
        self.assertEqual(value["pluginVersionId"], "")
        self.assertEqual(value["textMessage"]["key"], "notification.plugin_unpublished")
        self.assertEqual(value["textMessage"]["params"], {"name": "Fixture method"})
        self.assertEqual(value["status"], "accepted")
        self.assertIsNone(value["readAt"])
        self.assertEqual(page["unreadCount"], 1)
        self.assertEqual((await self.inbox("other"))["items"], [])
        self.assertEqual((await self.inbox("outside"))["items"], [])
        self.assertEqual({call.kwargs["user_id"] for call in self.publish.await_args_list},
                         {"publisher", "consumer", "older-consumer"})

    async def test_only_real_transitions_notify_and_a_later_unpublish_is_a_new_event(self):
        await self.policy(category="method", authentication="on_install")
        self.assertEqual(await self.all_rows(), [])
        await self.policy(installation="not_available")
        await self.policy(installation="installed_by_default")
        await self.policy(installation="not_available")
        values = (await self.inbox())["items"]
        self.assertEqual(len(values), 2)
        self.assertEqual(len({value["messageId"] for value in values}), 2)

    async def test_never_published_catalog_policy_does_not_claim_removal(self):
        for version in await self.session.scalars(select(am.PluginVersion)):
            version.enabled = False
            version.trust_state = "quarantined"
        await self.session.commit()
        await self.policy(installation="not_available")
        self.assertEqual(await self.all_rows(), [])

    async def test_stale_policy_identity_map_does_not_repeat_a_transition(self):
        await self.policy(installation="available")
        cached = await self.session.get(am.PluginCatalogPolicy, "plugin")
        async with self.sessions() as other:
            admin = await other.get(models.User, "admin")
            await plugins.update_catalog_policy("plugin", {"installation": "not_available"}, admin, other)
        self.assertEqual(cached.installation, "available", "the first session intentionally has stale ORM data")
        await self.policy(installation="not_available")
        self.assertEqual(len((await self.inbox())["items"]), 1)

    async def test_revoke_targets_affected_version_and_reject_does_not_claim_unpublish(self):
        await plugins.trust_version("current", {"enabled": False}, self.admin, self.session)
        await plugins.trust_version("current", {"enabled": False}, self.admin, self.session)
        await plugins.trust_version("pending", {"enabled": False}, self.admin, self.session)
        rows = await self.all_rows()
        self.assertEqual({row.recipient_id for row in rows}, {"publisher", "consumer"})
        self.assertEqual(len(rows), 2)
        self.assertTrue((await self.session.get(am.Plugin, "plugin")).enabled,
                        "the approved older version remains usable")
        value = (await self.inbox())["items"][0]
        self.assertEqual(value["pluginVersionId"], "current")
        self.assertEqual(value["pluginEvent"], "revoked")
        self.assertEqual(value["textMessage"]["key"], "notification.plugin_version_revoked")
        self.assertEqual(value["textMessage"]["params"], {"name": "Fixture method", "version": "2.0.0"})

    async def test_platform_approval_and_revoke_history_keeps_transition_order(self):
        plugin = await self.session.get(am.Plugin, "plugin")
        plugin.org_id = None
        await self.session.commit()
        await plugins.trust_version("current", {"enabled": True, "confirmWithoutEvaluation": True},
                                    self.admin, self.session)
        await plugins.trust_version("current", {"enabled": False}, self.admin, self.session)
        events = list(await self.session.scalars(select(models.AuditLog).where(
            models.AuditLog.target_id == "current").order_by(models.AuditLog.at)))
        self.assertEqual([row.action for row in events], ["plugin.approve", "plugin.revoke"])
        self.assertLess(events[0].at, events[1].at)

    async def test_org_change_filters_list_revision_unread_cursor_and_ack_but_not_ordinary_mail(self):
        sender = self.admin
        recipient = await self.session.get(models.User, "consumer")
        ordinary = await mate_messages.create(self.session, sender, recipient,
                                              {"messageId": "ordinary"}, "Hello", [])
        await self.session.commit()
        await self.policy(installation="not_available")
        before = await self.inbox()
        lifecycle = next(value for value in before["items"] if value["kind"] == "plugin_lifecycle")
        recipient.org_id = "outside-company"
        await self.session.commit()
        after = await self.inbox(if_revision=before["revision"])
        self.assertFalse(after.get("notModified", False))
        self.assertNotEqual(after["revision"], before["revision"])
        self.assertEqual([value["id"] for value in after["items"]], [ordinary.id])
        self.assertEqual(after["unreadCount"], 1)
        with self.assertRaises(HTTPException) as cursor:
            await self.inbox(before=lifecycle["id"])
        self.assertEqual(cursor.exception.status_code, 400)
        client = await self.session.get(models.Client, "device-consumer")
        for acknowledge in (mate_messages.mark_delivered, mate_messages.mark_read):
            with self.assertRaises(HTTPException) as denied:
                await acknowledge(self.session, client, lifecycle["id"])
            self.assertEqual(denied.exception.status_code, 404)
        self.assertEqual((await mate_messages.mark_read(self.session, client, ordinary.id))["status"], "read")

    async def test_empty_inbox_revision_changes_with_effective_company_scope(self):
        before = await self.inbox("other")
        other = await self.session.get(models.User, "other")
        other.org_id = "outside-company"
        await self.session.commit()
        after = await self.inbox("other", if_revision=before["revision"])
        self.assertEqual(after["items"], [])
        self.assertFalse(after.get("notModified", False))
        self.assertNotEqual(before["revision"], after["revision"])

    async def test_department_reparent_does_not_move_historical_notice_to_another_company(self):
        await self.policy(installation="not_available")
        row = (await self.all_rows())[0]
        self.assertEqual(notices.context(row)["orgId"], "company")
        team = await self.session.get(models.OrgUnit, "publisher-team")
        team.parent_id = "outside-company"
        await self.session.commit()
        self.assertEqual((await self.inbox("publisher"))["items"], [])
        self.assertEqual(len((await self.inbox("consumer"))["items"]), 1)

    async def test_platform_notice_is_account_scoped_and_ack_never_reaches_disabled_sender(self):
        plugin = await self.session.get(am.Plugin, "plugin")
        plugin.org_id = None
        await self.session.commit()
        await self.policy(installation="not_available")
        self.assertEqual(len((await self.inbox("outside"))["items"]), 1)
        value = (await self.inbox())["items"][0]
        row = await self.session.get(models.MateMessage, value["id"])
        self.assertFalse(await notices.visible_to(self.session, None, row))
        self.admin.is_active = False
        await self.session.commit()
        self.assertFalse(await notices.visible_to(self.session, self.admin, row))
        self.publish.reset_mock()
        client = await self.session.get(models.Client, "device-consumer")
        await mate_messages.mark_read(self.session, client, value["id"])
        self.assertTrue(self.publish.await_args_list)
        self.assertTrue(all(call.kwargs["user_id"] == "consumer" for call in self.publish.await_args_list))

    async def test_reserved_namespace_cannot_be_created_by_a_coworker(self):
        recipient = await self.session.get(models.User, "consumer")
        for payload in ({"messageId": notices.PREFIX + "forged"},
                        {"conversationId": notices.PREFIX + '["publisher-team","plugin","","unpublished"]'}):
            with self.assertRaises(HTTPException) as denied:
                await mate_messages.create(self.session, self.admin, recipient, payload, "Forged", [])
            self.assertEqual(denied.exception.status_code, 400)
        self.assertEqual(await self.all_rows(), [])

    async def test_self_publisher_gets_one_durable_received_notice_and_sent_history(self):
        plugin = await self.session.get(am.Plugin, "plugin")
        plugin.created_by = self.admin.id
        await self.session.commit()
        await self.policy(installation="not_available")
        received = (await self.inbox("admin"))["items"]
        self.assertEqual(len(received), 1)
        self.assertEqual(received[0]["senderId"], "admin")
        sent = (await self.inbox("admin", folder="sent"))["items"]
        self.assertEqual(len(sent), 4)
        self.assertIn(received[0]["id"], {row["id"] for row in sent})

    async def test_notice_failure_rolls_back_policy_or_revoke_and_does_not_publish(self):
        original_create = notices.create

        async def failed_create(*args, **kwargs):
            await original_create(*args, **kwargs)
            raise ValueError("isolated persistence failure")

        with patch.object(notices, "create", side_effect=failed_create):
            with self.assertRaises(ValueError):
                await self.policy(installation="not_available")
        await self.session.rollback()
        self.assertIsNone(await self.session.get(am.PluginCatalogPolicy, "plugin"))
        self.assertEqual(await self.all_rows(), [])
        self.publish.assert_not_awaited()
        self.admin = await self.session.get(models.User, "admin")
        with patch.object(notices, "create", side_effect=failed_create):
            with self.assertRaises(ValueError):
                await plugins.trust_version("current", {"enabled": False}, self.admin, self.session)
        await self.session.rollback()
        version = await self.session.get(am.PluginVersion, "current")
        self.assertEqual(version.trust_state, "approved")
        self.assertTrue(version.enabled)
        self.assertEqual(await self.all_rows(), [])
        self.publish.assert_not_awaited()

    async def test_audit_insert_failure_rolls_back_state_and_notices(self):
        def fail_audit(*_args):
            raise ValueError("isolated audit insert failure")

        for revoke in (False, True):
            self.admin = await self.session.get(models.User, "admin")
            event.listen(models.AuditLog, "before_insert", fail_audit)
            try:
                with self.assertRaises(ValueError):
                    if revoke:
                        await plugins.trust_version("current", {"enabled": False}, self.admin, self.session)
                    else:
                        await self.policy(installation="not_available")
            finally:
                event.remove(models.AuditLog, "before_insert", fail_audit)
            await self.session.rollback()
            self.assertIsNone(await self.session.get(am.PluginCatalogPolicy, "plugin"))
            self.assertTrue((await self.session.get(am.PluginVersion, "current")).enabled)
            self.assertEqual(await self.all_rows(), [])
            self.assertEqual(list(await self.session.scalars(select(models.AuditLog))), [])
        self.publish.assert_not_awaited()

    async def test_commit_failure_does_not_publish_and_caller_can_roll_back_every_record(self):
        for revoke in (False, True):
            self.admin = await self.session.get(models.User, "admin")
            with patch.object(self.session, "commit", AsyncMock(side_effect=RuntimeError("isolated commit failure"))):
                with self.assertRaises(RuntimeError):
                    if revoke:
                        await plugins.trust_version("current", {"enabled": False}, self.admin, self.session)
                    else:
                        await self.policy(installation="not_available")
            await self.session.rollback()
            self.assertIsNone(await self.session.get(am.PluginCatalogPolicy, "plugin"))
            self.assertEqual((await self.session.get(am.PluginVersion, "current")).trust_state, "approved")
            self.assertEqual(await self.all_rows(), [])
            self.assertEqual(list(await self.session.scalars(select(models.AuditLog))), [])
        self.publish.assert_not_awaited()

    async def test_read_ack_is_account_scoped_and_duplicate_ack_does_not_repeat(self):
        await self.policy(installation="not_available")
        value = (await self.inbox())["items"][0]
        other = await self.session.get(models.Client, "device-other")
        with self.assertRaises(HTTPException):
            await mate_messages.mark_read(self.session, other, value["id"])
        client = await self.session.get(models.Client, "device-consumer")
        await mate_messages.mark_read(self.session, client, value["id"])
        count = self.publish.await_count
        await mate_messages.mark_read(self.session, client, value["id"])
        self.assertEqual(self.publish.await_count, count)
        self.assertEqual((await self.inbox())["unreadCount"], 0)

    async def test_concurrent_unpublish_and_revoke_requests_emit_one_event_each(self):
        with tempfile.TemporaryDirectory(prefix="soduwork-plugin-notice-") as directory:
            engine = create_async_engine("sqlite+aiosqlite:///" + str(Path(directory) / "test.db"))
            try:
                async with engine.begin() as connection:
                    await connection.run_sync(models.Base.metadata.create_all)
                sessions = async_sessionmaker(engine, expire_on_commit=False)
                async with sessions() as session:
                    session.add_all([
                        models.OrgUnit(id="company", name="Company"),
                        models.User(id="admin", username="admin", org_id="company", is_super=True),
                        models.User(id="author", username="author", org_id="company"),
                        am.Plugin(id="plugin", key="fixture", name="Fixture", org_id="company",
                                  enabled=True, created_by="author"),
                        am.PluginVersion(id="version", plugin_id="plugin", version="1.0.0",
                            checksum="fixture", created_by="author", enabled=True, trust_state="approved"),
                    ])
                    await session.commit()

                async def request(revoke=False):
                    async with sessions() as session:
                        admin = await session.get(models.User, "admin")
                        if revoke:
                            await plugins.trust_version("version", {"enabled": False}, admin, session)
                        else:
                            await plugins.update_catalog_policy("plugin", {"installation": "not_available"}, admin, session)

                await asyncio.gather(request(), request())
                await asyncio.gather(request(True), request(True))
                async with sessions() as session:
                    rows = list(await session.scalars(select(models.MateMessage)))
                    self.assertEqual(len(rows), 2)
                    self.assertEqual({notices.context(row)["pluginEvent"] for row in rows},
                                     {"unpublished", "revoked"})
            finally:
                await engine.dispose()


if __name__ == "__main__":
    unittest.main()
