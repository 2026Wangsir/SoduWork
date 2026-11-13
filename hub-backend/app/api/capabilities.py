"""Unified capability catalog and scoped Skill/MCP endpoints."""
from __future__ import annotations

import asyncio
import hashlib

from fastapi import APIRouter, Body, Depends, File, HTTPException, Response, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import current_client, require_perm
from ..models import Client, User
from ..services import (capability_catalog, mcp_import, mcp_servers, runner_hub,
                        runner_skills, skill_packages, skills)

router = APIRouter(prefix="/api/v1", tags=["capabilities"])
admin_router = APIRouter(prefix="/api/v1/admin/capabilities", tags=["capabilities"])

from . import skill_details, mcp_management, mcp_selection, connector_oauth
router.include_router(connector_oauth.router)
router.include_router(mcp_management.router)
router.include_router(mcp_selection.router)
admin_router.include_router(mcp_management.admin_router)
router.include_router(skill_details.router)
admin_router.include_router(skill_details.admin_router)


async def _skill_upload(file: UploadFile) -> dict:
    try:
        payload = await file.read(skill_packages._MAX_PACKAGE + 1)
        return await asyncio.to_thread(skill_packages.parse, payload, file.filename or "")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


async def _mcp_upload(file: UploadFile) -> dict:
    try:
        return mcp_import.parse(await file.read(mcp_import._MAX_BYTES + 1), file.filename or "")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc



def _personal_mcp_spec(body: dict, client: Client) -> dict:
    raw = dict(body or {})
    previous = next((item for item in mcp_servers.personal_load(client)
                     if item["id"] == str(raw.get("id") or "")), None)
    if previous:
        raw = mcp_servers.restore(raw, previous)
    return mcp_servers.personal_spec(raw)


def _version_at_least(value: str, expected: tuple[int, int, int]) -> bool:
    parts = []
    for chunk in str(value or "").split(".")[:3]:
        digits = "".join(char for char in chunk if char.isdigit())
        parts.append(int(digits or 0))
    return tuple((parts + [0, 0, 0])[:3]) >= expected

@router.get("/capabilities")
async def my_capabilities(client: Client = Depends(current_client),
                          session: AsyncSession = Depends(get_session)):
    try:
        return await capability_catalog.client_catalog(session, client)
    except skills.PolicyChanged as exc:
        raise HTTPException(409, detail=str(exc)) from exc


@router.post("/skills/refresh")
async def refresh_my_skills(client: Client = Depends(current_client),
                            session: AsyncSession = Depends(get_session)):
    """Refresh Hub packages and this device's native substrate Skill roots."""
    skills.clear_scan_cache()
    warning = ""
    runner = runner_hub.for_client(client.id)
    if runner is None:
        warning = "本机 Runner 暂未在线，已刷新企业 Skill 目录"
    else:
        result = await runner.call("skills.refresh", {}, timeout=20)
        if result.get("ok"):
            payload = result.get("data") if isinstance(result.get("data"), dict) else {}
            runner.skills = runner_hub.clean_skill_names(payload.get("skills"))
            runner.skill_catalog = runner_hub.clean_skill_catalog(
                payload.get("skillCatalog"))
            runner.skills_known = True
        else:
            warning = str(result.get("error") or "本机 Skill 目录暂时没有刷新成功")[:300]
    try:
        catalog = await capability_catalog.client_catalog(session, client)
    except skills.PolicyChanged as exc:
        raise HTTPException(409, detail=str(exc)) from exc
    catalog["refreshWarning"] = warning
    return catalog


@router.post("/skills/preflight")
async def preflight_my_skill(file: UploadFile = File(...),
                             client: Client = Depends(current_client)):
    parsed = await _skill_upload(file)
    from ..services import skill_content
    return {"ok": True, "skill": skill_packages.public_summary(parsed),
            "files": skill_content.listing(parsed["files"]),
            "checks": [
                {"key": "archive", "ok": True, "label": "压缩包结构安全"},
                {"key": "standard", "ok": True, "label": "Agent Skill 清单有效"},
                {"key": "scripts", "ok": not parsed["hasScripts"],
                 "label": ("不含可执行脚本" if not parsed["hasScripts"]
                           else "包含脚本；运行时仍受本次任务权限约束")},
            ]}


