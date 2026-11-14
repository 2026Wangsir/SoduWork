"""ACP Agent catalog and the command adapter used by SoduWork Runner.

Keep this module dependency-free.  ACP agents evolve independently from SoduWork;
the rest of the execution stack must only know the stable profile contract.
"""
from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path

from ..agent_catalog import acp_specs
from . import dsh_runtime
from . import agent_npm_runtime


CATALOG: dict[str, dict] = acp_specs()


def find_bin(key: str) -> str | None:
    """Find an installed ACP agent without mistaking SoduWork itself for one."""
    spec = CATALOG.get(key) or {}
    if key == "claude":
        from .agent_native_install import active_binary
        from .local_base import _data_root
        if not active_binary(_data_root()):
            return None
        return agent_npm_runtime.private_bin(spec.get("bins") or ()) or None
    override = os.environ.get("SODUWORK_AGENT_%s_BIN" % key.upper().replace("-", "_"))
    if override:
        path = os.path.abspath(os.path.expanduser(override))
        return path if os.path.isfile(path) else None
    private = agent_npm_runtime.private_bin(spec.get("bins") or ())
    if private:
        return private
    if spec.get("launch") == "node":
        return None
    for name in spec.get("bins") or ():
        found = shutil.which(name)
        if found:
            return found
    return None


def _bridge_path() -> str:
    return str(Path(__file__).with_name("acp_bridge.py"))


def run_args(session_id: str, mode: str, _ws: str | None = None,
             _cfg: dict | None = None) -> list[str]:
    """Opaque metadata consumed by :func:`command_argv`, never by the agent."""
    # `_env_for` runs inside the worker after this function has built the start
    # args, so recording the mode here lets Codex apply the same read/write gate
    # as SoduWork's outer ACP bridge without putting it on the agent command line.
    if isinstance(_cfg, dict):
        _cfg["_soduwork_agent_mode"] = str(mode or "work")
    return ["--soduwork-session", str(session_id or ""), "--soduwork-mode", str(mode or "work")]


def _metadata(args: list[str]) -> tuple[str, str]:
    session, mode = "", "work"
    for i, value in enumerate(args):
        if value == "--soduwork-session" and i + 1 < len(args):
            session = str(args[i + 1] or "")
        elif value == "--soduwork-mode" and i + 1 < len(args):
            mode = str(args[i + 1] or "work")
    return session, mode


def _agent_args(key: str, cfg: dict) -> list[str]:
    spec = CATALOG.get(key) or {}
    args = ["acp"] if key == "opencode" else list(spec.get("acp") or ())
    llm = (cfg or {}).get("llm") or {}
    if key == "qwen" and llm.get("base") and llm.get("model"):
        # The key remains in OPENAI_API_KEY; only non-secret routing values are argv.
        args = ["--auth-type", "openai", "--model", str(llm["model"]),
                "--openai-base-url", str(llm["base"]), *args]
    if key == "dsh" and llm.get("base") and llm.get("model"):
        from . import dsh_gateway
        args = [*args, *dsh_gateway.bundle_args()]
    return args


def command_argv(key: str, exe: str, args: list[str], ws: str,
                 cfg: dict | None = None) -> list[str]:
    """Wrap one installed ACP agent in SoduWork's normalized JSON event bridge."""
    session, mode = _metadata(args)
    policy = dict((cfg or {}).get("accessPolicy") or {})
    permission = "readonly" if policy.get("mode") == "readonly" or mode == "plan" else "workspace"
    entry = ([sys.executable, "--acp-bridge"]
             if getattr(sys, "frozen", False)
             else [sys.executable, _bridge_path()])
    bridge = [*entry, "--cwd", os.path.abspath(ws),
              "--agent-name", key, "--permission", permission]
    required = {str(item or "").strip().lower()
                for item in ((cfg or {}).get("requiredCapabilities") or [])}
    if permission != "readonly" and "terminal" in required:
        bridge.append("--terminal")
    if session:
        bridge += ["--session", session]
    command = [exe]
    spec = CATALOG.get(key) or {}
    if spec.get("launch") == "node":
        command_name = str((spec.get("bins") or [""])[0]).removesuffix(".cmd")
        entry = agent_npm_runtime.package_entry(spec.get("pkg", ""), command_name)
        node = agent_npm_runtime.node_env(key)
        if not entry or not node.get("ok"):
            raise RuntimeError(node.get("why") or "Agent adapter entry is unavailable; reinstall this Agent")
        command = [node["nodePath"], entry]
    return [*bridge, "--", *command, *_agent_args(key, cfg or {})]


