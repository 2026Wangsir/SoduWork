"""Automation execution validation, capability checks and machine preflight."""
from __future__ import annotations

from types import SimpleNamespace

from sqlalchemy.ext.asyncio import AsyncSession

from .. import models
from .schedule_repo_scope import resolve_repo
from .schedule_timing import validate as validate_timing
from .schedule_run_contracts import (
    clean_plugin_inputs, clean_required_capabilities,
    normalize_personal_plugin_snapshot,
)


# A schedule declares business capabilities, never a concrete automation library.
# The Runner passport decides whether one machine can actually accept the work.
CAPABILITY_SKILLS = {
    "browser": "browser-use", "computer": "computer-use", "office": "office",
}


def normalize_conversation_schedule(s):
    """Keep ordinary-chat routing while retaining an optional local plugin.

    Enterprise workflow bindings still belong to the retired task/workflow path
    and are cleared at the dispatch boundary. A personal plugin is different: the
    desktop worker resolves its local body and opens the same ordinary chat with
    a version lock, so clearing it here made the editor's plugin selector appear
    to work while silently dropping the user's choice.
    """
    s.plugin_binding_id = ""
    # Prompt parameters and the personal-plugin snapshot remain part of the
    # ordinary conversation envelope; only enterprise bindings and workflow
    # routing are retired.
    s.flow = False
    return s

def required_skill_names(raw) -> list[str]:
    return [CAPABILITY_SKILLS[key] for key in clean_required_capabilities(raw)
            if key in CAPABILITY_SKILLS]


def _capability_remediation(runner, verdict) -> tuple[str, str]:
    """Classify capability remediation as grant, upgrade, or install and return an actionable
    message plus UI routing key.
    """
    from . import execution_capabilities
    host = str(getattr(runner, "host", "") or "") or "这台执行机"
    report = dict(verdict.get("report") or {})
    facts = {str(item.get("key") or ""): item
             for item in report.get("items") or [] if isinstance(item, dict)}
    missing = [str(key) for key in verdict.get("missing") or []]
    if any((facts.get(key) or {}).get("installed") is True
           and (facts.get(key) or {}).get("authorized") is False
           for key in missing):
        return "grant", execution_capabilities.error_message(verdict, host)
    if not int(report.get("reportedAt") or 0):
        return "upgrade", ("这台 SoduWork 的 Runner 版本过旧，没有上报本机能力，"
                           "请升级 SoduWork 客户端后重试")
    return "install", execution_capabilities.error_message(verdict, host)


def capability_save_blocker(s) -> str:
    """Precheck capability contracts before save or enable. Permit offline devices for future
    execution, but reject confirmed missing capabilities or grants on an online reporting
    Runner.
    """
    required = clean_required_capabilities(
        getattr(s, "required_capabilities", None))
    if not required:
        return ""
    from . import runner_hub
    runner = runner_hub.for_client(str(getattr(s, "owner_client_id", "") or ""))
    if runner is None:
        return ""
    verdict = runner_hub.capability_verdict(runner, required)
    if verdict.get("ok"):
        return ""
    _remedy, message = _capability_remediation(runner, verdict)
    return message


async def validate_direct_execution(session: AsyncSession, s):
    """Validate policy and Skill availability without requiring a Runner online."""
    capabilities = clean_required_capabilities(
        getattr(s, "required_capabilities", None))
    s.required_capabilities = capabilities
    if not capabilities:
        return []
    client_id = str(getattr(s, "owner_client_id", "") or "")
    client = await session.get(models.Client, client_id) if client_id else None
    if client is None:
        raise ValueError("请先选择任务归属的 SoduWork")
    from . import skills
    return await skills.resolve_named(
        session, required_skill_names(capabilities), client)


async def validate_selected_model(session: AsyncSession, s) -> None:
    """Reject a saved model that the selected Agent cannot actually use.

    The editor performs the same check during preflight, but save and immediate
    run are also public API boundaries.  Keeping this validation here prevents
    older clients (or direct API callers) from persisting a gateway model that is
    unavailable for the selected Agent and only discovering it after dispatch.
    An empty value deliberately means "follow the Agent default" for legacy rows.
    """
    model_name = str(getattr(s, "model_name", "") or "").strip()
    if not model_name:
        return
    aid = str(getattr(s, "assignee_id", "") or "").strip()
    if not aid:
        raise ValueError("指定模型前请先选择执行 Agent")
    client_id = str(getattr(s, "owner_client_id", "") or "").strip()
    client = await session.get(models.Client, client_id) if client_id else None
    if client is None:
        raise ValueError("指定模型前请先选择任务归属的 SoduWork")
    from . import ai_exec
    ctx = await ai_exec.load(session, force=True)
    model_kind = aid if aid.startswith("local:") else (
        "local:" + aid.rsplit(":", 1)[-1] if aid.startswith("runner:") else aid)
    state = await _schedule_model_readiness(session, client, ctx, model_kind, model_name)
    if not state.get("ok"):
        raise ValueError(str(state.get("detail") or "所选模型不可用")[:240])


