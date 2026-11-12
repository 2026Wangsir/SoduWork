"""Native semantic completion: a zero exit must not hide a truncated turn."""
from __future__ import annotations

from . import declared_outputs, model_errors

TRUNCATED = "模型达到单轮输出上限，本轮尚未完成；已有文件与进度已保留，请缩小当前步骤后继续。"
RECOVERY_NOTE = "（SoduWork 自动恢复）模型输出被截断，正从同一会话保留进度续跑当前节点；最多自动恢复一次，不跳过审批或验收。"


def observe(cli: str, event: dict, terminal: dict) -> None:
    if cli == "opencode" and event.get("type") == "step_finish" and not event.get("contextOnly"):
        part = event.get("part")
        reason = part.get("reason") if isinstance(part, dict) else None
        if reason in {"length", "max_tokens"}:
            terminal["outputTruncated"] = True
        elif reason == "stop":
            terminal.pop("outputTruncated", None)
        return
    if cli != "pi" or event.get("type") not in {"message_end", "turn_end", "agent_end"}:
        return
    message = event.get("message")
    if event.get("type") == "agent_end":
        message = next((m for m in reversed(event.get("messages") or [])
                        if isinstance(m, dict) and m.get("role") == "assistant"), None)
    if not isinstance(message, dict) or message.get("role") != "assistant":
        return
    reason = str(message.get("stopReason") or "")
    # Pi can retry a transient model error in the same process. Only clear the
    # error owned by this observer; transport/policy failures must remain fatal.
    if reason in {"stop", "toolUse", "length", "max_tokens"} and terminal.pop("piSemanticError", False):
        terminal.pop("isError", None)
        terminal.pop("result", None)
    if reason in {"length", "max_tokens"}:
        terminal["outputTruncated"] = True
    elif reason == "stop":
        terminal.pop("outputTruncated", None)
        # A print-mode Pi process should exit after a final assistant message. Keep a
        # short-lived settlement candidate so the process watchdog can recover if the
        # provider leaves the child alive after emitting the complete answer.
        if event.get("type") == "message_end":
            terminal["piFinalResponse"] = True
    elif reason in {"error", "aborted"}:
        if terminal.get("isError") and not terminal.get("piSemanticError"):
            return
        if not terminal.get("isError"):
            terminal["piSemanticError"] = True
        terminal["isError"] = True
        # Extract a safe model diagnosis before the SDK error envelope is discarded.
        terminal["result"] = (model_errors.public_failure(message.get("errorMessage"))
                              if reason == "error" else "模型调用已中断，已有进度已保留。")


def recovery(run: dict, terminal: dict) -> dict:
    """Only resume an explicit file-workflow contract, never an arbitrary chat."""
    if (run.get("cli") != "pi" or not terminal.get("outputTruncated")
            or run.get("artifactMode") != "files" or run.get("queue")
            or int(run.get("completionRetries") or 0) >= 1):
        return {}
    paths = declared_outputs.paths([
        {"kind": "file", "path": name} for name in run.get("expectedOutputPaths") or []])
    if not paths:
        return {}
    return {"recover": True, "reason": "模型输出截断", "note": RECOVERY_NOTE,
            "prompt": "上一轮达到模型单轮输出上限而中断，并未完成当前节点。"
            "先检查已有文件，从现有进度继续，不重做已完成步骤。"
            "将工作拆成短小步骤，每完成一小段立即调用工具写入或验证，避免一次生成大段内容。"
            "只完成当前节点并核验这些约定产出：" + "、".join(paths)
            + "。仍需遵守原任务全部边界；不执行后续节点，不代替用户审批，"
            "不新增部署、费用或对外发送。无法完成就准确说明阻断，不能声称成功。"}
