"""Authorized package browsing and explicit, immutable Skill sharing."""
from __future__ import annotations

import asyncio
from contextlib import contextmanager
from urllib.parse import quote

from fastapi import APIRouter, Body, Depends, File, HTTPException, Query, Response, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import current_client, require_perm
from ..models import Client, User
from ..services import skill_content, skill_packages, skill_sharing, skills

router = APIRouter()
admin_router = APIRouter()
admin = require_perm("integration.manage")


@contextmanager
def errors():
    try:
        yield
    except skill_sharing.Conflict as exc:
        raise HTTPException(409, str(exc)) from exc
    except skills.PolicyChanged as exc:
        raise HTTPException(409, str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(404, "Skill 或文件不存在，或当前无权查看") from exc
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


async def package(session, name, client=None):
    cfg, rows = await skills.catalog_with_policy(session, client, include_runner=False)
    allowed = set(cfg["allowed"]) | set(skills.BASELINE_SKILLS)
    row = next((x for x in rows if x["name"] == name and (
        client is None or name in allowed or
        (x.get("scope") == "personal" and x.get("ownerClientId") == client.id))), None)
    if not row:
        raise FileNotFoundError()
    content = await asyncio.to_thread(
        skill_sharing.files, row) if row.get("packageChecksum") else await asyncio.to_thread(
            skill_content.read_files, row["path"])
    checksum = skill_packages._canonical_digest(content)
    return row, content, checksum


def pinned(checksum, expected):
    if not expected or checksum != expected:
        raise skill_sharing.Conflict("Skill 内容已更新，请重新打开详情后查看")


def detail(row, content, checksum):
    return {"name": row["name"], "description": row.get("description", ""),
            "scope": row.get("scope", "company"), "checksum": checksum,
            "files": skill_content.listing(content),
            "fileCount": len(content), "unpackedBytes": sum(map(len, content.values()))}


def download(content, name, path):
    if path:
        path = skill_content.safe_path(path)
        if path not in content:
            raise FileNotFoundError()
        payload, filename = content[path], path.rsplit("/", 1)[-1]
    else:
        payload, filename = skill_content.archive(content), name + ".skill"
    return Response(payload, media_type="application/octet-stream", headers={
        "Content-Disposition": "attachment; filename*=UTF-8''" + quote(filename, safe=""),
        "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox",
    })


@router.post("/skills/preflight/content")
async def preflight_content(path: str, offset: int = Query(0, ge=0),
                            file: UploadFile = File(...), client: Client = Depends(current_client)):
    with errors():
        payload = await file.read(skill_packages._MAX_PACKAGE + 1)
        parsed = await asyncio.to_thread(skill_packages.parse, payload, file.filename or "")
        return await asyncio.to_thread(skill_content.view, parsed["files"], path, offset)


@router.get("/skills/{name}/details")
async def client_details(name: str, client: Client = Depends(current_client),
                         session: AsyncSession = Depends(get_session)):
    with errors():
        row, content, checksum = await package(session, name, client)
        result = detail(row, content, checksum)
        own = row.get("scope") == "personal" and row.get("ownerClientId") == client.id
        result["canShare"] = own
        result["canDelete"] = own and bool(row.get("packageChecksum"))
        result["builtIn"] = skills.source_info(row)[1] == "builtin"
        if own:
            result["submission"] = next((x for x in await asyncio.to_thread(
                skill_sharing.submissions, client.id) if x["name"] == name and
                x["checksum"] == checksum), None)
        return result


@router.delete("/skills/{name}")
async def delete_skill(name: str, body: dict = Body(default_factory=dict),
                       client: Client = Depends(current_client),
                       session: AsyncSession = Depends(get_session)):
    with errors():
        await session.refresh(client, with_for_update=True)
        await asyncio.to_thread(skill_packages.remove_personal, name, client.id,
                                str(body.get("checksum") or ""))
        client.skills = [item for item in (client.skills or []) if item != name]
        await session.commit()
        return {"ok": True, "name": name, "enabled": client.skills}


@router.get("/skills/{name}/content")
async def client_content(name: str, path: str, checksum: str, offset: int = Query(0, ge=0),
                         client: Client = Depends(current_client),
                         session: AsyncSession = Depends(get_session)):
    with errors():
        _, content, current = await package(session, name, client)
        pinned(current, checksum)
        return await asyncio.to_thread(skill_content.view, content, path, offset)


@router.get("/skills/{name}/download")
async def client_download(name: str, checksum: str, path: str = "",
                          client: Client = Depends(current_client),
                          session: AsyncSession = Depends(get_session)):
    with errors():
        _, content, current = await package(session, name, client)
        pinned(current, checksum)
        return await asyncio.to_thread(download, content, name, path)


@router.post("/skills/{name}/share")
async def share(name: str, body: dict = Body(default_factory=dict),
                client: Client = Depends(current_client)):
    with errors():
        result = await asyncio.to_thread(skill_sharing.submit, client.id, name,
            str(body.get("checksum") or ""), str(body.get("note") or ""), body.get("resubmit") is True)
        return {"ok": True, "submission": result}


@admin_router.get("/skill-submissions")
async def submissions(user: User = Depends(admin), session: AsyncSession = Depends(get_session)):
    rows = await asyncio.to_thread(skill_sharing.submissions)
    with errors():
        cfg = await skills.load_cfg(session)
    active = {x["name"]: x for x in await asyncio.to_thread(skill_packages.active)}
    for row in rows:
        row["published"] = (row["status"] == "approved" and row["name"] in cfg["allowed"] and
                            active.get(row["name"], {}).get("packageChecksum") == row["checksum"])
    return {"items": rows}


@admin_router.get("/skill-submissions/{submission_id}")
async def submission_details(submission_id: str, user: User = Depends(admin)):
    with errors():
        row = await asyncio.to_thread(skill_sharing.get, submission_id)
        content = await asyncio.to_thread(skill_sharing.files, row)
        return {**detail(row, content, row["checksum"]), "submission": skill_sharing.public(row)}


@admin_router.get("/skill-submissions/{submission_id}/content")
async def submission_content(submission_id: str, path: str, checksum: str,
                             offset: int = Query(0, ge=0), user: User = Depends(admin)):
    with errors():
        row = await asyncio.to_thread(skill_sharing.get, submission_id)
        pinned(row["checksum"], checksum)
        content = await asyncio.to_thread(skill_sharing.files, row)
        return await asyncio.to_thread(skill_content.view, content, path, offset)


@admin_router.get("/skill-submissions/{submission_id}/download")
async def submission_download(submission_id: str, checksum: str, path: str = "",
                              user: User = Depends(admin)):
    with errors():
        row = await asyncio.to_thread(skill_sharing.get, submission_id)
        pinned(row["checksum"], checksum)
        content = await asyncio.to_thread(skill_sharing.files, row)
        return await asyncio.to_thread(download, content, row["name"], path)


@admin_router.post("/skill-submissions/{submission_id}/review")
async def review(submission_id: str, body: dict = Body(default_factory=dict),
                 user: User = Depends(admin), session: AsyncSession = Depends(get_session)):
    from ..services import audit
    with errors():
        # Validation and pointer publication happen under the same cross-worker lock.
        result = await asyncio.to_thread(skill_sharing.review, submission_id,
            str(body.get("checksum") or ""), str(body.get("decision") or ""),
            user.id, str(body.get("note") or ""))
        if result.pop("newlyApproved", False):
            await skills.allow_shared_skill(session, result["name"])
        skills.clear_scan_cache()
        cfg = await skills.load_cfg(session)
        await audit.log(session, user, "capability.skill.review", "skill", result["name"],
                        result["name"], {"checksum": result["checksum"], "status": result["status"]})
        return {"ok": True, "submission": result, "allowed": result["name"] in cfg["allowed"]}