@router.post("/skills/import")
async def import_my_skill(file: UploadFile = File(...),
                          client: Client = Depends(current_client),
                          session: AsyncSession = Depends(get_session)):
    parsed = await _skill_upload(file)
    try:
        row = await asyncio.to_thread(skill_packages.install, parsed, "personal", client.id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    from ..services import skill_preferences
    await session.refresh(client, with_for_update=True)
    skill_preferences.enable(client, row["name"])
    await session.commit()
    return {"ok": True, "skill": skill_packages.public_summary(parsed), "enabled": True}


@router.post("/skills/create")
async def create_my_skill(body: dict = Body(default_factory=dict),
                          client: Client = Depends(current_client),
                          session: AsyncSession = Depends(get_session)):
    try:
        parsed = skill_packages.create(
            body.get("name", ""), body.get("description", ""), body.get("instructions", ""))
        row = await asyncio.to_thread(skill_packages.install, parsed, "personal", client.id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    from ..services import skill_preferences
    await session.refresh(client, with_for_update=True)
    skill_preferences.enable(client, row["name"])
    await session.commit()
    return {"ok": True, "skill": skill_packages.public_summary(parsed), "enabled": True}


@router.post("/skills/runtime")
async def materialize_my_skills(
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Return an authorized immutable Skill snapshot for this execution node."""
    from ..services import skills

    requested = []
    for raw in (body.get("names") or []):
        name = str(raw or "").strip()[:64]
        if name and name not in requested:
            requested.append(name)
        if len(requested) >= 50:
            break
    if not requested:
        raise HTTPException(status_code=400, detail="请选择至少一个 Skill")

    try:
        cfg, found = await skills.catalog_with_policy(session, client, include_runner=False)
    except skills.PolicyChanged as exc:
        raise HTTPException(409, detail=str(exc)) from exc
    allowed = set(cfg.get("allowed") or [])
    visible = {
        item["name"]: item for item in found
        if item["name"] in allowed or (
            item.get("scope") == "personal" and item.get("ownerClientId") == client.id)
    }
    missing = [name for name in requested if name not in visible]
    if missing:
        raise HTTPException(status_code=404, detail="有 Skill 不存在或当前无权使用")
    portable = [visible[name] for name in sorted(requested)
                if visible[name].get("bundled")]
    if not portable:
        return Response(status_code=204, headers={
            "Cache-Control": "private, no-store",
            "X-SoduWork-Skill-Schema": "1",
        })
    try:
        payload = await asyncio.to_thread(runner_skills.build, portable)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    digest = hashlib.sha256(payload).hexdigest()
    return Response(
        content=payload,
        media_type="application/vnd.soduwork.skills+zip",
        headers={
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "X-SoduWork-Skill-Schema": "1",
            "X-SoduWork-Skill-Sha256": digest,
        },
    )


@router.get("/mcp-servers")
async def my_mcp_servers(client: Client = Depends(current_client),
                         session: AsyncSession = Depends(get_session)):
    return await mcp_servers.client_view(session, client)


@router.put("/mcp-servers")
async def save_my_mcp_servers(body: dict = Body(default_factory=dict),
                              client: Client = Depends(current_client),
                              session: AsyncSession = Depends(get_session)):
    await session.refresh(client, with_for_update=True)
    previous = {item["id"]: item for item in mcp_servers.personal_load(client)}
    rows = body.get("servers") if isinstance(body.get("servers"), list) else []
    restored = [mcp_servers.restore(item, previous.get(str(item.get("id") or ""), {}))
                for item in rows if isinstance(item, dict)]
    try:
        saved = await mcp_servers.personal_save(session, client, restored)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    view = await mcp_servers.client_view(session, client)
    company_names = {item["name"] for item in view["company"]}
    selected = [str(name)[:60] for name in (body.get("enabledCompany") or [])][:30]
    client.mcp_enabled = [name for name in selected if name in company_names]
    warning = ""
    if any(item.get("enabled") for item in saved) or client.mcp_enabled:
        from ..services import skills
        with skill_details.errors():
            cfg = await skills.load_cfg(session)
        if "mcp-tools" in set(cfg.get("allowed") or []):
            from ..services import skill_preferences
            skill_preferences.enable(client, "mcp-tools")
        else:
            warning = "连接已保存，但管理员尚未开放 mcp-tools，任务暂时不能调用"
    await session.commit()
    return {"ok": True, **await mcp_servers.client_view(session, client),
            "warning": warning}


@router.post("/mcp-servers/upsert")
async def save_my_mcp_server(body: dict = Body(default_factory=dict),
                             client: Client = Depends(current_client),
                             session: AsyncSession = Depends(get_session)):
    from ..services import mcp_personal_write, skills, skill_preferences
    saved = await mcp_personal_write.save_one(session, client, body)
    warning = ""
    if saved.get("enabled"):
        with skill_details.errors():
            cfg = await skills.load_cfg(session)
        if "mcp-tools" in set(cfg.get("allowed") or []):
            skill_preferences.enable(client, "mcp-tools")
        else:
            warning = "连接已保存，但管理员尚未开放 mcp-tools，任务暂时不能调用"
    await session.commit()
    return {"ok": True, **await mcp_servers.client_view(session, client), "warning": warning}


@router.delete("/mcp-servers/{server_id}")
async def delete_my_mcp_server(server_id: str, client: Client = Depends(current_client),
                               session: AsyncSession = Depends(get_session)):
    await session.refresh(client, with_for_update=True)
    # Keep unrelated stored rows verbatim, including disabled/legacy connections.
    rows = list(client.mcp_servers or [])
    item = next((row for row in rows if isinstance(row, dict) and row.get("id") == server_id), None)
    if item is None:
        raise HTTPException(404, "个人 MCP 不存在或无权删除")
    if mcp_servers.is_builtin(item):
        raise HTTPException(403, "SoduWork 内置 MCP 只能启用或停用，不能删除")
    client.mcp_servers = [row for row in rows if row is not item]
    from ..services import connector_oauth as oauth
    await oauth.release_removed(session, rows, client.mcp_servers)
    await session.commit()
    return {"ok": True, **await mcp_servers.client_view(session, client)}


@router.post("/mcp-servers/preflight")
async def preflight_my_mcp_server(body: dict = Body(default_factory=dict),
                                  client: Client = Depends(current_client),
                                  session: AsyncSession = Depends(get_session)):
    """Validate shape, trust and target without starting a process or network call."""
    try:
        item = _personal_mcp_spec(body, client)
        from ..services import connector_oauth as oauth
        await oauth.validate_binding(session, client, item)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    target = (item.get("url") if item.get("type") == "http"
              else item.get("templateKey"))
    return {"ok": True, "target": target, "type": item.get("type"),
            "message": "\u914d\u7f6e\u7ed3\u6784\u4e0e\u6743\u9650\u58f0\u660e\u6709\u6548\uff0c\u5c1a\u672a\u8fde\u63a5\u6267\u884c\u673a"}


@router.post("/mcp-servers/probe")
async def probe_my_mcp_server(body: dict = Body(default_factory=dict),
                              client: Client = Depends(current_client),
                              session: AsyncSession = Depends(get_session)):
    from ..services import connector_health, connector_oauth as oauth
    try:
        item = _personal_mcp_spec(body, client)
        item = await oauth.resolve(session, client, item)
    except oauth.AuthorizationUnavailable:
        return connector_health.result("error")
    except ValueError as exc:
        return {**connector_health.result("needs_auth" if body.get("oauth") else "error"), "error": str(exc)}
    runner = runner_hub.for_client(client.id)
    if runner is None:
        return connector_health.result("offline")
    if not _version_at_least(getattr(runner, "version", ""), (1, 9, 1)):
        return {**connector_health.result("error"), "error": "执行机版本过旧，请升级并重启后再测试"}
    result = await mcp_servers.probe_managed(item, preferred_runner=runner, run_on_runner=True)
    health = connector_health.metadata(result)
    return {**result, **health,
            "type": item.get("type"), "target": item.get("templateKey") or item.get("url"),
            "toolCount": len(result.get("tools") or []),
            "runner": {"runnerId": str(getattr(runner, "id", "")),
                       "host": str(getattr(runner, "host", "")),
                       "version": str(getattr(runner, "version", ""))}}


@admin_router.get("")
async def admin_capabilities(
    user: User = Depends(require_perm("integration.manage")),
    session: AsyncSession = Depends(get_session),
):
    try:
        return await capability_catalog.admin_catalog(session)
    except skills.PolicyChanged as exc:
        raise HTTPException(409, detail=str(exc)) from exc


@admin_router.put("")
async def save_admin_capability_policy(
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("integration.manage")),
    session: AsyncSession = Depends(get_session),
):
    from ..services import audit, skills
    if "cfg" in body and not isinstance(body["cfg"], dict):
        raise HTTPException(400, detail="企业能力开放策略必须是对象")
    raw = body.get("cfg") if isinstance(body.get("cfg"), dict) else body
    try:
        cfg = await skills.save_cfg(session, raw)
    except skills.PolicyChanged as exc:
        raise HTTPException(409, detail=str(exc)) from exc
    await session.commit()
    await audit.log(
        session, user, "capability.policy.update", "setting", skills.SETTING_KEY,
        "公司能力开放策略",
        {"allowed": cfg["allowed"], "byRepo": list(cfg["byRepo"])},
    )
    return {"ok": True, **await admin_capabilities(user, session)}


@admin_router.post("/skills/preflight")
async def admin_preflight_skill(
    file: UploadFile = File(...),
    user: User = Depends(require_perm("integration.manage")),
    session: AsyncSession = Depends(get_session),
):
    from ..services import skills

    parsed = await _skill_upload(file)
    previous = next((item for item in skill_packages.active()
                     if item.get("scope") == "company" and
                     item.get("name") == parsed["name"]), None)
    with skill_details.errors():
        cfg = await skills.load_cfg(session)
    same_version = bool(previous and
                        previous.get("packageChecksum") == parsed["checksum"])
    return {
        "ok": True, "skill": skill_packages.public_summary(parsed),
        "existing": bool(previous), "sameVersion": same_version,
        "willPause": bool(previous and not same_version and
                          parsed["name"] in set(cfg.get("allowed") or [])),
        "previousVersion": str((previous or {}).get("packageChecksum") or "")[:12],
    }


@admin_router.post("/skills/import")
async def admin_import_skill(
    file: UploadFile = File(...),
    user: User = Depends(require_perm("integration.manage")),
    session: AsyncSession = Depends(get_session),
):
    from ..services import audit, skills

    parsed = await _skill_upload(file)
    previous = next((item for item in skill_packages.active()
                     if item.get("scope") == "company" and
                     item.get("name") == parsed["name"]), None)
    same_version = bool(previous and
                        previous.get("packageChecksum") == parsed["checksum"])
    with skill_details.errors():
        cfg = await skills.load_cfg(session)
    was_allowed = parsed["name"] in set(cfg.get("allowed") or [])
    if was_allowed and not same_version:
        with skill_details.errors():
            cfg = await skills.save_cfg(session, {
                **cfg, "allowed": [name for name in cfg.get("allowed") or []
                                    if name != parsed["name"]],
            })
        # Close the authorization window before switching the filesystem index.
        await session.commit()
    try:
        await asyncio.to_thread(skill_packages.install, parsed, "company", "")
    except Exception:
        if was_allowed and not same_version:
            with skill_details.errors():
                cfg = await skills.save_cfg(session, {
                    **cfg, "allowed": [*(cfg.get("allowed") or []), parsed["name"]],
                })
            await session.commit()
        raise
    await audit.log(
        session, user, "capability.skill.import", "skill", parsed["name"],
        parsed["name"],
        {"checksum": parsed["checksum"],
         "previousChecksum": str((previous or {}).get("packageChecksum") or ""),
         "sameVersion": same_version, "wasAllowed": was_allowed,
         "hasScripts": parsed["hasScripts"],
         "fileCount": parsed["fileCount"]},
    )
    message = ("内容与当前版本一致，已保持原开放状态" if same_version else
               "新版已进入公司能力库，并已暂停原开放状态；审查后请重新开放" if
               previous else "已进入公司能力库；管理员开放后员工才能使用")
    return {"ok": True, "skill": skill_packages.public_summary(parsed),
            "allowed": was_allowed if same_version else False,
            "sameVersion": same_version, "message": message, "cfg": cfg}


@admin_router.post("/mcp/preflight")
async def admin_preflight_mcp_config(
    file: UploadFile = File(...),
    user: User = Depends(require_perm("integration.manage")),
    session: AsyncSession = Depends(get_session),
):
    parsed = await _mcp_upload(file)
    current = await mcp_servers.load(session)
    return mcp_import.public_preview(parsed, [item["name"] for item in current])


@admin_router.post("/mcp/import")
async def admin_import_mcp_config(
    file: UploadFile = File(...),
    user: User = Depends(require_perm("integration.manage")),
    session: AsyncSession = Depends(get_session),
):
    from ..services import audit

    parsed = await _mcp_upload(file)
    from ..services import mcp_company_write
    current = await mcp_company_write.locked_rows(session)
    result = mcp_import.import_rows(parsed, current, max_total=200)
    saved = await mcp_servers.save(session, result["rows"])
    await session.commit()
    imported_names = [item["name"] for item in result["imported"]]
    await audit.log(
        session, user, "capability.mcp.import", "setting", mcp_servers.SETTING_KEY,
        "批量导入 MCP 配置",
        {"source": parsed["source"], "imported": imported_names,
         "skipped": result["skipped"], "checksum": parsed["checksum"]},
    )
    return {
        "ok": True, "imported": imported_names, "skipped": result["skipped"],
        "servers": [mcp_servers.mask(item) for item in saved],
        "message": ("已导入 %d 个连接，均保持停用；请逐项检查、测一下再启用" %
                    len(imported_names)),
    }
