"""Immutable built-in plugin discovery and upgrades."""
import hashlib
import json
import os
from sqlalchemy import select
from app import automation_models as am
from app.services import plugin_service


async def builtin(chk, session):
    'Builtin discovery adds immutable versions without approving them.'
    harness_path = os.path.join(
        os.path.dirname(os.path.dirname(__file__)), "plugins", "goal-delivery-harness.json")
    with open(harness_path, encoding="utf-8") as stream:
        harness_raw = json.load(stream)
    harness_checksum = hashlib.sha256(json.dumps(
        harness_raw, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    legacy_builtin = am.Plugin(
        id="plugin-builtin-legacy-proof", key="goal-delivery-harness",
        name="目标交付 Harness", source_kind="builtin", enabled=False)
    legacy_version = am.PluginVersion(
        id="version-builtin-legacy-proof", plugin_id=legacy_builtin.id,
        version=harness_raw["version"], checksum=harness_checksum,
        manifest=harness_raw, workflow={"nodes": []},
        trust_state="quarantined", enabled=False)
    existing_builtin = am.Plugin(
        id="plugin-builtin-upgrade", key="software-delivery",
        name="需求到生产 · 标准研发交付", source_kind="builtin", enabled=True)
    existing_version = am.PluginVersion(
        id="version-builtin-old", plugin_id=existing_builtin.id, version="1.0.0",
        checksum="old-built-in-checksum", manifest={}, workflow={"nodes": []},
        trust_state="approved", enabled=True)
    session.add_all([
        legacy_builtin, legacy_version, existing_builtin, existing_version])
    await session.commit()
    await plugin_service.bootstrap_example(session)
    legacy_proof = plugin_service.provenance_api(
        legacy_version.provenance, legacy_version.checksum)
    chk("历史内置版本启动时补齐 SoduWork 平台来源且不改变审批状态",
        legacy_proof["publisherName"] == "SoduWork 平台"
        and legacy_proof["publisherType"] == "platform"
        and legacy_proof["channel"] == "builtin"
        and legacy_proof["signatureState"] == "platform"
        and legacy_version.trust_state == "quarantined"
        and not legacy_version.enabled, legacy_proof)
    sample = (await session.execute(select(am.Plugin).where(
        am.Plugin.key == "product-prototype"))).scalar_one_or_none()
    sample_version = (await session.execute(select(am.PluginVersion).where(
        am.PluginVersion.plugin_id == sample.id))).scalar_one_or_none() if sample else None
    chk("内置需求到 HTML 原型样板仅进入待审区",
        sample is not None and not sample.enabled and sample_version is not None
        and sample_version.trust_state == "quarantined")
    software = (await session.execute(select(am.Plugin).where(
        am.Plugin.key == "software-delivery"))).scalar_one_or_none()
    software_versions = list((await session.execute(select(am.PluginVersion).where(
        am.PluginVersion.plugin_id == software.id
    ).order_by(am.PluginVersion.created_at))).scalars().all()) if software else []
    software_version = next((item for item in software_versions
                             if item.version == "1.7.7"), None)
    chk("已有内置插件会发现新版本且不改写已批准旧版本",
        len(software_versions) == 2 and existing_version.trust_state == "approved"
        and existing_version.enabled, [x.version for x in software_versions])
    chk("内置标准研发交付新版本仍先进入隔离区",
        software is not None and software.enabled and software_version is not None
        and software_version.trust_state == "quarantined"
        and len((software_version.workflow or {}).get("nodes") or []) == 9
        and ((software_version.workflow or {}).get("nodes") or [])[0].get("outputs")
        and any(x.get("type") == "ai_review"
                for x in (software_version.workflow or {}).get("nodes") or [])
        and not any(x.get("type") == "approval"
                    for x in (software_version.workflow or {}).get("nodes") or [])
        and any(x.get("type") == "deploy_chain"
                for x in (software_version.workflow or {}).get("nodes") or [])
        and any(x.get("type") == "quality"
                and any(command.get("argv") == ["project:selftest"]
                        for command in (x.get("config") or {}).get("commands") or [])
                for x in (software_version.workflow or {}).get("nodes") or [])
        and any(x.get("key") == "implement"
                and ((x.get("config") or {}).get("executionPolicy") or {}).get(
                    "maxVerificationCommands") == 6
                and ((x.get("config") or {}).get("executionPolicy") or {}).get(
                    "authoritativeQuality") is True
                for x in (software_version.workflow or {}).get("nodes") or [])
        and any(x.get("type") == "merge"
                and (x.get("config") or {}).get("autoSubmit") is True
                for x in (software_version.workflow or {}).get("nodes") or []))
    validation = (await session.execute(select(am.Plugin).where(
        am.Plugin.key == "project-validation-release"))).scalar_one_or_none()
    validation_version = (await session.execute(select(am.PluginVersion).where(
        am.PluginVersion.plugin_id == validation.id
    ))).scalar_one_or_none() if validation else None
    validation_nodes = list((validation_version.workflow or {}).get("nodes") or []) \
        if validation_version else []
    chk("内置项目验证流程独立于正式研发流程且环境链不写死",
        validation is not None and validation.id != software.id
        and not validation.enabled and validation_version is not None
        and validation_version.trust_state == "quarantined"
        and len(validation_nodes) == 8
        and not any(x.get("type") == "spec" for x in validation_nodes)
        and any(x.get("type") == "ai_review" for x in validation_nodes)
        and not any(x.get("type") in ("human_review", "approval")
                    for x in validation_nodes)
        and any(x.get("type") == "deploy_chain" for x in validation_nodes)
        and not any(dict(x.get("config") or {}).get("environmentKey")
                    for x in validation_nodes), validation_nodes)