def runtime_issue(key: str, *, probe: bool = False) -> str:
    """Return a human-readable runtime defect before a task is created."""
    if key == "claude":
        from .claude_runtime import runtime_issue as claude_issue
        from .local_base import _data_root
        return claude_issue(_data_root())
    if key != "dsh":
        return ""
    exe = find_bin(key) or ""
    if not exe:
        return ""
    expected = dsh_runtime.adapter_expected_version(exe)
    if probe:
        return dsh_runtime.boot_issue(exe, expected_version=expected)
    return dsh_runtime.runtime_issue(expected_version=expected)


def home_env(key: str, env: dict, work_root: str) -> None:
    """Keep private agent state under the Runner's managed data root.

    DSH's Windows encryption-filter compatibility is installed by apply_env;
    merely relocating its home does not fix same-volume staging failures.
    """
    declaration = (CATALOG.get(key) or {}).get("home") or {}
    if key == "claude":
        from .claude_runtime import environment
        env.update(environment(work_root, env))
        for name in ("NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "CLAUDECODE"):
            env.pop(name, None)
        return
    if not declaration or not work_root:
        return
    folder = declaration["folder"]
    home = os.path.join(os.path.abspath(os.path.expanduser(work_root)), folder)
    try:
        os.makedirs(home, exist_ok=True)
    except OSError:
        # A private-home failure must not launch against inherited account state.
        # Suppress filesystem diagnostics that may contain personal paths.
        raise RuntimeError("执行组件的独立数据目录无法创建，请检查 Runner 数据目录权限、同名文件或磁盘空间后重试。") from None
    # Only reviewed env names and a relative one-segment folder are accepted by
    # the catalog loader; no source-controlled declaration can escape this root.
    env[declaration["env"]] = home
    from . import agent_shell
    agent_shell.apply(env, key)
    if key == "dsh":
        dsh_runtime.apply_env(env, work_root)


def inject_llm_env(key: str, env: dict, llm: dict, *, mode: str = "work") -> None:
    """Inject per-run credentials; never write company keys to an agent file."""
    base = str((llm or {}).get("base") or "")
    secret = str((llm or {}).get("key") or "")
    model = str((llm or {}).get("model") or "")
    local_only = (llm or {}).get("localOnly") is True
    if not (base and model and (secret or local_only)):
        return
    if key == "kimi":
        # Kimi's plain KIMI_API_KEY is a config-file key, not a shell override.
        # Its temporary provider contract is the KIMI_MODEL_* environment family.
        for name in list(env):
            if name.startswith("KIMI_MODEL_"):
                env.pop(name, None)
        env["KIMI_MODEL_PROVIDER_TYPE"] = "anthropic" if llm.get("kind") == "anthropic" else "openai"
        env["KIMI_CODE_NO_AUTO_UPDATE"] = "1"
        env["KIMI_DISABLE_TELEMETRY"] = "1"
    # Generic ACP Agents can describe standard environment-based model routing.
    # Custom authentication/bootstrap protocols remain explicit adapters below.
    fields = {"base": base, "key": secret, "model": model}
    for target, source in ((CATALOG.get(key) or {}).get("modelEnv") or {}).items():
        if source == "key" and not secret:
            env.pop(target, None)
        else:
            env[target] = fields[source]
    if key == "qwen":
        # Qwen's internal bootstrap markers are process-local. Inheriting them
        # from a shell or IDE can replace argv, enter the updater and exit
        # before ACP completes its first handshake.
        for name in (
            "QWEN_CODE_CPU_PROFILE", "QWEN_CODE_DEBUG", "QWEN_DEBUG",
            "QWEN_DEBUG_LOG_FILE", "QWEN_CODE_INTEGRATION_TEST",
            "QWEN_CODE_RELAUNCH_ARGS", "QWEN_CODE_MANAGED_NPM_UPDATE_VERSION",
            "QWEN_CODE_MANAGED_NPM_UPDATE", "QWEN_CODE_MANAGED_NPM_PIN",
            "QWEN_CODE_PENDING_COMPILE_CACHE", "QWEN_CODE_LAUNCHER_PATH",
            "QWEN_CODE_LAUNCHER_PID", "QWEN_CODE_STARTUP_VERSION",
        ):
            env.pop(name, None)
        env.update(OPENAI_BASE_URL=base, OPENAI_MODEL=model,
                   QWEN_MODEL=model, QWEN_CODE_NO_RELAUNCH="1",
                   QWEN_CODE_SKIP_UPDATE_CHECK_ONCE="true",
                   QWEN_ARTIFACT_NO_AUTO_OPEN="1")
        if secret:
            env["OPENAI_API_KEY"] = secret
        else:
            env.pop("OPENAI_API_KEY", None)
    elif key == "dsh":
        from . import dsh_gateway
        dsh_gateway.inject_env(env, llm)
    elif key == "codex-harness":
        # The managed adapter resolves its own compatible native dependency.
        # Host overrides and debug logging must not route it to a personal CLI
        # or persist the per-turn enterprise gateway credential.
        env.pop("CODEX_PATH", None)
        env.pop("APP_SERVER_LOGS", None)
        startup = Path(__file__).with_name("codex_gateway_startup.mjs")
        if not startup.is_file():
            raise RuntimeError("Codex Harness gateway startup component is missing")
        # codex-acp gateway auth keeps credentials out of argv/config files.
        # The adapter maps this gateway to Codex's Responses wire protocol.
        gateway = {
            "methodId": "gateway",
            "_meta": {"gateway": {
                "baseUrl": base.rstrip("/"),
                "headers": {"Authorization": "Bearer " + secret} if secret else {},
                "providerName": "SoduWork 模型服务",
            }},
        }
        env.update(
            NODE_OPTIONS="--import=" + startup.resolve().as_uri(),
            NO_BROWSER="1",
            MODEL_PROVIDER="custom-gateway",
            INITIAL_AGENT_MODE=("read-only" if mode == "plan" else "agent"),
            DEFAULT_AUTH_REQUEST=json.dumps(
                gateway, ensure_ascii=False, separators=(",", ":")),
            CODEX_CONFIG=json.dumps({
                "model": model,
                "model_provider": "custom-gateway",
                # SoduWork owns the durable event archive; do not ask an enterprise
                # gateway to retain remote Responses state as well.
                "disable_response_storage": True,
            }, ensure_ascii=False, separators=(",", ":")),
        )


def profile(key: str, spec: dict | None = None) -> dict:
    spec = CATALOG[key] if spec is None else spec
    return {
        "name": spec["name"],
        "bin": lambda key=key: find_bin(key),
        "needs_llm": bool(spec.get("needs_llm")),
        "own_session": False,
        "start": lambda sid, mode, ws, cfg=None: run_args("", mode, ws, cfg),
        "resume": lambda sid, mode, ws, cfg=None: run_args(sid, mode, ws, cfg),
        "command": lambda exe, args, ws, cfg=None, key=key: command_argv(
            key, exe, args, ws, cfg),
        "acp_key": key,
        "session_flag": None,
        "compact": None,
        "runtime_issue": lambda key=key: runtime_issue(key),
        "runtime_probe": lambda key=key: runtime_issue(key, probe=True),
    }


def specs() -> dict[str, dict]:
    return {key: {
        "pkg": spec.get("pkg", ""),
        "installer": spec.get("installer", "manual"),
        "source": spec.get("source", ""),
        "blurb": spec["blurb"],
        "warn": spec.get("warn", ""),
        "config_how": spec.get("config_how", ""),
        "config_path": "",
        "install_how": spec.get("install_how", ""),
    } for key, spec in CATALOG.items()}


__all__ = ["CATALOG", "command_argv", "find_bin", "home_env", "inject_llm_env",
           "profile", "runtime_issue", "specs"]