async def _schedule_model_readiness(session, client, ctx: dict,
                                    model_kind: str, model_name: str) -> dict:
    """Resolve schedule model choices from the same live catalog as the editor.

    Legacy Runner dispatch keeps using the synchronous ``ai_exec`` model list,
    but conversation schedules are populated from ``model_catalog``.choices().
    Native Agents (currently Codex) retain their own model validation.
    """
    from . import agent_execution_options, agent_route_selection, model_catalog

    model_kind, model_name = str(model_kind or "").strip(), str(model_name or "").strip()
    if not model_name:
        return {"ok": True, "model": "", "detail": "跟随底座默认模型"}
    if agent_execution_options.is_native_model_kind(model_kind) or not agent_execution_options.supports_soduwork_model_kind(model_kind):
        return agent_route_selection.model_readiness(ctx, model_kind, model_name)
    try:
        choices = await model_catalog.choices(session, client)
    except Exception:
        # Older isolated databases may not yet have the model catalog tables.
        # Preserve the legacy readiness check there; current Hubs use the live
        # catalog above and therefore do not silently accept removed models.
        return agent_route_selection.model_readiness(ctx, model_kind, model_name)
    allowed = {str(choices.get("default") or "").strip()}
    allowed.update(str(item or "").strip() for item in choices.get("list") or [])
    allowed.discard("")
    if model_name not in allowed:
        return {"ok": False, "model": model_name,
                "detail": f"模型「{model_name}」未在当前企业开放的模型清单中"}
    return {"ok": True, "model": model_name, "detail": f"模型「{model_name}」可用"}


async def preflight_execution(session: AsyncSession, s,
                              org_ids: set[str] | None = None) -> dict:
    """Hub owns runtime policy; device-only dependencies need a separate check."""
    result = await _preflight_execution(session, s, org_ids=org_ids)
    if result.get("mode") != "personal" or result.get("state") == "blocked":
        return result
    # Installation, setup and platform credentials are private to the owner
    # device. An online Runner is not evidence that these dependencies work.
    execution_ready = result.get("state") == "ready"
    result["executionReady"] = execution_ready
    result["deviceDependencies"] = {
        "state": "waiting",
        "ownerClientId": str(getattr(s, "owner_client_id", "") or ""),
        "plugin": normalize_personal_plugin_snapshot(s),
    }
    result["checks"] = [
        row for row in result.get("checks", []) if row.get("key") != "plugin"
    ] + [{"key": "device-dependencies", "state": "waiting",
          "label": "个人插件和连接器待本机验证"}]
    if execution_ready:
        result["state"] = "waiting"
        result["message"] = "执行机已就绪；个人插件和连接器待本机验证"
    return result


