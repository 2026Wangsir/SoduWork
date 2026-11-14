"""Change native executors at an idle turn boundary without changing SoduWork ref."""
from __future__ import annotations

import uuid

from . import access_policy, execution_selection as selection, skill_read_scope
from .local_base import _LOCK, _RUNS, _PROFILES, _save_meta, rehydrate


def validate(ref, raw, cfg):
    wanted = selection.normalize(raw)
    with _LOCK:
        run = _RUNS.get(ref)
    if run is None:
        run = rehydrate(ref)
    if run is None:
        raise selection.SelectionError("找不到原会话，不能切换执行底座")
    if run.get("conversationMode") == "goal" and wanted["agentId"] != run.get("cli"):
        raise selection.SelectionError("请先结束目标模式，再切换 Agent", "EXECUTION_GOAL_ACTIVE")
    prof = _PROFILES.get(wanted["agentId"])
    if not prof or not prof["bin"]():
        raise selection.SelectionError("所选 Agent 尚未安装", "EXECUTION_AGENT_UNAVAILABLE")
    issue = prof.get("runtime_issue")
    if callable(issue) and (problem := issue()):
        raise selection.SelectionError(str(problem), "EXECUTION_AGENT_UNAVAILABLE")
    cfg = dict(cfg or {})
    if cfg.get("local_cli") and cfg["local_cli"] != wanted["agentId"]:
        raise selection.SelectionError("本轮模型授权与所选 Agent 不匹配")
    if prof.get("needs_llm"):
        llm = dict(cfg.get("llm") or {})
        local_only = llm.get("localOnly") is True
        if not (llm.get("base") and llm.get("model") and (llm.get("key") or local_only)):
            raise selection.SelectionError("请先选择并授权可用模型")
        if wanted["modelName"] and wanted["modelName"] != llm["model"]:
            raise selection.SelectionError("本轮模型授权与所选模型不匹配")
        wanted["modelName"] = str(llm["model"])
    elif wanted["agentId"] == "codex":
        if wanted["modelName"] != str(cfg.get("codex_model") or ""):
            raise selection.SelectionError("本轮 Codex 模型配置不匹配")
        if wanted["reasoningEffort"] != str(cfg.get("codex_reasoning_effort") or ""):
            raise selection.SelectionError("本轮 Codex 推理配置不匹配")
    policy = access_policy.prepare(wanted["agentId"], cfg.get("accessPolicy", run.get("accessPolicy")), run["ws"])
    if wanted != selection.current(run) and run.get("accessPolicy") and policy != run["accessPolicy"]:
        raise selection.SelectionError("切换 Agent 时不能同时改变访问权限，请先完成权限变更")
    with _LOCK:
        if wanted != selection.current(run):
            selection.require_idle(run)
    return wanted


def resume(ref, text, cfg):
    """None means ordinary same-executor continuation; otherwise a switch result."""
    raw = (cfg or {}).get("_executionSelection")
    if raw is None:
        return None
    from .local_ctx import _handoff_brief, _note, prepare_resume
    from .local_stream import _merge_runtime_cfg
    try:
        wanted = validate(ref, raw, cfg)
        with _LOCK:
            run = _RUNS[ref]
            if wanted == selection.current(run):
                return None
            selection.require_idle(run)
            # Do all fallible preparation before replacing the native identity.
            fresh = dict(cfg)
            fresh.pop("_executionSelection", None)
            scoped = dict(run)
            skill_read_scope.for_run(scoped, fresh)
            brief = _handoff_brief(ref, text).replace(
                "[SoduWork 上下文自动压缩：同一会话继续]",
                "[SoduWork 执行底座或模型已切换：继续同一会话]")
            old = dict(run)
            segments = list(run.get("contextSegments") or [])
            segments.append({**selection.current(run), "sid": run.get("cliSid") or "",
                             "segment": run.get("segment", 1)})
            merged = _merge_runtime_cfg(run.get("cfg"), fresh)
            merged.pop("_executionSelection", None)
            if wanted["agentId"] != "codex":
                merged.pop("codex_model", None)
                merged.pop("codex_reasoning_effort", None)
            if not _PROFILES[wanted["agentId"]].get("needs_llm"):
                merged.pop("llm", None)
            merged["local_cli"] = wanted["agentId"]
            run.update(cli=wanted["agentId"], model=wanted["modelName"],
                       modelLocalOnly=(merged.get("llm") or {}).get("localOnly") is True,
                       reasoningEffort=wanted["reasoningEffort"], cfg=merged,
                       contextSegments=segments, segment=int(run.get("segment") or 1) + 1,
                       cliSid="", tokens={}, appliedAccessPolicy={}, pendingPermissions=[])
            for key in ("_accessSessionGrants", "_accessSessionDenials", "_runtimeDedup", "terminal"):
                run.pop(key, None)
            # Explicit start avoids loading an incompatible native SID. The
            # ordinary resume path still owns policy, scope and round handling.
            run["_executionStart"] = {"prompt": brief, "sid": str(uuid.uuid4())}
            result = prepare_resume(ref, text, merged)
            if not result.get("ok"):
                run.clear()
                run.update(old)
                _save_meta(ref)
                return result
            _note(ref, "已切换为 " + _PROFILES[wanted["agentId"]]["name"] +
                  (" · 本地模型" if (merged.get("llm") or {}).get("localOnly") else
                   " · " + wanted["modelName"] if wanted["modelName"] else "") + "，继续当前会话。")
            return {**result, "acceptedSelection": wanted}
    except (selection.SelectionError, access_policy.PolicyError, ValueError, OSError) as exc:
        return {"ok": False, "code": getattr(exc, "code", "EXECUTION_SELECTION_INVALID"), "error": str(exc)}
