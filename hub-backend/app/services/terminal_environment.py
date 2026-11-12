"""Construct terminal environments on the machine that owns the execution.

The terminal RPC carries session metadata only. In particular, neither legacy
``env`` nor arbitrary configuration from a Hub is applied to the Runner process.
Task credentials may only come from the configuration already held for that
task's dispatched execution; host paths and OS variables always stay local.
"""
from __future__ import annotations


def runner_environment(task: str, ref: str, cli: str, work_root: str = "") -> dict:
    from . import local_base, runtime_images

    with local_base._LOCK:
        run = dict(local_base._RUNS.get(ref) or {}) if ref else {}
        if run and str(run.get("taskId") or "") != task:
            raise ValueError("终端会话不属于这条需求")
        cfg = dict(run.get("cfg") or {})

    actual_cli = str(run.get("cli") or cli or "")
    if cli and actual_cli != cli:
        raise ValueError("终端底座与原执行会话不一致")
    prof = local_base._PROFILES.get(actual_cli)

    # No execution (or a recovered archive without in-memory credentials): use
    # the Runner's own shell/login environment. Never borrow Hub global model
    # credentials or a different task's configuration to fill that gap.
    if not cfg:
        # Native launchers still need their local setup (notably bundled Pi's
        # Electron-as-Node flag and Codex home). ACP model injection requires
        # managed credentials, so leave its shell/login environment untouched.
        native = prof if prof and not prof.get("acp_key") else {}
        return local_base._env_for(native, {"local_workspace_root": work_root},
                                   runtime_ref=ref, require_model=False)

    if prof is None:
        raise ValueError("原执行会话的底座不可用")
    cfg.pop(runtime_images.CFG_KEY, None)
    # _env_for supplies the existing CLI-specific model, Git/MCP and runtime
    # setup, resolving runtimeSecrets only against this Runner's environment.
    return local_base._env_for(prof, cfg, runtime_ref=ref)
