"""Dependency-free configuration boundary for managed OpenCode subprocesses."""
from __future__ import annotations

import os
from pathlib import Path
import re
import sys


def runner_data_root() -> str:
    """Match the Runner archive root without importing backend services."""
    explicit = str(os.environ.get("SODUWORK_DATA_ROOT") or "").strip()
    if explicit:
        return os.path.abspath(os.path.expanduser(explicit))
    home = os.path.expanduser("~")
    if os.name == "nt":
        return os.path.join(os.environ.get("LOCALAPPDATA") or os.path.join(home, ".soduwork"),
                            "soduwork")
    if sys.platform == "darwin":
        return os.path.join(home, "Library", "Application Support", "soduwork")
    return os.path.join(os.environ.get("XDG_DATA_HOME") or os.path.join(home, ".local", "share"),
                        "soduwork")


def prepare_environment(env: dict, data_root: str | None = None) -> None:
    """Keep personal global config out; preserve native data and injected config."""
    root = Path(data_root or runner_data_root())
    config_home = root / "agents" / "opencode" / "config"
    config_home.mkdir(parents=True, exist_ok=True)
    # Explicit native overrides bypass XDG_CONFIG_HOME. Managed turns must not
    # merge personal providers, plugins, or settings into their injected config.
    for key in list(env):
        if key.upper() in {"OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR"}:
            del env[key]
    env["XDG_CONFIG_HOME"] = str(config_home)


def config_error_message(message: str) -> str:
    """Known config parser diagnostics may contain config contents or credentials."""
    text = message.lower()
    if (any(marker in text for marker in (
            "configjsonerror", "configinvaliderror", "endoffileexpected",
            "--- jsonc input ---"))
            or re.search(r"\bconfig file at\b[^\r\n]*\bis not valid json(?:\(c\)|c)?(?=[:\s]|$)", text)):
        return ("OpenCode 执行组件配置无法解析，本轮尚未完成。"
                "请检查 SoduWork 的模型配置或修复执行组件；个人 OpenCode 配置保持不变。")
    return ""