async def _preflight_execution(session: AsyncSession, s,
                               org_ids: set[str] | None = None) -> dict:
    """Explain whether an automation is valid and whether a machine is ready now."""
    validate_timing(s)
    await resolve_repo(session, s, org_ids=org_ids)
    personal_key = str(getattr(s, "personal_plugin_key", "") or "")
    binding_id = str(getattr(s, "plugin_binding_id", "") or "")
    if binding_id and personal_key:
        return {"state": "blocked", "mode": "personal",
                "message": "企业插件绑定与个人插件只能二选一",
                "checks": [{"key": "configuration", "state": "blocked",
                            "label": "只能选择一种插件运行方式"}]}
    personal = {}
    if personal_key:
        try:
            personal = normalize_personal_plugin_snapshot(s)
        except ValueError as exc:
            return {"state": "blocked", "mode": "personal",
                    "message": str(exc)[:240],
                    "checks": [{"key": "plugin", "state": "blocked",
                                "label": str(exc)[:120]}]}
    if binding_id:
        await validate_execution(session, s, org_ids=org_ids)
        return {"state": "ready", "mode": "plugin",
                "message": "插件、工作流与运行权限已通过预检",
                "checks": [{"key": "workflow", "state": "ready",
                            "label": "企业工作流绑定有效"}]}
    # Personal plugins use direct dispatch with device-local method context and the same capability probes.
    mode = "personal" if personal_key else "direct"
    skills = await validate_direct_execution(session, s)
    required = clean_required_capabilities(
        getattr(s, "required_capabilities", None))
    client_id = str(getattr(s, "owner_client_id", "") or "")
    client = await session.get(models.Client, client_id) if client_id else None
    aid = str(getattr(s, "assignee_id", "") or "")
    if client is None:
        return {"state": "blocked", "mode": mode,
                "message": "请先选择任务归属的 SoduWork",
                "checks": [{"key": "runner", "state": "blocked",
                            "label": "尚未选择执行设备"}]}
    if getattr(s, "owner_user_id", None) and s.owner_user_id != client.user_ref:
        return {"state": "blocked", "mode": mode,
                "message": "执行设备的登录账号已变更，请原账号登录后再执行"}
    if not aid:
        return {"state": "blocked", "mode": mode,
                "message": "请先选择执行 Agent",
                "checks": [{"key": "agent", "state": "blocked",
                            "label": "尚未选择执行 Agent"}]}
    from . import ai_exec
    try:
        ctx = await ai_exec.load(session, force=True)
    except Exception as exc:  # noqa: BLE001
        return {"state": "blocked", "mode": mode,
                "message": ("读取 Agent 配置失败：" + str(exc))[:240]}
    model_name = str(getattr(s, "model_name", "") or "").strip()
    model_kind = aid if aid.startswith("local:") else (
        "local:" + aid.rsplit(":", 1)[-1] if aid.startswith("runner:") else aid)
    model_state = await _schedule_model_readiness(session, client, ctx, model_kind, model_name)
    if not model_state.get("ok"):
        detail = str(model_state.get("detail") or "模型不可用")[:240]
        return {"state": "blocked", "mode": mode, "message": detail,
                "checks": [{"key": "model", "state": "blocked", "label": detail[:180]}]}
    import asyncio
    from fastapi import HTTPException
    from . import conversation_handoffs, runner_hub
    parts = aid.split(":", 2)
    target = runner_hub.get(parts[1]) if len(parts) == 3 and parts[0] == "runner" else None
    if aid.startswith("runner:") and target is None:
        return {"state": "waiting", "mode": mode,
                "message": "所选执行机不在线，请保持本人电脑或云端执行机在线；不会自动改派"}
    remote = bool(target and str(target.client_id or "") != str(client.id))
    if remote and personal_key:
        return {"state": "blocked", "mode": mode,
                "message": "云端自动化当前只支持普通会话；个人插件请选择原执行设备"}
    try:
        if remote:
            # Use the same target authorization as the cloud run, without dispatching.
            picked = await conversation_handoffs.destination(session, client, {
                "assigneeId": aid, "agentId": parts[2], "model": model_name,
                "requiredSkills": required_skill_names(required),
            })
            verdict = runner_hub.capability_verdict(target, required)
            if not verdict.get("ok"):
                remedy, message = _capability_remediation(target, verdict)
                return {"state": "waiting", "mode": mode, "message": message,
                        "requiredCapabilities": required, "remedy": remedy}
        else:
            picked = await asyncio.to_thread(
                ai_exec.resolve_requested_sync, ctx, aid,
                str(getattr(s, "assignee_type", "") or "agent"),
                client.id, "", required)
    except HTTPException as exc:
        return {"state": "waiting", "mode": mode, "message": str(exc.detail)[:240],
                "requiredCapabilities": required}
    except Exception as exc:  # noqa: BLE001
        return {"state": "waiting", "mode": mode,
                "message": ("暂时无法探测执行机：" + str(exc))[:240],
                "requiredCapabilities": required}
    if picked is None:
        # When an online Runner cannot satisfy requirements, report the actual cause.
        # Distinguish missing grants, components, and outdated capability reporting.
        if required:
            from . import runner_hub
            mine = runner_hub.for_client(client.id)
            if mine is not None:
                verdict = runner_hub.capability_verdict(mine, required)
                if not verdict.get("ok"):
                    remedy, message = _capability_remediation(mine, verdict)
                    return {"state": "waiting", "mode": mode,
                            "message": message,
                            "requiredCapabilities": required,
                            "requiredSkills": [item.get("name") for item in skills],
                            "remedy": remedy,
                            "checks": [{"key": "capability", "state": "waiting",
                                        "label": message}]}
        labels = "、".join(required_skill_names(required)) or "所选 Agent"
        return {"state": "waiting", "mode": mode,
                "message": "配置有效；等待具备 %s 的 Runner 在线" % labels,
                "requiredCapabilities": required,
                "requiredSkills": [item.get("name") for item in skills],
                "checks": [{"key": "runner", "state": "waiting",
                            "label": "等待可用 Runner"}]}
    policy = str(personal.get("versionPolicy") or "")
    plugin_message = ("固定 v" + str(personal.get("version") or "")
                      if policy == "pinned" else "跟随本机当前版本")
    return {
        "state": "ready", "mode": mode,
        **({"executionMode": "soduwork.cloud-automation/v1"} if remote else {}),
        "message": (("执行条件已就绪；个人插件" + plugin_message)
                    if personal_key else "执行条件已就绪"),
        "requiredCapabilities": required,
        "requiredSkills": [item.get("name") for item in skills],
        "pluginSnapshot": personal,
        "checks": ([{"key": "plugin", "state": "ready",
                     "label": "个人插件" + plugin_message}]
                   if personal_key else []) + [
            {"key": "runner", "state": "ready", "label": "Runner 已在线"},
            {"key": "capability", "state": "ready", "label": "能力授权满足"},
        ],
        "machine": {
            "id": str(picked.get("runnerId") or picked.get("id") or ""),
            "name": str(picked.get("host") or picked.get("name") or "可用执行机"),
            "agent": str(picked.get("cli") or picked.get("name") or ""),
        },
    }


