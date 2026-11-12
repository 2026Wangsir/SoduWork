"""Read-only Markdown export of one authorized, consistently observed delivery."""
from __future__ import annotations

import html
import re
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from urllib.parse import urlsplit

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am, db, models
from . import delivery_bundle, delivery_truth, release_control, task_access, task_requirements


def _dict(value):
    return value if isinstance(value, dict) else {}


def _list(value):
    return value if isinstance(value, list) else []


def _md(value):
    """Keep recorded text inert, including Markdown images and embedded HTML."""
    value = re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", str(value or ""))
    return re.sub(r"([\\`*_{}\[\]()#+.!|>\-])", r"\\\1", html.escape(value, quote=False))


def _time(value):
    if not value:
        return "未记录"
    if isinstance(value, datetime):
        return value.replace(tzinfo=value.tzinfo or timezone.utc).astimezone(timezone.utc).isoformat()
    return "未记录"


def _utc(value):
    return value.replace(tzinfo=value.tzinfo or timezone.utc).astimezone(timezone.utc)


def _url(value):
    """Never copy signed URLs, credentials, download tickets or executable schemes."""
    value = str(value or "").strip()
    try:
        parsed = urlsplit(value)
        if (parsed.scheme not in {"https", "http"} or not parsed.hostname or
                parsed.username or parsed.password or parsed.query or parsed.fragment or
                re.search(r"[\s<>\\]", value)):
            return ""
    except ValueError:
        return ""
    return value.replace("(", "%28").replace(")", "%29")


