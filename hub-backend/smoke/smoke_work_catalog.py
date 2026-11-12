"""Offline checks for profession × work-scenario × workflow routing."""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import tempfile


_tmp = tempfile.TemporaryDirectory(prefix="soduwork-smoke-work-catalog-")
os.environ["DATABASE_URL"] = (
    "sqlite+aiosqlite:///" + (Path(_tmp.name) / "catalog.db").as_posix())

from sqlalchemy import select  # noqa: E402

from app import automation_models as am, models  # noqa: E402
from app.api import admin as admin_api  # noqa: E402
from app.api import work_catalog as work_catalog_api  # noqa: E402
from app.auth import hash_password  # noqa: E402
from app.db import Base, SessionLocal, engine  # noqa: E402
from app.schemas import AdminLogin, task_to_api  # noqa: E402
from app.services import rbac, tasks, work_catalog  # noqa: E402


checks = 0


def ok(value, message: str) -> None:
    global checks
    if not value:
        raise AssertionError(message)
    checks += 1


async def main() -> None:
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with SessionLocal() as session:
        root = models.OrgUnit(id="org-root", name="企业总部")
        child = models.OrgUnit(
            id="org-child", name="研发部", parent_id=root.id)
        outsider = models.OrgUnit(id="org-other", name="其他企业")
        user = models.User(
            id="u-dev", username="developer", display_name="开发同事",
            org_id=child.id, positions=["p_dev"], is_active=True,
            password_hash=hash_password("smoke-pass"))
        client = models.Client(
            id="c-dev", user_ref=user.id, name="开发同事的 SoduWork")
        session.add_all([root, child, outsider, user, client,
            models.Project(id="project-demo", name="Synthetic delivery project", org_id=child.id)])
        for key, name in (
            ("ai-errand", "AI 通用工作"),
            ("software-delivery", "软件研发交付"),
            ("project-validation-release", "工程修复发布"),
            ("product-prototype", "产品原型"),
            ("document-studio", "专业文档"),
            ("presentation-studio", "演示文稿"),
            ("spreadsheet-analyst", "表格分析"),
            ("deep-research", "深度研究"),
            ("meeting-to-action", "会议到行动"),
            ("knowledge-synthesis", "材料综述"),
        ):
            session.add(am.Plugin(
                id="plugin-" + key, org_id=None, key=key,
                name=name, description=name, enabled=True))
        await session.commit()
        await work_catalog.bootstrap(session)

        logged_in = await admin_api.login(
            AdminLogin(user="developer", pw="smoke-pass"), session)
        ok(logged_in["user"]["id"] == user.id and logged_in.get("token"),
           "admin login runtime dependencies are broken")

        profiles = await work_catalog.profession_rows(session, child.id)
        profile_ids = {row.id for row in profiles}
        ok({"p_solution", "p_pm", "p_design", "p_research", "p_data",
            "p_dev", "p_qa", "p_ops", "p_office"}.issubset(profile_ids),
           "built-in professional profiles are incomplete")
        ok((await session.get(models.Position, "p_dev")).name == "软件工程师",
           "legacy position was not upgraded to a professional profile")

        vague = await work_catalog.recommend(
            session, "帮我处理一下这件工作", child.id, ["p_dev"])
        ok(vague["scenario"]["key"] == "software-delivery"
           and vague["matchedBy"] == "profession",
           "professional prior did not select broad software delivery")

        research = await work_catalog.recommend(
            session, "调研行业证据并输出研究报告", child.id, ["p_dev"])
        ok(research["scenario"]["key"] == "research-analysis"
           and research["matchedBy"] == "intent",
           "task intent did not override the employee's profession")

        explicit = await work_catalog.recommend(
            session, "写一点材料", child.id, ["p_dev"],
            explicit_key="product-prototype")
        ok(explicit["scenario"]["key"] == "product-prototype"
           and explicit["matchedBy"] == "explicit",
           "explicit human confirmation did not win")

        role_cases = [
            ("p_solution", "为客户编制咨询方案和建议书", "solution-design"),
            ("p_pm", "整理需求并输出产品原型", "product-prototype"),
            ("p_design", "设计页面交互稿和体验方案", "product-prototype"),
            ("p_research", "调研行业证据并输出研究报告", "research-analysis"),
            ("p_data", "完成数据分析并形成研究报告", "research-analysis"),
            ("p_dev", "开发新增接口并提交代码", "software-delivery"),
            ("p_qa", "修复登录缺陷并完成回归", "project-fix-release"),
            ("p_ops", "发布系统并完成上线检查", "project-fix-release"),
            ("p_office", "整理本周会议纪要和行动项", "meeting-followup"),
        ]
        for profession_id, brief, expected in role_cases:
            matched = await work_catalog.recommend(
                session, brief, child.id, [profession_id])
            ok(matched["scenario"]["key"] == expected,
               "professional scenario failed: %s" % profession_id)

        specialist_cases = [
            ("制作管理层汇报 PPT", "presentation-production", "presentation-studio"),
            ("清洗 Excel 数据并制作透视表", "spreadsheet-analysis", "spreadsheet-analyst"),
            ("整理正式 Word 制度文档", "document-authoring", "document-studio"),
            ("汇总会议纪要和行动项", "meeting-followup", "meeting-to-action"),
            ("对比多份材料形成知识综述", "knowledge-synthesis", "knowledge-synthesis"),
            ("调研行业格局并核对来源", "research-analysis", "deep-research"),
        ]
        for brief, scenario_key, plugin_key in specialist_cases:
            matched = await work_catalog.recommend(
                session, brief, child.id, ["p_office"])
            ok(matched["scenario"]["key"] == scenario_key
               and matched["scenario"]["defaultPluginKey"] == plugin_key,
               "specialist office routing failed: %s" % scenario_key)

        engineering = next(
            row for row in await work_catalog.scenario_rows(session, child.id)
            if row.key == "software-delivery")
        contract_text = json.dumps(
            engineering.output_contract, ensure_ascii=False)
        ok("仓库" in contract_text and "压缩包" in contract_text,
           "engineering contract does not require repository delivery")
        catalog_text = json.dumps(
            [work_catalog.scenario_api(row)
             for row in await work_catalog.scenario_rows(session, child.id)],
            ensure_ascii=False).lower()
        ok(all(substrate not in catalog_text for substrate in (
            '"pi"', "opencode", "claude code", "codex")),
           "work scenarios are coupled to a concrete execution substrate")

        options = work_catalog.effective_plugin_options([
            {"id": "base", "orgId": None, "key": "same-flow",
             "name": "平台流程", "updatedAt": 1},
            {"id": "root", "orgId": root.id, "key": "same-flow",
             "name": "企业流程", "updatedAt": 2},
        ], [root.id, child.id])
        ok(len(options) == 1 and options[0]["id"] == "root",
           "nearest plugin override was not selected by stable key")
        guarded = tasks._apply_scene(
            {"scene": "software-delivery", "flow": "invented-flow"},
            [work_catalog.scenario_api(engineering)],
            {"scenario": work_catalog.scenario_api(engineering)},
            [{"key": "software-delivery"}],
        )
        ok(guarded["flow"] == "" and guarded["recommendedFlow"] == "software-delivery",
           "invented workflow key must stay unselected while retaining the scene recommendation")

        disabled_plugin = am.Plugin(
            id="plugin-disabled", org_id=root.id, key="disabled-flow",
            name="未启用流程", description="只用于预检", enabled=False)
        legacy_global = models.Position(
            id="legacy-global", org_id=None, name="历史全局职业",
            is_system=False)
        session.add_all([disabled_plugin, legacy_global])
        await session.commit()
        protected = await work_catalog.delete_profession(
            session, legacy_global)
        ok(bool(protected) and await session.get(
            models.Position, legacy_global.id) is not None,
           "a non-system global profession bypassed platform protection")

        denied_status = 0
        try:
            await work_catalog_api._target_org(session, user, outsider.id)
        except Exception as error:  # HTTPException without coupling the smoke to FastAPI
            denied_status = int(getattr(error, "status_code", 0) or 0)
        ok(denied_status == 403,
           "department admin could configure another tenant's catalog")

        valid_contract = {
            "kind": "artifact", "summary": "可验收成果",
            "deliverables": ["成果文件"], "acceptance": ["内容完整"]}
        disabled_error = ""
        try:
            await work_catalog.save_scenario(session, {
                "key": "disabled-plugin-scene", "name": "禁用流程场景",
                "positionIds": ["p_dev"], "intentHints": ["预检"],
                "requiredCapabilities": ["files"],
                "defaultPluginKey": "disabled-flow",
                "outputContract": valid_contract, "enabled": True,
            }, child.id)
        except ValueError as error:
            disabled_error = str(error)
        ok("尚未启用" in disabled_error,
           "enabled scenario accepted a disabled default workflow")

        substrate_error = ""
        try:
            await work_catalog.save_scenario(session, {
                "key": "substrate-scene", "name": "错误底座场景",
                "positionIds": ["p_dev"], "intentHints": ["底座"],
                "requiredCapabilities": ["pi"],
                "outputContract": valid_contract, "enabled": True,
            }, child.id)
        except ValueError as error:
            substrate_error = str(error)
        ok("不要绑定" in substrate_error,
           "scenario capability accepted a concrete execution substrate")

        contract_error = ""
        try:
            await work_catalog.save_scenario(session, {
                "key": "empty-contract-scene", "name": "空交付场景",
                "positionIds": ["p_dev"], "intentHints": ["空交付"],
                "requiredCapabilities": ["files"],
                "outputContract": {}, "enabled": True,
            }, child.id)
        except ValueError as error:
            contract_error = str(error)
        ok("必须配置交付" in contract_error,
           "enabled scenario accepted an empty delivery contract")
        other_profile = await work_catalog.save_profession(session, {
            "name": "其他企业专属职业", "category": "隔离测试",
            "competencies": ["不可见"],
        }, outsider.id)
        visible = await work_catalog.profession_rows(session, child.id)
        ok(other_profile.id not in {row.id for row in visible},
           "another tenant's profession leaked into the catalog")
        normalized = await work_catalog.validate_profession_ids(
            session, child.id, ["p_dev", "p_dev"])
        ok(normalized == ["p_dev"],
           "visible profession ids were not normalized")
        invalid_error = ""
        try:
            await work_catalog.validate_profession_ids(
                session, child.id, [other_profile.id])
        except ValueError as error:
            invalid_error = str(error)
        ok("不属于" in invalid_error,
           "cross-tenant profession id was accepted")

        base_research = next(
            row for row in await work_catalog.scenario_rows(session, root.id)
            if row.key == "research-analysis")
        root_override = await work_catalog.save_scenario(session, {
            "key": base_research.key,
            "name": "企业研究分析",
            "category": base_research.category,
            "description": "总部统一的研究方法",
            "positionIds": base_research.position_ids,
            "intentHints": base_research.intent_hints,
            "requiredCapabilities": base_research.required_capabilities,
            "defaultPluginKey": base_research.default_plugin_key,
            "outputContract": base_research.output_contract,
            "enabled": True,
        }, root.id)
        inherited = next(
            row for row in await work_catalog.scenario_rows(session, child.id)
            if row.key == "research-analysis")
        ok(inherited.id == root_override.id
           and inherited.name == "企业研究分析",
           "child organization did not inherit the nearest override")
        child_catalog = await work_catalog.catalog_for_user(
            session, child.id, ["p_dev"], include_disabled=True)
        inherited_api = next(
            row for row in child_catalog["scenarios"]
            if row["key"] == "research-analysis")
        ok(inherited_api["inherited"]
           and inherited_api["orgId"] == root.id,
           "ancestor override was not marked read-only in the child catalog")

        base_solution = next(
            row for row in await work_catalog.scenario_rows(session, root.id)
            if row.key == "solution-design")
        await work_catalog.save_scenario(session, {
            "key": base_solution.key,
            "name": base_solution.name,
            "category": base_solution.category,
            "description": base_solution.description,
            "positionIds": base_solution.position_ids,
            "intentHints": base_solution.intent_hints,
            "requiredCapabilities": base_solution.required_capabilities,
            "defaultPluginKey": base_solution.default_plugin_key,
            "outputContract": base_solution.output_contract,
            "enabled": False,
        }, child.id)
        child_keys = {
            row.key for row in await work_catalog.scenario_rows(session, child.id)}
        ok("solution-design" not in child_keys,
           "disabled child override did not hide the inherited scenario")
        all_child = await work_catalog.scenario_rows(
            session, child.id, include_disabled=True)
        ok(any(row.key == "solution-design" and not row.enabled
               for row in all_child),
           "disabled override is missing from the admin catalog")

        created = await tasks.create_task(session, client.id, {
            "title": "新增论坛分享功能",
            "note": "在已有工程里实现、测试并提交代码",
            "projectId": "project-demo",
        }, notify=False)
        ok(created["workScenarioKey"] == "software-delivery",
           "task creation did not persist the matched work scenario")
        task = await session.get(models.Task, created["id"])
        frozen = json.loads(json.dumps(task.work_routing, ensure_ascii=False))
        ok(frozen["outputContract"]["kind"] == "repository-change"
           and frozen["requiredAgentCapabilities"] == ["repository", "terminal"],
           "task routing snapshot is incomplete")

        engineering.output_contract = {
            "kind": "changed-later", "summary": "管理员后改的标准",
            "deliverables": [], "acceptance": []}
        await session.commit()
        await session.refresh(task)
        ok(task.work_routing == frozen,
           "catalog mutation rewrote an existing task snapshot")

        api = task_to_api(task)
        ok(api["workScenarioName"] and
           api["workRouting"]["schemaVersion"] == 1,
           "task API does not expose the canonical routing snapshot")

        rebuilt = await tasks.update_task(session, client.id, task.id, {
            "workScenarioKey": "research-analysis"})
        ok(rebuilt["workScenarioKey"] == "research-analysis"
           and rebuilt["workRouting"]["scenarioKey"] == "research-analysis",
           "explicit scenario change did not rebuild the canonical snapshot")

        scope = await rbac.subtree_org_ids(session, root.id)
        scoped = await rbac.list_positions(session, scope)
        ok(other_profile.id not in {row["id"] for row in scoped},
           "scoped profession API leaked another organization")

    await engine.dispose()


try:
    asyncio.run(main())
finally:
    try:
        asyncio.run(engine.dispose())
    except Exception:
        pass
    _tmp.cleanup()

print("work catalog: %d checks passed" % checks)
