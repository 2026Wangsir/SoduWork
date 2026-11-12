# -*- coding: utf-8 -*-
"""Employee plugin catalog, upload and maker smoke; isolated DB and cleanup."""
import asyncio
import io
import json
import os
import shutil
import sys
import tempfile
import zipfile

import httpx
from sqlalchemy import delete

sys.path.insert(0, ".")
_TEMP = tempfile.TemporaryDirectory(prefix="soduwork-smoke-plugin-employee-")
DB = os.path.join(_TEMP.name, "test.db")
DATA = os.path.join(_TEMP.name, "data")
for suffix in ("", "-shm", "-wal"):
    try: os.remove(DB + suffix)
    except FileNotFoundError: pass
shutil.rmtree(DATA, ignore_errors=True)
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
os.environ["SODUWORK_DATA_ROOT"] = DATA

from app import automation_models as am, models  # noqa: E402
from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.main import app  # noqa: E402
from app.services import device_auth, plugin_drafts, plugin_packages  # noqa: E402

CID, SECOND_CID, UID, ORG = (
    "c-plugin-employee", "c-plugin-employee-second",
    "u-plugin-employee", "o-plugin-employee")
TOKEN = SECOND_TOKEN = ""
ok = fail = 0


def chk(name, cond, extra=""):
    global ok, fail
    ok, fail = (ok + 1, fail) if cond else (ok, fail + 1)
    print(("  PASS  " if cond else "  FAIL  ") + name +
          (("  << " + str(extra)[:300]) if extra and not cond else ""))


def headers(token=None): return {"Authorization": "Device " + (token or TOKEN)}


def foreign(kind: str, version: str = "1.0.0",
            description: str = "employee import v1") -> bytes:
    out = io.BytesIO()
    root = ".codex-plugin" if kind == "codex" else ".claude-plugin"
    with zipfile.ZipFile(out, "w") as zf:
        zf.writestr(root + "/plugin.json", json.dumps({
            "name": "employee-import", "version": version, "description": description,
            "author": "插件员工",
        }))
        zf.writestr("skills/check/SKILL.md", "---\nname: check\ndescription: Check work\n---\n")
    return out.getvalue()


async def purge():
    async with SessionLocal() as session:
        await session.execute(delete(am.PluginInstallation).where(
            am.PluginInstallation.user_id == UID))
        await session.execute(delete(am.PluginBinding).where(am.PluginBinding.org_id == ORG))
        plugins = (await session.execute(
            am.Plugin.__table__.select().where(am.Plugin.org_id == ORG))).all()
        ids = [row.id for row in plugins]
        if ids:
            await session.execute(delete(am.PluginVersion).where(am.PluginVersion.plugin_id.in_(ids)))
            await session.execute(delete(am.Plugin).where(am.Plugin.id.in_(ids)))
        await session.execute(delete(models.Client).where(
            models.Client.id.in_((CID, SECOND_CID))))
        await session.execute(delete(models.User).where(models.User.id == UID))
        await session.execute(delete(models.OrgUnit).where(models.OrgUnit.id == ORG))
        await session.commit()


