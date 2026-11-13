"""Apply connector selection intent without replacing connection configuration."""
from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from ..db import get_session
from ..deps import current_client
from ..models import Client
from ..services import mcp_servers, skills, skill_preferences

router = APIRouter()


@router.patch("/mcp-servers/selection")
async def select_mcp_servers(body: dict = Body(default_factory=dict),
                             client: Client = Depends(current_client),
                             session: AsyncSession = Depends(get_session)):
    changes = body.get("changes")
    if not isinstance(changes, list) or not 1 <= len(changes) <= 50:
        raise HTTPException(400, "请选择需要启用或停用的连接器")
    for item in changes:
        if (not isinstance(item, dict) or item.get("kind") not in ("personal", "company")
                or not isinstance(item.get("id"), str) or not item["id"]
                or len(item["id"]) > 200 or type(item.get("enabled")) is not bool):
            raise HTTPException(400, "连接器选择格式不正确")
    await session.refresh(client, with_for_update=True)
    view = await mcp_servers.client_view(session, client)
    personal_ids = {row["id"] for row in view["personal"]}
    company_names = {row["name"] for row in view["company"]}
    # Validate the whole batch before mutation. Never revive a removed connection.
    for item in changes:
        available = personal_ids if item["kind"] == "personal" else company_names
        if item["id"] not in available:
            raise HTTPException(409, "连接器已变更或不可用，请刷新目录后重试")
    rows = list(client.mcp_servers or [])
    selected = set(client.mcp_enabled or [])
    for item in changes:
        if item["kind"] == "personal":
            rows = [{**row, "enabled": item["enabled"]}
                    if isinstance(row, dict) and row.get("id") == item["id"] else row
                    for row in rows]
        elif item["enabled"]:
            selected.add(item["id"])
        else:
            selected.discard(item["id"])
    if len(selected & company_names) > 30:
        raise HTTPException(400, "最多同时选择 30 个公司连接器")
    client.mcp_servers = rows
    client.mcp_enabled = sorted(selected)
    warning = ""
    if any(item["enabled"] for item in changes):
        try:
            cfg = await skills.load_cfg(session)
        except skills.PolicyChanged as exc:
            raise HTTPException(409, detail=str(exc)) from exc
        if "mcp-tools" in set(cfg.get("allowed") or []):
            skill_preferences.enable(client, "mcp-tools")
        else:
            warning = "连接已保存，但管理员尚未开放 mcp-tools，任务暂时不能调用"
    await session.commit()
    return {"ok": True, **await mcp_servers.client_view(session, client), "warning": warning}
