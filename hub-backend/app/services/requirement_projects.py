"""Validate explicit requirement project selections against the existing Hub catalog scope."""
from fastapi import HTTPException
from sqlalchemy import or_, select, update

from .. import models


async def visible_query(session, client):
    from . import inbox
    _, scope = await inbox._me_scope(session, client)
    query = select(models.Project).where(models.Project.status == "active")
    return query.where(or_(models.Project.org_id.in_(scope), models.Project.org_id.is_(None))) \
        if scope else query.where(models.Project.org_id.is_(None))


async def _validate_selection(session, client, project_id, repo_id):
    if not project_id:
        return
    if session.get_bind().dialect.name == "sqlite":
        # SQLite ignores FOR UPDATE. Reserve its writer before reading catalog
        # authority, preserving all stored values until this task write commits.
        await session.execute(update(models.Project).where(models.Project.id == project_id)
            .values(status=models.Project.status).execution_options(synchronize_session=False))
    query = await visible_query(session, client)
    project = await session.scalar(query.where(models.Project.id == project_id)
        .with_for_update().execution_options(populate_existing=True))
    if project is None:
        raise HTTPException(404, "项目不存在、已停用或当前账号不可见，请重新选择")
    if repo_id:
        repo = await session.scalar(select(models.Repo).where(models.Repo.id == repo_id)
            .with_for_update().execution_options(populate_existing=True))
        if repo is None or str(repo.project_id or "") != project_id:
            raise HTTPException(409, "关联仓库与所选项目不一致，请重新选择")


async def prepare_create(session, client, data):
    # Repo-only legacy callers retain their established association behavior.
    project_id = str(data.get("projectId") or "").strip()
    if not project_id:
        return
    repo_id = str(data.get("repoId") or "").strip()
    await _validate_selection(session, client, project_id, repo_id)
    data["projectId"] = project_id
    if "repoId" in data:
        data["repoId"] = repo_id


async def prepare_update(session, client, task, data):
    current = str(task.project_id or "").strip()
    selected = str(data.get("projectId") or "").strip() if "projectId" in data else current
    current_repo = str(task.repo_id or "").strip()
    selected_repo = str(data.get("repoId") or "").strip() if "repoId" in data else current_repo
    changed = "projectId" in data and selected != current
    repo_changed = "repoId" in data and selected_repo != current_repo
    # Persist the identifiers we validate. A semantic no-op preserves the exact
    # historical value instead of silently migrating an existing association.
    if "projectId" in data:
        data["projectId"] = (selected or None) if changed else task.project_id
    if "repoId" in data:
        data["repoId"] = selected_repo if repo_changed else task.repo_id
    if not changed and not repo_changed:
        # Missing/retired legacy references must not block unrelated edits or be erased.
        return
    if changed:
        from . import task_access
        if not task_access.is_owner(task, client):
            raise HTTPException(403, "只有需求所属客户端可以更改项目")
        if current_repo:
            raise HTTPException(409, "项目由已关联的仓库确定，不能在此更改或取消")
        if data.get("requirementVersion") is None:
            raise HTTPException(409, "请重新加载需求后再更改项目")
    # Existing execution-history and requirement-version locks remain authoritative
    # in task_requirements.apply; selecting a project never rewrites a repository.
    await _validate_selection(session, client, selected, selected_repo)