@asynccontextmanager
async def read_snapshot(engine):
    """Use one database snapshot, including SQLite's legacy SELECT transaction mode."""
    async with engine.connect() as connection:
        dialect = connection.dialect.name
        if dialect == "postgresql":
            # A normal PostgreSQL READ COMMITTED transaction can mix two deliveries.
            await connection.exec_driver_sql(
                "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        elif dialect == "sqlite":
            # SQLAlchemy's logical begin does not make legacy sqlite3 SELECTs transactional.
            await connection.exec_driver_sql("BEGIN")
        else:
            raise RuntimeError("Acceptance summary snapshots require PostgreSQL or SQLite")
        try:
            async with AsyncSession(bind=connection, autoflush=False, expire_on_commit=False) as session:
                yield session
        finally:
            await connection.rollback()


async def _identity(session, authenticated):
    client = await session.get(models.Client, authenticated.id)
    if (client is None or client.user_ref != authenticated.user_ref or
            client.auth_version != authenticated.auth_version or client.revoked_at or
            client.auth_state != "active"):
        raise HTTPException(401, "账号或设备会话已变化，请重新登录")
    actor = await session.get(models.User, client.user_ref) if client.user_ref else None
    if actor is None or not actor.is_active or actor.account_deleted_at:
        raise HTTPException(401, "请先登录有效账号")
    return client


def _criteria(request):
    context = _dict(request.context) if request else {}
    values = context.get("acceptanceCriteria") or context.get("criteria")
    if not values:
        values = _dict(context.get("gate")).get("criteria")
    return [str(_dict(value).get("label") or _dict(value).get("name") or "")
            if isinstance(value, dict) else str(value)
            for value in _list(values) if value]


def _files(artifact):
    if artifact.kind == "code":
        return []
    manifest = delivery_truth.artifact_manifest(artifact)
    entries = _list(manifest.get("primary")) + _list(manifest.get("supporting"))
    seen, out = set(), []
    for value in entries:
        item = _dict(value)
        key = str(item.get("id") or item.get("name") or "")
        if key and key not in seen:
            seen.add(key)
            out.append(item)
    return out


async def _execution(session, artifact):
    """Only a completed runtime record still belonging to this fixed delivery is evidence."""
    if not artifact.source_ref:
        return {}
    row = await session.scalar(select(am.ExecutionSession).where(
        am.ExecutionSession.task_id == artifact.task_id,
        am.ExecutionSession.ref == artifact.source_ref))
    if row is None or row.state != "done" or not row.finished_at:
        return {}
    if (not artifact.created_at or not row.updated_at or
            _utc(row.finished_at) > _utc(artifact.created_at) or
            _utc(row.updated_at) > _utc(artifact.created_at)):
        # A resumed execution ref may already describe a later turn or model selection.
        return {}
    identity = _dict(_dict(row.metadata_).get("executionIdentity"))
    if not identity.get("agentSessionId"):
        return {}
    model = str(row.model or "")
    if model.startswith("local:"):
        model = ""
    return {"agent": identity.get("agentName") or row.engine or "", "model": model}


async def _collect(session, client, tid, expected_artifact, expected_requirement):
    client = await _identity(session, client)
    task = await task_requirements.get(session, client, tid)
    if not await task_access.can_view(session, client, task):
        raise HTTPException(403, "你可以查看需求，但没有交付与验收记录的导出权限")
    artifact = await release_control.latest_artifact(session, tid, stream="delivery")
    if artifact is None:
        raise HTTPException(409, "当前还没有固定的交付版本，请先提交验收")
    version = int(task.requirement_version or 1)
    if ((expected_artifact and artifact.id != expected_artifact) or
            (expected_requirement is not None and version != expected_requirement)):
        raise HTTPException(409, "需求或交付版本已经变化，请刷新后重新导出")
    request = await session.scalar(select(am.ApprovalRequest).where(
        am.ApprovalRequest.task_id == tid,
        am.ApprovalRequest.artifact_version_id == artifact.id,
        am.ApprovalRequest.action == "review",
    ).order_by(am.ApprovalRequest.created_at.desc(), am.ApprovalRequest.id.desc()).limit(1))
    decisions = await release_control.decisions_for(session, request.id) if request else []
    files = _files(artifact)
    ids = [str(item.get("id")) for item in files if item.get("id")]
    attachments = list((await session.scalars(select(models.Attachment).where(
        models.Attachment.task_id == tid, models.Attachment.id.in_(ids)))).all()) if ids else []
    available = {row.id for row in attachments
                 if await task_requirements.can_read_attachment(session, client, task, row)}
    return {"task": task, "content": task_requirements.public_content(task),
            "artifact": artifact, "request": request, "decisions": decisions,
            "files": files, "available": available, "execution": await _execution(session, artifact),
            "exportedAt": datetime.now(timezone.utc).isoformat(), "requirementVersion": version}


def _render(snapshot):
    task, artifact, request = (snapshot[key] for key in ("task", "artifact", "request"))
    content, execution = snapshot["content"], snapshot["execution"]
    title = str(content.get("title") or "未命名需求")
    phase = task_requirements.stage(task)
    if phase != "closed" and request is not None and request.status == "pending":
        phase = "reviewing"
    status = {"intake": "收集箱", "clarifying": "待补充", "ready": "待开始", "delivering": "进行中",
              "reviewing": "待验收", "delivered": "已完成", "closed": "已关闭"}.get(phase, phase)
    approval_status = {"pending": "待验收", "approved": "已通过", "rejected": "已退回",
                       "cancelled": "已取消", "revoked": "已撤销", "expired": "已过期"}
    lines = ["# " + _md(title) + " — 交付与验收摘要", "",
             "- 导出时间（UTC）：" + _md(snapshot["exportedAt"]),
             "- 需求 ID：" + _md(task.id),
             "- 交付版本 ID：" + _md(artifact.id),
             "- 交付版本：v" + str(artifact.seq),
             "- 交付摘要（checksum）：" + _md(artifact.checksum or "未记录"),
             "- 验收票 ID：" + _md(request.id if request else "未记录"),
             "", "## 需求信息（导出时的当前版本）", "",
             "- 当前需求版本：" + str(snapshot["requirementVersion"]),
             "- 当前状态：" + _md(status) + ("（已归档）" if task.archived_at else ""),
             "", "交付记录未保存完整的历史需求正文；以下标题、背景和完成标准为导出时的当前需求，不代表历史验收基线。",
             "", "### 背景与说明", "", _md(content.get("note") or "未填写"),
             "", "### 当前完成标准", ""]
    lines.extend("- " + _md(value) for value in (task.acceptance_criteria or []))
    if not task.acceptance_criteria:
        lines.append("未记录")
    lines.extend(["", "## 固定交付版本", "",
                  "- 创建时间（UTC）：" + _md(_time(artifact.created_at)),
                  "- 交付类型：" + _md(artifact.kind), ""])
    if artifact.commit_sha:
        lines.append("- 代码提交：" + _md(artifact.commit_sha))
    link = _url(artifact.url)
    if link:
        lines.append("- [成果链接](" + link + ")")
    elif artifact.url:
        lines.append("- 成果链接：不可导出带凭据或临时参数的链接，请在应用内查看")
    for item in snapshot["files"]:
        label = str(item.get("name") or item.get("filename") or "未命名交付物")
        aid = str(item.get("id") or "")
        lines.append("- " + _md(label) + ("（文件记录缺失或不可访问）" if aid not in snapshot["available"] else ""))
        if aid in snapshot["available"]:
            # Stable authenticated route, never a bearer download ticket in the exported document.
            lines.append("  - 应用内附件 ID：" + _md(aid) + "（需登录查看）")
        validation = _dict(item.get("validation"))
        lines.append("  - 固定文件校验：" + _md(validation.get("state") or "未记录"))
        if validation.get("reason"):
            lines.append("  - 校验说明：" + _md(validation["reason"]))
    text = _dict(artifact.manifest).get("text")
    if text:
        lines.extend(["", "### 固定文本交付", "", _md(text)])
    if not snapshot["files"] and not link and not text and not artifact.commit_sha:
        lines.append("未记录可下载的交付物；这不代表验收通过。")
    lines.extend(["", "## 执行归属", "",
                  "- 实际 Agent（匹配本交付的已完成运行记录）：" + _md(execution.get("agent") or "未记录"),
                  "- 实际模型（匹配本交付的已完成运行记录）：" + _md(execution.get("model") or "未记录"),
                  "", "缺失的运行信息不会用当前模型配置或后续执行记录补齐。",
                  "", "## 验收记录（仅本交付版本）", "",
                  "- 验收状态：" + _md(approval_status.get(request.status, "未记录") if request else "未记录"),
                  "- 验收结束时间（UTC）：" + _md(_time(request.resolved_at) if request else "未记录"),
                  "", "需求完成状态、文件存在和文件结构校验都不等同于验收通过。",
                  "", "### 固定验收标准", ""])
    criteria = _criteria(request)
    lines.extend(["- " + _md(value) for value in criteria] or ["未记录；不使用当前需求标准伪造历史基线。"])
    lines.extend(["", "### 验收决定", ""])
    for decision in snapshot["decisions"]:
        lines.extend(["- " + _md(decision.user_name or "未记录姓名") + "：" +
                      _md({"approve": "通过", "reject": "退回"}.get(decision.decision, "未记录")),
                      "  - 时间（UTC）：" + _md(_time(decision.created_at)),
                      "  - 意见：" + _md(decision.note or "未填写")])
    if not snapshot["decisions"]:
        lines.append("尚无验收决定。")
    lines.extend(["", "### 已记录的逐项验证", ""])
    checks = []
    for decision in snapshot["decisions"]:
        gate = _dict(decision.gate_snapshot)
        subject_version = _dict(gate.get("subject")).get("artifactVersionId")
        if subject_version and subject_version != artifact.id:
            continue
        for evidence in _list(gate.get("evidence")):
            evidence = _dict(evidence)
            if evidence.get("kind") == "check":
                checks.append({"label": evidence.get("title"),
                               "result": _dict(evidence.get("verification")).get("state"),
                               "evidence": evidence.get("summary") or evidence.get("value")})
    reports = _dict(_dict(request.context).get("aiAcceptanceReports")) if request else {}
    for value in reports.values():
        value = _dict(value)
        if value.get("artifactVersionId") == artifact.id:
            report_agent = _dict(value.get("execution")).get("agent")
            lines.append("- 验收 Agent（报告记录）：" + _md(report_agent or "未记录"))
            lines.append("- 报告绑定的需求版本：" + _md(value.get("requirementVersion") or "未记录"))
            checks.extend(_list(_dict(value.get("report")).get("checks")))
    for check in checks:
        check = _dict(check)
        lines.append("- " + _md(check.get("label") or check.get("criterion") or "未记录名称") +
                     "：" + _md(check.get("result") or "未记录") + " — " + _md(check.get("evidence") or "未记录证据"))
    if not checks:
        lines.append("未记录逐项验证结果；导出不会运行测试或自动验收。")
    return {"filename": delivery_bundle.archive_filename(title)[:-4] + "-acceptance.md",
            "markdown": "\n".join(lines) + "\n", "artifactVersionId": artifact.id,
            "requirementVersion": snapshot["requirementVersion"], "exportedAt": snapshot["exportedAt"]}


async def export(client, tid, *, artifact_version_id=None, requirement_version=None, engine=None):
    async with read_snapshot(engine if engine is not None else db.engine) as session:
        snapshot = await _collect(session, client, tid, artifact_version_id, requirement_version)
        return _render(snapshot)