async def main():
    global TOKEN, SECOND_TOKEN
    await init_db(); await purge()
    chk("中文名称不会因相同英文尾词生成冲突标识",
        plugin_drafts._key("产品交付 review") != plugin_drafts._key("代码审查 review"))
    for template in ("method", "connector", "workflow"):
        package = plugin_drafts.build({
            "template": template, "name": "中文插件" + template,
            "description": "验证标准草稿", "instructions": "读取输入，完成成果并验证。",
            "mcpServers": "knowledge" if template == "connector" else "",
        })
        parsed = plugin_packages.parse(package)
        chk(template + " 模板生成可导入标准包",
            bool(parsed["manifest"]["key"])
            and bool(parsed["capabilities"]["bundledSkills"])
            and not parsed["capabilities"]["adapterBlockers"])
        expected_workflow = template == "workflow"
        summary = plugin_packages.public_summary(parsed)
        chk(template + " 模板使用正确的调用形态",
            parsed["capabilities"]["hasWorkflow"] is expected_workflow
            and parsed["capabilities"]["executionMode"]
                == ("workflow" if expected_workflow else "direct")
            and bool(summary["workflow"]["nodes"]) is expected_workflow,
            (parsed["capabilities"], summary["workflow"]))
    workflow_nodes = parsed["workflow"]["nodes"]
    work = next(node for node in workflow_nodes if node["key"] == "work")
    accept = next(node for node in workflow_nodes if node["key"] == "accept")
    chk("员工工作流模板使用类型化交接和逐节点显式最小权限",
        work["inputs"][0]["fromNode"] == "understand"
        and accept["inputs"][0]["outputKey"] == "result"
        and work["capabilities"]["explicit"]
        and work["capabilities"]["skills"])
    chk("员工模板为每个 AI 节点声明无人值守运行上限",
        all(node.get("config", {}).get("timeoutSeconds") == 3600
            for node in workflow_nodes if node["type"] in ("ai", "ai_review")))
    try:
        plugin_drafts.build({"template": "method", "name": "版本错误",
                             "version": "next", "description": "拒绝坏版本",
                             "instructions": "完成工作"})
        invalid_version = False
    except ValueError:
        invalid_version = True
    chk("员工插件版本必须使用 SemVer", invalid_version)
    async with SessionLocal() as session:
        session.add(models.OrgUnit(id=ORG, name="插件测试组织"))
        session.add(models.User(id=UID, username="plugin-employee", display_name="插件员工",
                                org_id=ORG, is_active=True))
        session.add(models.Client(id=CID, name="插件员工终端", auth_state="active", user_ref=UID))
        session.add(models.Client(id=SECOND_CID, name="插件员工第二终端",
                                  auth_state="active", user_ref=UID))
        await session.commit()
        TOKEN = device_auth.issue_session(await session.get(models.Client, CID))[0]
        SECOND_TOKEN = device_auth.issue_session(
            await session.get(models.Client, SECOND_CID))[0]

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        files = {"file": ("plugin.zip", foreign("codex"), "application/zip")}
        preview = await client.post("/api/v1/plugins/preflight", headers=headers(), files=files)
        chk("员工能在上传前识别 Codex 包", preview.status_code == 200 and
            preview.json().get("sourceKind") == "codex", preview.text)
        files = {"file": ("plugin.zip", foreign("codex"), "application/zip")}
        submitted = await client.post("/api/v1/plugins/submissions", headers=headers(), files=files)
        body = submitted.json() if submitted.status_code == 200 else {}
        detail = body.get("plugin") or {}
        latest = detail.get("latestVersion") or {}
        chk("员工上传只进入组织隔离区", submitted.status_code == 200 and
            detail.get("orgId") == ORG and not detail.get("enabled") and
            latest.get("trustState") == "quarantined" and not latest.get("enabled"), submitted.text)
        catalog = await client.get("/api/v1/plugins/catalog", headers=headers())
        view = catalog.json() if catalog.status_code == 200 else {}
        chk("隔离版本不混入可用插件目录", catalog.status_code == 200 and view.get("items") == [], catalog.text)
        chk("员工能看到自己的审核中提交", len(view.get("submissions") or []) == 1 and
            view["submissions"][0]["trustState"] == "quarantined", view)
        second_catalog = await client.get(
            "/api/v1/plugins/catalog", headers=headers(SECOND_TOKEN))
        second_view = second_catalog.json() if second_catalog.status_code == 200 else {}
        chk("同一员工更换客户端仍能看到自己的插件提交",
            second_catalog.status_code == 200
            and len(second_view.get("submissions") or []) == 1
            and second_view["submissions"][0]["pluginId"]
                == view["submissions"][0]["pluginId"],
            second_view)
        draft_body = {
            "template": "workflow", "name": "客户需求闭环", "version": "0.2.0",
            "description": "完成需求并交付验收",
            "instructions": "理解目标，形成成果，完成验证。",
        }
        draft_preview = await client.post(
            "/api/v1/plugins/drafts/preflight", headers=headers(), json=draft_body)
        preview_body = draft_preview.json() if draft_preview.status_code == 200 else {}
        catalog_after_preview = await client.get("/api/v1/plugins/catalog", headers=headers())
        chk("员工制作插件先做无持久化预检",
            draft_preview.status_code == 200
            and preview_body.get("manifest", {}).get("version") == "0.2.0"
            and len(catalog_after_preview.json().get("submissions") or []) == 1,
            (draft_preview.text, catalog_after_preview.text))
        draft = await client.post("/api/v1/plugins/drafts", headers=headers(), json=draft_body)
        chk("员工确认后才把指定版本提交隔离区", draft.status_code == 200 and
            draft.json().get("preview", {}).get("manifest", {}).get("version") == "0.2.0"
            and draft.json().get("preview", {}).get("workflow", {}).get("nodes"), draft.text)

        async with SessionLocal() as session:
            plugin = (await session.execute(am.Plugin.__table__.select().where(
                am.Plugin.key == "employee-import", am.Plugin.org_id == ORG))).first()
            first = (await session.execute(am.PluginVersion.__table__.select().where(
                am.PluginVersion.plugin_id == plugin.id,
                am.PluginVersion.version == "1.0.0"))).first()
            first_model = await session.get(am.PluginVersion, first.id)
            from app.services import plugin_service
            report = dict(first_model.capability_report or {})
            report["evaluationCases"] = [{
                "key": "representative", "name": "代表性任务",
                "instruction": "验证员工目录质量标识", "criteria": ["结果可用"],
                "inputs": {}, "expectedOutputs": [],
            }]
            report["qualitySummary"] = {"state": "declared", "caseCount": 1, "resultCount": 0}
            first_model.capability_report = report
            session.add(am.PluginEvaluationRun(
                id="eval-plugin-employee", plugin_id=plugin.id,
                version_id=first.id, case_key="representative", org_id=ORG,
                state="completed", verdict="passed", case_snapshot=report["evaluationCases"][0],
                executor={"assigneeName": "Smoke Agent"},
                result={"contract": {"ok": True}}, created_by=UID,
                reviewed_by=UID, review_note="verified"))
            await plugin_service.approve_version(session, first_model, True, "admin")
            session.add(am.PluginBinding(
                plugin_id=plugin.id, version_id=first.id, org_id=ORG, enabled=True))
            await session.commit()
        progress_catalog = await client.get(
            "/api/v1/plugins/catalog", headers=headers())
        progress_rows = (
            progress_catalog.json().get("submissions")
            if progress_catalog.status_code == 200 else [])
        progress = next((
            row for row in progress_rows or []
            if row.get("pluginId") == plugin.id
        ), {})
        chk("发布者客户端能看到不可变包质量声明与企业目录进度",
            progress.get("versionId") == first.id
            and progress.get("qualitySummary", {}).get("state") == "declared"
            and progress.get("qualitySummary", {}).get("caseCount") == 1
            and progress.get("bindingCount") == 1
            and progress.get("catalogReady") is True,
            progress)
        files = {"file": ("plugin-v2.zip", foreign("codex", "2.0.0", "unreviewed description"),
                          "application/zip")}
        second = await client.post("/api/v1/plugins/submissions", headers=headers(), files=files)
        async with SessionLocal() as session:
            plugin_model = await session.get(am.Plugin, plugin.id)
            chk("隔离中的新版本不会篡改已发布插件信息",
                second.status_code == 200
                and plugin_model.name == "employee-import"
                and plugin_model.description == "employee import v1",
                (second.text, plugin_model.name, plugin_model.description))
            v2 = (await session.execute(am.PluginVersion.__table__.select().where(
                am.PluginVersion.plugin_id == plugin.id,
                am.PluginVersion.version == "2.0.0"))).first()
            v2_model = await session.get(am.PluginVersion, v2.id)
            chk("待审核版本不会提前进入员工目录",
                v2_model.trust_state == "quarantined"
                and plugin_model.description == "employee import v1",
                (v2_model.trust_state, plugin_model.description))
        bound_catalog = await client.get("/api/v1/plugins/catalog", headers=headers())
        bound_items = bound_catalog.json().get("items") if bound_catalog.status_code == 200 else []
        own_versions = [row for row in bound_catalog.json().get("submissions", [])
                        if row.get("pluginId") == plugin.id]
        chk("新申请保留每个已提交版本及原版本进度",
            [row.get("versionId") for row in own_versions] == [v2.id, first.id]
            and own_versions[0]["trustState"] == "quarantined"
            and own_versions[0]["reviewHistory"] == []
            and own_versions[1] == progress,
            own_versions)
        chk("员工目录展示已审核上架版本并明确任务绑定状态",
            len(bound_items) == 1
            and bound_items[0]["version"] == "1.0.0"
            and bound_items[0]["description"] == "employee import v1"
            and bound_items[0]["authorName"] == "插件员工"
            and bound_items[0]["taskReady"] is True
            and bound_items[0]["taskVersionIds"] == [first.id],
            bound_catalog.text)
        chk("直接能力包目录不暴露内部执行节点",
            len(bound_items) == 1
            and bound_items[0]["workflow"] == []
            and bound_items[0]["capabilities"]["executionMode"] == "direct"
            and bound_items[0]["capabilities"]["components"],
            bound_items)
        chk("员工目录只展示不可变包质量声明，不反向读取治理评测表",
            len(bound_items) == 1
            and bound_items[0]["capabilities"]["qualitySummary"]["state"] == "declared"
            and bound_items[0]["capabilities"]["qualitySummary"]["caseCount"] == 1,
            bound_items)
        chk("企业发布与个人安装分离，员工先发现再自主安装",
            len(bound_items) == 1
            and bound_items[0]["installed"] is False
            and bound_items[0]["installationState"] == "available",
            bound_items)
        chk("无外部连接的能力包明确标记为就绪",
            bound_items[0]["dependencyReadiness"] == {
                "ok": True, "requiredMcp": [], "availableMcp": [], "missingMcp": []},
            bound_items)
        malformed_install = await client.put(
            f"/api/v1/plugins/{plugin.id}/installation", headers=headers(),
            json={"enabled": "yes"})
        chk("安装接口拒绝把字符串等错误类型静默当成启用",
            malformed_install.status_code == 422,
            malformed_install.text)
        before_install = await client.post(
            "/api/v1/plugins/conversation-context", headers=headers(),
            json={"pluginIds": [plugin.id], "conversationId": "before-install"})
        chk("未安装企业插件不能绕过目录直接加入对话",
            before_install.status_code == 409
            and "尚未安装" in before_install.text,
            before_install.text)
        installed = await client.put(
            f"/api/v1/plugins/{plugin.id}/installation", headers=headers(),
            json={"enabled": True, "expectedVersionId": first.id})
        installed_state = (
            installed.json().get("installation") if installed.status_code == 200 else {})
        chk("员工能把当前不可变版本安装到自己的对话工具箱",
            installed.status_code == 200
            and installed_state.get("installed") is True
            and installed_state.get("installedVersion") == "1.0.0"
            and installed_state.get("updateAvailable") is False,
            installed.text)
        second_after_install = await client.get(
            "/api/v1/plugins/catalog", headers=headers(SECOND_TOKEN))
        second_items = (
            second_after_install.json().get("items")
            if second_after_install.status_code == 200 else [])
        chk("个人安装态跟随企业账号而不是绑死某一台客户端",
            len(second_items) == 1
            and second_items[0]["installed"] is True
            and second_items[0]["installedVersion"] == "1.0.0",
            second_after_install.text)
        after_install = await client.post(
            "/api/v1/plugins/conversation-context", headers=headers(),
            json={"pluginIds": [plugin.id], "conversationId": "after-install"})
        chk("安装后企业插件才能进入普通对话",
            after_install.status_code == 200
            and after_install.json()["items"][0]["version"] == "1.0.0",
            after_install.text)

        async with SessionLocal() as session:
            plugin_model = await session.get(am.Plugin, plugin.id)
            await plugin_service.approve_version(
                session, await session.get(am.PluginVersion, v2.id), True, "admin")
            await session.refresh(plugin_model)
            chk("管理员审核上架后新版本信息才成为线上信息",
                plugin_model.description == "unreviewed description",
                plugin_model.description)
        update_catalog = await client.get("/api/v1/plugins/catalog", headers=headers())
        update_items = (
            update_catalog.json().get("items")
            if update_catalog.status_code == 200 else [])
        chk("审核上架的新版本无需任务绑定即可进入员工目录",
            len(update_items) == 1
            and update_items[0]["version"] == "2.0.0"
            and update_items[0]["installedVersion"] == "1.0.0"
            and update_items[0]["updateAvailable"] is True
            and update_items[0]["upgradeImpact"]["fromVersion"] == "1.0.0"
            and update_items[0]["upgradeImpact"]["toVersion"] == "2.0.0"
            and update_items[0]["upgradeImpact"]["level"] == "safe"
            and update_items[0]["taskReady"] is True
            and update_items[0]["taskVersionIds"] == [first.id],
            update_catalog.text)

        async with SessionLocal() as session:
            binding = (await session.execute(am.PluginBinding.__table__.select().where(
                am.PluginBinding.plugin_id == plugin.id,
                am.PluginBinding.org_id == ORG))).first()
            binding_model = await session.get(am.PluginBinding, binding.id)
            binding_model.version_id = v2.id
            await session.commit()
        aligned_catalog = await client.get("/api/v1/plugins/catalog", headers=headers())
        aligned_item = aligned_catalog.json()["items"][0]
        chk("任务绑定可独立跟随目录版本且不会静默升级个人安装态",
            aligned_catalog.status_code == 200
            and aligned_item["version"] == "2.0.0"
            and aligned_item["installedVersion"] == "1.0.0"
            and aligned_item["updateAvailable"] is True
            and aligned_item["taskVersionIds"] == [v2.id],
            aligned_catalog.text)
        stale = await client.post(
            "/api/v1/plugins/conversation-context", headers=headers(),
            json={"pluginIds": [plugin.id], "conversationId": "needs-upgrade"})
        chk("普通对话继续使用已接受的安装版本，不静默升级到目录新版本",
            stale.status_code == 200
            and stale.json()["items"][0]["versionId"] == first.id
            and stale.json()["items"][0]["version"] == "1.0.0", stale.text)
        stale_accept = await client.put(
            f"/api/v1/plugins/{plugin.id}/installation", headers=headers(),
            json={"enabled": True, "expectedVersionId": first.id})
        after_stale_accept = await client.get(
            "/api/v1/plugins/catalog", headers=headers())
        stale_item = after_stale_accept.json()["items"][0]
        chk("目录版本变化后旧确认失效且不会静默升级",
            stale_accept.status_code == 409
            and "目录已经变化" in stale_accept.text
            and stale_item["installedVersion"] == "1.0.0"
            and stale_item["updateAvailable"] is True,
            (stale_accept.text, after_stale_accept.text))
        upgraded = await client.put(
            f"/api/v1/plugins/{plugin.id}/installation", headers=headers(),
            json={"enabled": True, "expectedVersionId": v2.id})
        chk("员工确认后升级到当前企业发布版本",
            upgraded.status_code == 200
            and upgraded.json()["installation"]["installedVersion"] == "2.0.0"
            and upgraded.json()["installation"]["updateAvailable"] is False,
            upgraded.text)
        upgraded_use = await client.post(
            "/api/v1/plugins/conversation-context", headers=headers(),
            json={"pluginIds": [plugin.id], "conversationId": "after-upgrade"})
        chk("升级后的不可变版本可以进入普通对话",
            upgraded_use.status_code == 200
            and upgraded_use.json()["items"][0]["version"] == "2.0.0",
            upgraded_use.text)
        removed = await client.put(
            f"/api/v1/plugins/{plugin.id}/installation", headers=headers(),
            json={"enabled": False})
        removed_use = await client.post(
            "/api/v1/plugins/conversation-context", headers=headers(),
            json={"pluginIds": [plugin.id], "conversationId": "after-remove"})
        chk("员工能从个人对话工具箱停用且立即生效",
            removed.status_code == 200
            and removed.json()["installation"]["installed"] is False
            and removed_use.status_code == 409,
            (removed.text, removed_use.text))
        async with SessionLocal() as session:
            task_view = type("TaskView", (), {
                "owner_client_id": CID, "project_id": None, "repo_id": None,
            })()
            options = await plugin_service.available_bindings(session, task_view)
            chk("任务候选同样把直接能力与工作流分开",
                len(options) == 1
                and options[0]["workflow"] == []
                and options[0]["capabilities"]["hasWorkflow"] is False
                and options[0]["entrypoints"]["task"] is True,
                options)


async def guarded():
    try: await main()
    finally:
        await purge(); await engine.dispose()


asyncio.run(guarded())
print("PASS=%d FAIL=%d" % (ok, fail))
for suffix in ("", "-shm", "-wal"):
    try: os.remove(DB + suffix)
    except FileNotFoundError: pass
shutil.rmtree(DATA, ignore_errors=True)
sys.exit(1 if fail else 0)