async def validate_execution(session: AsyncSession, s,
                             org_ids: set[str] | None = None):
    """Validate the selected immutable automation binding at save and run time."""
    normalize_conversation_schedule(s)
    validate_timing(s)
    binding_id = str(getattr(s, "plugin_binding_id", "") or "")
    personal_key = str(getattr(s, "personal_plugin_key", "") or "")
    if personal_key and binding_id:
        raise ValueError("企业插件绑定与个人插件只能二选一")
    repo = await resolve_repo(session, s, org_ids=org_ids)
    if personal_key:
        # Hub validates metadata; the owner Runner verifies the exact local body.
        # This preserves device privacy while making each scheduled run reproducible.
        normalize_personal_plugin_snapshot(s)
        if not str(getattr(s, "assignee_id", "") or ""):
            raise ValueError("个人插件自动化还需要选择执行 Agent")
        s.plugin_inputs = clean_plugin_inputs(getattr(s, "plugin_inputs", {}) or {})
        await validate_selected_model(session, s)
        await validate_direct_execution(session, s)
        return None
    if not binding_id:
        await validate_selected_model(session, s)
        await validate_direct_execution(session, s)
        return None
    if str(getattr(s, "model_name", "") or "").strip():
        raise ValueError("企业插件自动化不支持单独指定模型")
    client_id = str(getattr(s, "owner_client_id", "") or "")
    client = await session.get(models.Client, client_id) if client_id else None
    if client is None:
        raise ValueError("请先选择任务归属的 SoduWork")
    task = SimpleNamespace(
        owner_client_id=client.id,
        project_id=(repo.project_id if repo else None),
        repo_id=(repo.id if repo else None),
    )
    from .. import automation_models as am
    from . import plugin_service
    binding = await plugin_service.resolve_binding(
        session, task, binding_id=binding_id, org_ids=org_ids,
        entrypoint="automation")
    version = await session.get(am.PluginVersion, binding.version_id)
    fields = plugin_service.public_inputs((version.manifest if version else {}) or {})
    source = clean_plugin_inputs(getattr(s, "plugin_inputs", {}) or {})
    allowed = {item["key"]: item for item in fields}
    values = {key: value for key, value in source.items() if key in allowed}
    for key, field in allowed.items():
        if key not in values and "default" in field:
            values[key] = field["default"]
        if field["type"] == "boolean" and key in values:
            raw = values[key]
            values[key] = raw if isinstance(raw, bool) else str(raw).lower() in {
                "1", "true", "yes", "on"}
        if field["type"] == "number" and key in values and values[key] not in ("", None):
            try:
                values[key] = float(values[key])
            except (TypeError, ValueError) as exc:
                raise ValueError("插件输入必须是数字：" + field["label"]) from exc
        if field["type"] == "select" and key in values and values[key] not in ("", None):
            options = {str(x.get("value")) for x in field.get("options") or []}
            if str(values[key]) not in options:
                raise ValueError("插件输入选项已失效：" + field["label"])
            values[key] = str(values[key])
        if field["required"] and (key not in values or values[key] in ("", None)):
            raise ValueError("请填写插件必填项：" + field["label"])
    s.plugin_inputs = values
    return binding
