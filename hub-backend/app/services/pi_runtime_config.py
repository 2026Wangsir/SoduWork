"""Bind managed Pi subprocesses to execution-scoped, credential-free model files."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import uuid

from . import runtime_images
from .runtime_defaults import DEFAULT_OUTPUT


def _session_files(directory: Path, sid: str, cwd: str) -> list[Path]:
    matches = []
    for path in directory.glob("*_" + sid + ".jsonl"):
        if path.is_symlink():
            raise ValueError("Session file is a symlink")
        with path.open(encoding="utf-8") as source:
            header = json.loads(source.readline())
        if (header.get("type") != "session" or header.get("id") != sid
                or os.path.normcase(os.path.abspath(header.get("cwd") or "")) != cwd):
            raise ValueError("Session ownership does not match the execution record")
        matches.append(path)
    return matches


def _preserve_session(directory: Path, env: dict, run: dict) -> None:
    """Import only the exact native session identified by the Runner's own record."""
    sid, workspace = str(run.get("cliSid") or ""), str(run.get("ws") or "")
    if not sid or not workspace:
        return
    if str(uuid.UUID(sid)) != sid:
        raise ValueError("Invalid execution session ID")
    cwd = os.path.normcase(os.path.abspath(workspace))
    destination = directory / "sessions"
    current = _session_files(destination, sid, cwd)
    if len(current) == 1:
        return
    if current:
        raise ValueError("Ambiguous execution session")
    encoded = "--" + re.sub(r"[/\\:]", "-", re.sub(r"^[/\\]", "", os.path.abspath(workspace))) + "--"
    candidates = []
    if env.get("PI_CODING_AGENT_SESSION_DIR"):
        candidates.append(Path(env["PI_CODING_AGENT_SESSION_DIR"]).expanduser())
    if env.get("PI_CODING_AGENT_DIR"):
        candidates.append(Path(env["PI_CODING_AGENT_DIR"]).expanduser() / "sessions" / encoded)
    for home in {os.path.expanduser("~"), env.get("HOME"), env.get("USERPROFILE")} - {None, ""}:
        candidates.append(Path(home) / ".pi/agent/sessions" / encoded)
    matches = set()
    for candidate in candidates:
        matches.update(path.resolve() for path in _session_files(candidate, sid, cwd))
    if len(matches) > 1:
        raise ValueError("Ambiguous historical execution session")
    if matches:
        source = matches.pop()
        destination.mkdir(parents=True, exist_ok=True, mode=0o700)
        _publish(destination / source.name, source.read_bytes())
        return


def _publish(target: Path, content: bytes) -> None:
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="wb", dir=target.parent, prefix=".models-",
                                         suffix=target.suffix, delete=False) as out:
            temporary = Path(out.name)
            out.write(content)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, target)
    finally:
        if temporary is not None:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass  # Preserve the original failure if cleanup is also denied.


def prepare_session_environment(env: dict, data_root: str, runtime_ref: str,
                                run: dict | None = None) -> Path:
    """Bind owned history without requiring, loading or publishing model credentials."""
    scope = hashlib.sha256(str(runtime_ref or uuid.uuid4().hex).encode("utf-8")).hexdigest()[:32]
    directory = Path(data_root).absolute() / "agent-runtimes" / "pi" / scope
    try:
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    except OSError as exc:
        raise RuntimeError("Pi 模型配置无法写入，请检查执行机数据目录权限和磁盘空间后重试。") from exc
    try:
        _preserve_session(directory, env, run or {})
    except (OSError, ValueError, TypeError) as exc:
        raise RuntimeError("Pi 原执行会话无法安全恢复，请保留现有记录并检查执行机上的会话文件后重试。") from exc
    # Explicit paths avoid Python/Node HOME differences and stale desktop state.
    for key in list(env):
        if key.upper() in {"PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"}:
            del env[key]
    env["PI_CODING_AGENT_DIR"] = str(directory)
    env["PI_CODING_AGENT_SESSION_DIR"] = str(directory / "sessions")
    return directory


def prepare(env: dict, data_root: str, llm: dict, context_window: int, runtime_ref: str,
            run: dict | None = None) -> None:
    """Keep desktop and personal Pi state untouched; retain the same path on resume."""
    kind = llm.get("kind") or "openai-compat"
    provider = {
        "name": "SoduWork 模型服务",
        "baseUrl": llm["base"],
        "api": "anthropic-messages" if kind == "anthropic" else "openai-completions",
        "apiKey": "$SODUWORK_LLM_KEY",
        "models": [{"id": llm["model"], "name": "公司 coding 模型",
                    "input": ["text", "image"] if runtime_images.transport_supported(llm) else ["text"],
                    "contextWindow": context_window,
                    "maxTokens": min(runtime_images.model_fields(llm).get("maxOutputTokens", DEFAULT_OUTPUT),
                                     context_window)}],
    }
    if kind != "anthropic":
        provider["compat"] = {"supportsDeveloperRole": False, "supportsReasoningEffort": False}
    content = json.dumps({"providers": {"company": provider}}, ensure_ascii=False, indent=1)
    directory = prepare_session_environment(env, data_root, runtime_ref, run)
    try:
        target = directory / "models.json"
        try:
            unchanged = target.read_text(encoding="utf-8") == content
        except FileNotFoundError:
            unchanged = False
        if not unchanged:
            # Publish a complete configuration before the CLI starts. A failed
            # replacement must not launch against an old or partial model file.
            _publish(target, content.encode("utf-8"))
    except OSError as exc:
        raise RuntimeError("Pi 模型配置无法写入，请检查执行机数据目录权限和磁盘空间后重试。") from exc
