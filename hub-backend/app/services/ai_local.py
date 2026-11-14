"""Public module behavior and service contracts."""
from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import threading
import time
import uuid
from types import SimpleNamespace

# Re-export the same shared objects imported from local_base.
# ai_exec uses ai_local._RUNS for routing, so object identity must be preserved.
from .local_base import (_CTX_WINDOW_DEFAULT, _LOCK, _PROFILES, _RUNS, _STORE,  # noqa: F401
                         _cfg_profile, _data_root, _env_for, _workspace_root,
                         _claude_bin, _opencode_bin)
from .local_base import (_load_baseline, _read_events, _record_event, _save_baseline, _save_meta,  # noqa: F401
                         _pid_alive, _store_dir, raw_tail_sync, reclaim,
                         _friendly, ctx_pct)
from .local_stream import _kill_tree, _spawn, _window_for  # noqa: F401
from .local_stream import _OVERFLOW_PAT, _learn_window  # noqa: F401 - Overflow detection is also used by audit scripts.
from .local_stream import comment_sync, is_running, stop_sync  # noqa: F401 - Part of the provider contract.
from . import agent_naming, declared_outputs, dispatch_identity, execution_policy, conversation_plugins, access_policy
from .local_ctx import _note, _try_compact  # noqa: F401
from . import ai_prompts   # Product instructions shared across execution providers.
from . import local_artifacts
from .local_artifacts import (
    _SKIP_DIRS,
    _SKIP_NAMES,
    _SKIP_PREFIX,
    _SKIP_SUFFIX,
    _is_noise,
    _snapshot,
    _ART_CAP,
    _BUNDLE_PREFIX,
    _BUNDLE_MAX_BYTES,
    _fresh_entries,
    _safe_work_file,
    _rel_name,
)

log = logging.getLogger("uvicorn.error")

_DISPATCH_START_WAIT_S = 150.0
_DISPATCH_STARTS: dict[str, dict] = {}


_GIT_DELIVERY_LOCKS: dict[str, threading.Lock] = {}
_GIT_DELIVERY_LOCKS_LOCK = threading.Lock()


def _git_delivery(run: dict) -> dict:
    """Capture a coding session's branch once without blocking status pollers.

    A completed run can be polled simultaneously by the task page, workflow engine,
    settlement worker and artifact sweeper. The old lazy implementation let every
    caller launch the same Git inspection before the first result was cached. Only
    one caller now performs it; concurrent polls return terminal status immediately.
    Failed/empty inspections are cached too, otherwise every poll retries them.
    """
    cached = run.get("gitDelivery")
    if isinstance(cached, dict) and (cached.get("_checked") or "remoteBranch" in cached):
        return cached
    if run.get("state") == "running":
        return {}
    ref = str(run.get("ref") or "")
    lock_key = ref or str(id(run))
    with _GIT_DELIVERY_LOCKS_LOCK:
        gate = _GIT_DELIVERY_LOCKS.setdefault(lock_key, threading.Lock())
    if not gate.acquire(blocking=False):
        # Another status poll is already collecting the immutable Git identity.
        # Returning a plain empty mapping is ambiguous: the workflow engine used
        # to interpret it as "the agent did not push", even though the first poll
        # would populate the branch a moment later. Keep status polling
        # non-blocking, but expose the transient state explicitly so contract
        # settlement can wait for the next poll instead of failing the node.
        return {"_pending": True}
    try:
        cached = run.get("gitDelivery")
        if isinstance(cached, dict) and (cached.get("_checked") or "remoteBranch" in cached):
            return cached
        if run.get("state") == "running":
            return {}
        cwd = str(run.get("ws") or "")
        from . import git_ops
        out = dict(git_ops.worktree_identity(cwd) or {})
        out["_checked"] = True
        with _LOCK:
            run["gitDelivery"] = out
        if ref:
            _save_meta(ref)
        return out
    finally:
        gate.release()


def local_host() -> str:
    """Return the backend machine's hostname portably. COMPUTERNAME is Windows-specific, whereas
    socket.gethostname() also works on Linux. A stable hostname lets local and desktop-Runner
    execution on the same machine resolve to one workstation instead of duplicate generic server
    entries."""
    name = (os.environ.get("COMPUTERNAME") or "").strip()
    if name:
        return name
    try:
        import socket
        return (socket.gethostname() or "").strip()
    except OSError:
        return ""


def _seat_name(cli_name: str, cfg: dict | None = None, cli_key: str = "") -> str:
    """Behavior and constraints for this operation."""
    if _HUB_CLUSTER_MODE:
        return {"agents": [], "squads": []}
    from . import execution_aliases
    host = local_host()
    aliases = (cfg or {}).get("names") or {}
    mkey = agent_naming.machine_key(host=host)
    label = execution_aliases.machine_name(aliases, mkey) or \
        agent_naming.auto_machine_label(host=host, fallback="服务端")
    return execution_aliases.seat_name(
        aliases, machine_key=mkey, cli_key=cli_key or agent_naming.cli_key(cli_name),
        cli_name=cli_name, machine_label=label)


# Provider availability contract.
async def load(session=None, force: bool = False) -> dict:
    """Load local execution configuration, including the shared model service settings required by
    OpenCode. Pass credentials only through the execution configuration path.
    """
    cfg: dict = {}
    if session is not None:
        try:
            from . import llm
            c = await llm.load(session, force=force)
            if llm.enabled(c):
                cfg["llm"] = {"base": c.get("llm_base_url", ""),
                              "key": c.get("llm_api_key", ""),
                              "model": c.get("llm_model", ""),
                              # Administrator-approved candidate models for per-step selection.
                              # Candidates control selection; the resolved model controls execution.
                              "models": _model_list(c.get("llm_models", ""))}
        except Exception as e:  # noqa: BLE001 - Model configuration errors must not disable unrelated runtimes.
            log.warning("取模型服务配置失败: %s", type(e).__name__)
        try:
            # Carry machine and seat aliases in configuration.
            # Synchronous seat listing runs in a worker without a database session.
            from . import execution_aliases
            cfg["names"] = await execution_aliases.load(session)
        except Exception as e:  # noqa: BLE001 - Optional aliases must not disable execution.
            log.warning("取执行机别名失败: %s", type(e).__name__)
    return cfg


def _model_list(raw) -> list:
    """Parse the candidate-model JSON array; invalid or empty configuration yields an empty list."""
    if isinstance(raw, list):
        return [str(x).strip() for x in raw if str(x).strip()]
    s = str(raw or "").strip()
    if not s:
        return []
    try:
        v = json.loads(s)
    except Exception:  # noqa: BLE001 - Invalid manual configuration must not fail dispatch.
        return []
    return [str(x).strip() for x in v if str(x).strip()] if isinstance(v, list) else []


def enabled(cfg: dict | None = None) -> bool:
    return configured(cfg)


def _profile_runtime_issue(prof: dict, *, probe: bool = False) -> str:
    check = prof.get("runtime_probe" if probe else "runtime_issue")
    if not callable(check):
        return ""
    try:
        return str(check() or "")
    except Exception as exc:  # noqa: BLE001
        return "Agent 运行时自检失败：" + str(exc)[:220]


_HUB_CLUSTER_MODE = False  # Set only by Hub lifespan, never by standalone Runner.


def configured(cfg: dict | None = None) -> bool:
    """A real installed CLI is sufficient for local-provider availability."""
    if _HUB_CLUSTER_MODE:
        return False
    prof = _PROFILES.get(_cfg_profile(cfg or {}))
    return bool(prof and prof["bin"]() and not _profile_runtime_issue(prof))


def default_assignee(cfg: dict | None = None) -> dict:
    return {"id": "local:" + _cfg_profile(cfg or {}), "type": "agent"}


def assignee_type(cfg: dict | None = None) -> str:
    return "agent"


def list_assignees_sync(cfg: dict) -> dict:
    """Expose each available CLI as an agent with a local: recipient prefix for routing."""
    from . import execution_aliases
    host = local_host()
    mkey = agent_naming.machine_key(host=host)
    label = ((cfg or {}).get("names") and
             execution_aliases.machine_name(cfg["names"], mkey)) or \
        agent_naming.auto_machine_label(host=host, fallback="服务端")
    from . import execution_capabilities
    capability_report = execution_capabilities.runtime_report(_workspace_root(cfg or {}))
    agents = []
    for key, prof in list(_PROFILES.items()):
        exe = prof["bin"]()
        if not exe or _profile_runtime_issue(prof):
            continue
        agents.append({
            "id": "local:" + key, "name": _seat_name(prof["name"], cfg, key), "type": "agent",
            "cli": key, "cliName": prof["name"], "model": "", "avatar": "",
            "online": True, "busy": _busy(key), "local": True,
            # Include the backend machine identity with local seats.
            # A client Runner may run on the same physical machine.
            # Shared host identity prevents duplicate seats across execution channels.
            # Include the machine name explicitly for grouping without parsing display names.
            "host": host, "runnerId": "", "machineKey": mkey, "machineLabel": label,
            "capabilities": capability_report,
            # Per-stage model overrides apply only to runtimes that consume the shared provider configuration.
            # Native-account runtimes and managed agents select models through their own account configuration.
            # Hide unsupported selectors instead of accepting model overrides that execution would ignore.
            "modelPick": bool(prof.get("needs_llm")),
            "note": "在这台机器上直接跑，产出落本地工作目录",
        })
    return {"agents": agents, "squads": []}


def _busy(cli: str) -> bool:
    with _LOCK:
        return any(r.get("state") == "running" and r.get("cli") == cli for r in _RUNS.values())


def resolve_assignee_sync(cfg: dict, aid: str, atype: str = "") -> dict | None:
    key = (aid or "").split(":", 1)[-1]
    prof = _PROFILES.get(key)
    if not prof or not prof["bin"]() or _profile_runtime_issue(prof):
        return None
    return {"id": "local:" + key, "type": "agent", "host": local_host(),
            "name": _seat_name(prof["name"], cfg, key), "cliName": prof["name"]}


# Dispatch contract.
def _compose(t, ctx: dict) -> str:
    """Compose task data with the product instructions supplied by the orchestration layer;
    adapters do not define planning, milestone, or delivery policy.
    """
    ctx = ctx or {}
    conversation_mode = str(ctx.get("conversationMode") or "") == "adaptive"
    parts = [ai_prompts.LANG_RULE]
    if ctx.get("planRule"):
        parts.append(str(ctx["planRule"]))
    if (ctx.get("brief") or "").strip():
        parts.append("【交代给你的重点】\n" + ctx["brief"].strip())
    if conversation_mode:
        if (getattr(t, "note", "") or "").strip():
            parts.append(t.note.strip())
    else:
        parts.append("【任务】" + (getattr(t, "title", "") or ""))
        if (getattr(t, "note", "") or "").strip():
            parts.append("【备注】\n" + t.note.strip())
    # Personal-plugin method context is resolved from the device's current plugin version.
    if (ctx.get("personalPluginContext") or "").strip():
        parts.append(str(ctx["personalPluginContext"]).strip())
    criteria = list(getattr(t, "acceptance_criteria", None) or getattr(t, "acceptanceCriteria", None) or [])
    if criteria:
        parts.append("Acceptance criteria:\n" + "\n".join("- " + str(item) for item in criteria))
    inputs = [x for x in (ctx.get("inputFiles") or []) if x.get("path")]
    if inputs:
        lines = ["【随任务带来的文件】", "这些是需求输入，不是你的产出；请按需读取，不要提交进代码仓库："]
        lines += ["- %s：%s" % (x.get("name") or "附件", x["path"]) for x in inputs]
        parts.append("\n".join(lines))
    repo = ctx.get("repo") or {}
    if repo.get("path"):
        parts.append("【在哪儿干】\n目录：" + repo["path"] +
                     "   ← 就在这个目录里改，别新建工作区" +
                     (("\n仓库：" + repo["gitUrl"]) if repo.get("gitUrl") else "") +
                     (("\n基线分支：" + repo["branch"]) if repo.get("branch") else "") +
                     (("\n怎么跑/怎么测：\n" + repo["note"]) if repo.get("note") else ""))
        # Attach the requested development workflow, including branching, checks, evidence, commit, and push.
        # Apply the same workflow contract to local and managed adapters.
        # Completing edits and a build alone must not silently omit the requested delivery steps.
        # Keep this completion contract consistent across execution paths.
        # Omit execution instructions during the planning-only turn, which forbids code changes.
        # Branch templates, checks, evidence requirements, and project-specific instructions are configurable.
        # api.tasks._attach_dev_flow has already merged global defaults with project overrides.
        # Pass the resolved policy to ai_prompts; adapters need not know its configuration layers.
        if repo.get("flow") and ctx.get("mode") != "plan":
            # Detect the backend execution host's platform and shell.
            # Render command examples for the actual execution environment.
            parts.append(ai_prompts.dev_flow(repo.get("branch") or "main", local=True,
                                             task_id=getattr(t, "id", "") or "",
                                             cfg=repo.get("devFlow"),
                                             unattended=bool(repo.get("unattended")),
                                             env=ai_prompts.detect_env(),
                                             scm=str(repo.get("scm") or ""),
                                             gerrit_base=str(repo.get("gerritBase") or "")))
    if (ctx.get("projectContextPrompt") or "").strip():
        parts.append(str(ctx["projectContextPrompt"]).strip())
    organization_prompt = (ctx.get("organizationMemory") or {}).get("prompt") or ""
    if organization_prompt.strip():
        parts.append(str(organization_prompt).strip())
    continuation = dict(ctx.get("codeContinuation") or {})
    if continuation:
        branch = str(continuation.get("branch") or "")
        commit = str(continuation.get("commit") or "")
        parts.append(
            "【自动返工 · 续做同一固定版本】\n"
            f"远端任务分支：`{branch}`；上一轮已固定提交：`{commit}`。\n"
            "当前目录已经从该提交创建为本轮专属隔离工作树。只在当前目录继续，"
            "不要进入其他 `.soduwork/worktrees`，不要重新 clone 或初始化项目。\n"
            f"需要修改时，在当前 detached HEAD 上完成提交，再用 `git push origin HEAD:{branch}` "
            "非强推更新同一远端任务分支；不得另建分支。若逐项核对后确认无需源码改动，"
            "不要制造空提交，保留真实核对证据并结束本轮，SoduWork 会重试失败门禁。"
        )
    if ctx.get("planDeliver"):
        parts.append(str(ctx["planDeliver"]))
    elif conversation_mode:
        parts.append("这是自适应办公对话。普通咨询直接用自然语言回答；只有用户在本轮明确要求生成文件、程序或其他成果时，才写入工作目录并进行必要验证。")
    else:
        parts.append("产出请直接写成文件放在工作目录里——**本地执行不需要上传**，"
                     "SoduWork 会自己从这个目录把新文件收走。")
        parts.append(
            "需要生成文件、程序或其他可验证结果时，必须实际调用可用工具完成并核验真实结果；"
            "不得只输出计划、承诺、‘将要执行’或完成说明。纯咨询、分析与说明类任务可以直接回答。")
    # Include the SoduWork task ID in the instructions.
    # The agent needs this ID to construct the required task-specific branch name.
    # Do not leave branch identity implicit.
    # Pi loads skills through --skill; other runtimes receive the same skill context in the prompt.
    _sk = ctx.get("skills") or []
    if _sk:
        from . import skills as _skills
        blk = _skills.prompt_block(_sk, bool(ctx.get("skillsNative")))
        if blk:
            parts.append(blk.strip())
    mcp_specs = dict(dict(ctx.get("mcpConfig") or {}).get("servers") or {})
    if mcp_specs:
        from . import skills as _skills
        bridge = os.path.join(_skills.bundled_root(), "mcp-tools", "scripts", "mcp.mjs")
        if os.path.isfile(bridge):
            bridge_arg = json.dumps(bridge, ensure_ascii=False)
            names = "、".join(str(name) for name in mcp_specs)[:500]
            parts.append(
                "【本节点获准使用的 MCP】\n连接：" + names + "。凭据只在本轮进程内，"
                "不得读取、回显或写入成果。只能通过 SoduWork MCP 桥调用；桥会隐藏并拒绝"
                "绑定未批准的工具，不得改用底座自己的全局 MCP 配置绕过。\n"
                "先查看允许的工具：`node " + bridge_arg + " list <连接名>`\n"
                "再按真实参数调用：`node " + bridge_arg +
                " call <连接名> <工具名> '<JSON>'`")
    # Place the current plugin node's instructions last to preserve its execution boundary.
    # A requirements node must stop after its declared outputs, before implementation work.
    # The current node's output contract is more specific than the overall task description.
    expected = [x for x in (ctx.get("expectedOutputs") or []) if isinstance(x, dict)]
    if expected:
        node_name = str(ctx.get("pluginNodeName") or "当前步骤")
        lines = [f"【当前工作流节点 · {node_name}】",
                 "只完成本节点；不要提前执行后续节点。完成声明的产出后立即结束本轮。",
                 "若本节点要求文件或系统结果，必须实际调用工具创建或修改，并在结束前读取、检查真实结果；"
                 "只说‘准备执行’、‘将会完成’或复述要求，不算交付。",
                 # Require exact declared output file names.
                 # Do not allow descriptive filename variations for contract-bound outputs.
                 # Delivery validation matches exact paths.
                 "本节点必须交回（文件产出的**路径和文件名必须一字不差**，"
                 "写在工作目录下的这个确切位置；改名、加前后缀、放进子目录都视为未交付）："]
        for item in expected:
            label = str(item.get("label") or item.get("key") or "产出")
            path = str(item.get("path") or "")
            lines.append("- " + label + (("：`" + path + "`（就用这个文件名，不许改）") if path else ""))
        if str(ctx.get("deliveryMode") or "") == "files":
            lines += ["本节点不是代码实现步骤。除上述声明文件外，不修改项目源码、配置、测试、依赖或 Git 状态。",
                      "即使任务总说明包含开发、测试、提交或发布要求，也留给后续对应节点执行。"]
        parts.append("\n".join(lines))
    tid = getattr(t, "id", "") or ""
    if tid and not conversation_mode:
        parts.append("---\n由 SoduWork 派发 · SoduWork 任务 " + str(tid))
    return "\n\n".join(p for p in parts if p)


def _stage_inputs(ref: str, files: list | None) -> list[dict]:
    """Store task attachments in the session archive and return absolute prompt paths. Keep them
    outside the repository so Git cannot accidentally commit them; retained archive paths
    survive Runner reclamation.
    """
    if not files:
        return []
    root = os.path.join(_store_dir(ref), "inputs")
    os.makedirs(root, exist_ok=True)
    out = []
    used = set()
    for idx, item in enumerate(files[:20]):
        if isinstance(item, (tuple, list)):
            name = str(item[0] if item else "")
            data = item[1] if len(item) > 1 else b""
            content_type = str(item[2] if len(item) > 2 else "")
        elif isinstance(item, dict):
            name = str(item.get("filename") or item.get("name") or "")
            content_type = str(item.get("contentType") or item.get("type") or "")
            data = item.get("data")
            if data is None and item.get("path"):
                try:
                    with open(str(item["path"]), "rb") as f:
                        data = f.read()
                except Exception:  # noqa: BLE001
                    data = None
        else:
            continue
        if data is None:
            continue
        if isinstance(data, str):
            data = data.encode("utf-8")
        if not isinstance(data, (bytes, bytearray)):
            continue
        base = os.path.basename(name.replace("\\", "/")) or ("附件-%d" % (idx + 1))
        base = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", base).strip(" .") or ("附件-%d" % (idx + 1))
        stem, ext = os.path.splitext(base)
        candidate, n = base, 2
        while candidate.lower() in used or os.path.lexists(os.path.join(root, candidate)):
            candidate = "%s-%d%s" % (stem, n, ext)
            n += 1
        used.add(candidate.lower())
        path = os.path.join(root, candidate)
        with open(path, "wb") as f:
            f.write(bytes(data))
        out.append({"name": name or candidate, "path": os.path.abspath(path), "size": len(data), "contentType": content_type})
    return out



def _existing_dispatch_receipt(sid: str, task, key: str, prof: dict,
                               assignee: dict | None) -> dict | None:
    """Return the original receipt when one dispatch RPC is delivered again."""
    with _LOCK:
        run = _RUNS.get(sid)
    if run is None and os.path.isfile(os.path.join(_STORE, sid, "meta.json")):
        reclaim()
        with _LOCK:
            run = _RUNS.get(sid)
    if run is None:
        return None
    task_id = str(getattr(task, "id", "") or "")
    existing_task = str(run.get("taskId") or "")
    if existing_task and task_id and existing_task != task_id:
        return {"ok": False, "error": "派活编号已被另一条任务使用，已阻止重复执行"}
    model = str(run.get("model") or "")
    return {
        "ok": True, "issueId": sid, "identifier": "LOCAL-" + sid[:8],
        "url": "", "assigneeType": "agent", "assigneeId": "local:" + key,
        "assigneeName": _seat_name(prof["name"]), "assigneeCli": prof["name"],
        "agentCli": key, "agentCliName": prof["name"],
        "agentSessionId": str(run.get("cliSid") or "") if prof.get("own_session") else "",
        "model": model, "selection": dict((assignee or {}).get("selection") or {}),
        "reasoningEffort": str(run.get("reasoningEffort") or ""),
        "files": 0, "provider": "local", "duplicate": True,
        "state": str(run.get("state") or "running"),
        "contextReport": dict(run.get("contextReport") or {}),
    }

def dispatch_sync(cfg: dict, t, files: list | None = None,
                  assignee: dict | None = None, ctx: dict | None = None, *,
                  capability_grants: list[str] | None = None) -> dict:
    """Start one stable dispatch exactly once, even when HTTP/RPC retries race."""
    if _HUB_CLUSTER_MODE:
        return {"ok": False, "code": "RUNNER_REQUIRED",
                "error": "多实例 Hub 请使用本机或远程 Runner 执行，不能直接在 Hub 内启动进程"}
    context = dict(ctx or {})
    trusted_gate = ({} if capability_grants is None else
                    {"capability_grants": capability_grants})
    dispatch_id = dispatch_identity.clean_dispatch_id(context.get("dispatchId"))
    if not dispatch_id:
        return _dispatch_sync_once(
            cfg, t, files, assignee, context, **trusted_gate)
    sid = dispatch_identity.execution_ref(dispatch_id)
    task_id = str(getattr(t, "id", "") or "")
    with _LOCK:
        gate = _DISPATCH_STARTS.get(sid)
        owner = gate is None
        if owner:
            gate = {"event": threading.Event(), "result": None, "taskId": task_id}
            _DISPATCH_STARTS[sid] = gate
    if not owner:
        existing_task = str(gate.get("taskId") or "")
        if existing_task and task_id and existing_task != task_id:
            return {"ok": False,
                    "error": "派活编号已被另一条任务使用，已阻止重复执行"}
        if not gate["event"].wait(_DISPATCH_START_WAIT_S):
            return {
                "ok": False, "uncertain": True, "code": "DISPATCH_IN_PROGRESS",
                "error": "同一派活仍在准备，等待执行会话登记即可",
                "issueId": sid, "expectedRef": sid,
            }
        result = dict(gate.get("result") or {})
        if not result:
            return {"ok": False, "error": "派活准备结束但没有生成回执"}
        if result.get("ok"):
            result["duplicate"] = True
        return result
    result = None
    try:
        result = _dispatch_sync_once(
            cfg, t, files, assignee, context, **trusted_gate)
        gate["result"] = dict(result or {})
        return result
    finally:
        gate["event"].set()
        with _LOCK:
            if _DISPATCH_STARTS.get(sid) is gate:
                _DISPATCH_STARTS.pop(sid, None)


def _dispatch_sync_once(cfg: dict, t, files: list | None = None,
                        assignee: dict | None = None, ctx: dict | None = None, *,
                        capability_grants: list[str] | None = None) -> dict:
    ctx = dict(ctx or {})
    key = ((assignee or {}).get("id") or default_assignee(cfg)["id"]).split(":", 1)[-1]
    prof = _PROFILES.get(key)
    if not prof:
        return {"ok": False, "error": f"不认识的本地 CLI：{key}"}
    if (ctx.get("personalPlugin") or {}).get("key") and not str(
            ctx.get("personalPluginContext") or "").strip():


        return {"ok": False, "error":
                "个人插件「%s」没有在这台执行机上完成装载：个人插件自动化只能在装有 SoduWork 客户端的本人电脑上运行"
                % str((ctx.get("personalPlugin") or {}).get("key"))}
    # The orchestration layer has already resolved the task's skills into context.
    # Pass supported skill paths through runtime arguments, such as Pi's --skill.
    # Other runtimes receive the same skills as prompt context.
    from . import skill_read_scope
    _sk = [s for s in (ctx.get("skills") or []) if isinstance(s, dict) and s.get("path")]
    scope_skills = skill_read_scope.localize(_sk)
    _native = bool(_sk) and key == "pi"
    ctx["skillsNative"] = _native
    if (_sk or ctx.get("mcpServers") or ctx.get("mcpConfig")
            or ctx.get("runtimeSecrets") or "networkAllowed" in ctx):
        cfg = dict(cfg or {})
        cfg["skillPaths"] = [s["path"] for s in _sk] if _native else []
        # Keep MCP configuration outside the repository; the bridge reads its path from SODUWORK_MCP_SERVERS.
        if ctx.get("mcpServers"):
            cfg["mcpServers"] = ctx["mcpServers"]
        if isinstance(ctx.get("mcpConfig"), dict):
            cfg["mcpConfig"] = ctx["mcpConfig"]
        if "networkAllowed" in ctx:
            cfg["networkAllowed"] = bool(ctx.get("networkAllowed"))
        raw_secrets = dict(ctx.get("runtimeSecrets") or {})
        if raw_secrets:
            invalid = [name for name, source in raw_secrets.items()
                       if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,127}", str(name))
                       or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,127}", str(source))]
            if invalid:
                return {"ok": False, "error": "插件运行密钥映射不合法"}
            missing = [name for name, source in raw_secrets.items()
                       if str(source) not in os.environ]
            if missing:
                return {"ok": False, "error": "当前执行机缺少插件密钥：" + "、".join(sorted(missing))}
            cfg["runtimeSecrets"] = {str(name): str(source)
                                     for name, source in raw_secrets.items()}
    work_root = str(ctx.get("workRoot") or "").strip()
    if work_root and not (cfg or {}).get("local_workspace_root"):
        cfg = dict(cfg or {})
        cfg["local_workspace_root"] = work_root
    exe = prof["bin"]()
    if not exe:
        return {"ok": False, "error": f"这台机器上没装 {key}（或只有 npm 垫片、没有真身 exe）"}
    runtime_issue = _profile_runtime_issue(prof, probe=True)
    if runtime_issue:
        return {"ok": False, "error": runtime_issue}

    dispatch_id = dispatch_identity.clean_dispatch_id(ctx.get("dispatchId"))
    sid = dispatch_identity.execution_ref(dispatch_id) or str(uuid.uuid4())
    if dispatch_id:
        existing = _existing_dispatch_receipt(sid, t, key, prof, assignee)
        if existing is not None:
            return existing
    workspace_policy = dict(ctx.get("workspacePolicy") or {})
    repo_ctx = dict(ctx.get("repo") or {})
    if workspace_policy.get("isolated") and repo_ctx and not ctx.get("workspacePrepared"):
        # Hub-local execution also requires a separate worktree for each node.
        # Runner execution prepares its worktree in runner_main and skips this setup.
        from . import workdirs
        repo_wire = SimpleNamespace(
            id=str(repo_ctx.get("id") or ""), name=str(repo_ctx.get("name") or ""),
            local_dir=str(repo_ctx.get("localDir") or ""),
            git_url=str(repo_ctx.get("gitUrl") or ""),
            default_branch=str(repo_ctx.get("branch") or ""),
        )
        primary = str(repo_ctx.get("path") or "").strip()
        root = (work_root or str((cfg or {}).get("local_workspace_root") or "").strip()
                or (os.path.dirname(primary) if primary else ""))
        prepared = workdirs.plan(
            root, repo_wire, getattr(t, "id", "") or "task", primary,
            dict((cfg or {}).get("git") or {}),
            execution_key=str(workspace_policy.get("isolationKey") or ""),
            base_ref=str(workspace_policy.get("baseRef") or ""),
        )
        if not prepared.get("ok"):
            return {"ok": False, "error": prepared.get("detail") or "隔离工作目录没准备好"}
        repo_ctx["path"] = prepared.get("dir") or ""
        ctx["repo"] = repo_ctx
        ctx["workDir"] = prepared.get("dir") or ""
        ctx["workspacePrepared"] = True
        ctx["workspaceManaged"] = bool(prepared.get("isolated"))
    # Prefer the dispatched repository directory, then the resolved workDir for temporary work.
    # Use the legacy default workspace only when neither explicit location is available.
    ws = (ctx.get("repo") or {}).get("path") or ctx.get("workDir") or ""
    if not ws or not os.path.isdir(ws):
        ws = os.path.join(_workspace_root(cfg), f"{getattr(t,'id','task')}_{int(time.time())}")
        os.makedirs(ws, exist_ok=True)
    from . import execution_capabilities
    required = execution_capabilities.required_for(t, ctx)
    # Runner grants are trusted device state, not task input. Keep the second
    # gate, but evaluate it with the same grants already checked by Runner.
    # Backend-local callers omit this argument and retain conservative defaults.
    verdict = execution_capabilities.evaluate(
        execution_capabilities.runtime_report(ws, grants=capability_grants),
        required)
    if not verdict["ok"]:
        return {"ok": False, "error": execution_capabilities.error_message(
            verdict, "本机执行器"), "capabilityPreflight": verdict}
    cfg = dict(cfg or {})
    cfg["requiredCapabilities"] = list(required)
    cfg["skillSelection"] = _sk
    try:
        resource_scope = skill_read_scope.materialize_bundles(cfg.get("pluginResourceBundles", []), ws)
    except (ValueError, OSError) as exc:
        return {"ok": False, "error": str(exc)}
    cfg.pop("accessPolicy", None)  # dispatch policy comes from the validated context
    try:
        policy = access_policy.prepare(key, ctx.get("accessPolicy"), ws)
    except access_policy.PolicyError as exc:
        return {"ok": False, "code": exc.code, "error": str(exc)}
    if policy:
        cfg["accessPolicy"] = policy
        cfg["_soduwork_agent_mode"] = "plan" if policy["mode"] == "readonly" else "work"
    if key == "codex":
        from . import codex_account_acp
        cfg[codex_account_acp.TRANSPORT_KEY] = codex_account_acp.TRANSPORT if policy else ""
        if policy and (issue := codex_account_acp.runtime_issue()):
            return {"ok": False, "error": issue}
    native = dict(ctx.get("agentExecution") or {})
    native_model = ""
    reasoning_effort = ""
    if key == "codex" and native:
        from . import agent_execution_options
        try:
            native = agent_execution_options.runtime_options(
                "local:codex", native.get("model") or "",
                native.get("reasoningEffort") or "")
        except ValueError as exc:
            return {"ok": False, "error": str(exc)}
        native_model = str(native.get("model") or "")
        reasoning_effort = str(native.get("reasoningEffort") or "")
        if native_model:
            cfg["codex_model"] = native_model
        if reasoning_effort:
            cfg["codex_reasoning_effort"] = reasoning_effort

    # Pass the repository URL to _env_for so its host can be included in the child NO_PROXY policy.
    # This also applies to native-account agents that do not receive shared model credentials.
    _rgit = str((ctx.get("repo") or {}).get("gitUrl") or "").strip()
    if _rgit:
        cfg = dict(cfg or {})
        cfg["repoGitUrl"] = _rgit
    context_report = {}
    descriptor = dict(ctx.get("projectContext") or {})
    if descriptor:
        from . import project_context_runtime
        try:
            context_report = project_context_runtime.prepare(
                ws, descriptor, dict(ctx.get("repo") or {}))
            context_prompt = str(context_report.pop("prompt", "") or "")
            if context_prompt:
                ctx["projectContextPrompt"] = context_prompt
        except Exception as exc:  # noqa: BLE001 - context failure must not lose the task
            context_report = {
                "schemaVersion": "project-context.v1", "state": "failed",
                "orgId": str(descriptor.get("orgId") or ""),
                "projectId": str(descriptor.get("projectId") or ""),
                "repoId": str(descriptor.get("repoId") or ""),
                "projectName": str(dict(descriptor.get("project") or {}).get("name") or ""),
                "repoName": str(dict(descriptor.get("repo") or {}).get("name") or ""),
                "error": "项目上下文准备失败：" + type(exc).__name__,
            }
    staged = _stage_inputs(sid, files)
    from . import runtime_images
    try:
        cfg = runtime_images.prepare(cfg, staged, os.path.join(_store_dir(sid), "inputs"))
    except (runtime_images.ImageInputError, OSError) as exc:
        return {"ok": False, "error": str(exc)}
    if staged:
        ctx["inputFiles"] = staged
    prompt = _compose(t, ctx)
    mode = "plan" if ctx.get("mode") == "plan" or (policy or {}).get("mode") == "readonly" else "work"
    artifact_mode = str(ctx.get("deliveryMode") or "").strip().lower()
    if artifact_mode not in ("files", "git", "mixed"):
        artifact_mode = "git" if dict(ctx.get("repo") or {}).get("gitUrl") else "files"
    # Git-only nodes use commits as authoritative evidence and skip full repository snapshots.
    seen = set() if artifact_mode == "git" else _snapshot(ws)
    expected_output_paths = declared_outputs.paths(ctx.get("expectedOutputs") or [])
    expected_output_baseline = declared_outputs.baseline(ws, expected_output_paths)
    from . import workspace_guard
    guard = workspace_guard.capture(ws, workspace_policy, ctx.get("expectedOutputs") or [])
    if guard.get("enabled") and not guard.get("ok"):
        return {"ok": False, "error": guard.get("reason") or "仓库只读门禁初始化失败"}
    win, win_known = _window_for(cfg)     # Use observed context limits when known, otherwise use estimates.
    if key == "codex":
        model = native_model or str(cfg.get("codex_model") or "")
    else:
        model = str(dict(cfg.get("llm") or {}).get("model") or "") if prof.get("needs_llm") else ""
    with _LOCK:
        _RUNS[sid] = {
            "cli": key, "ws": ws, "state": "running", "started": time.time(), "ended": None,
            "taskId": getattr(t, "id", ""), "title": getattr(t, "title", ""),
            "model": model,
            "modelLocalOnly": dict(cfg.get("llm") or {}).get("localOnly") is True,
            "reasoningEffort": reasoning_effort,
            # Delivery mode belongs to the node; a development task's requirements node still returns its document.
            "artifactMode": artifact_mode,
            "conversationMode": str(ctx.get("conversationMode") or ""),
            "codeTask": artifact_mode == "git",
            "workspaceGuard": guard,
            "contextReport": context_report,
            # Git is the authoritative code delivery, but review/scope nodes may
            # also owe one exact control file. Track only declared paths; never
            # scan or zip the complete repository to collect that receipt.
            "expectedOutputPaths": expected_output_paths,
            "expectedOutputBaseline": expected_output_baseline,
            "workspaceManaged": bool(ctx.get("workspaceManaged")),
            "executionPolicy": execution_policy.normalize(ctx.get("executionPolicy")),
            "executionPolicyState": {},
            "skillSelection": scope_skills,
            "_skillReadScope": skill_read_scope.ReadScope.skills(scope_skills),
            "_resourceReadScope": resource_scope.combine(ctx.get("_resourceReadScope")),
            "accessPolicy": policy, "appliedAccessPolicy": {},
            "pendingPermissions": [], "permissionWaiting": False,
            "lines": [], "seq": 0, "exit": None, "error": "", "turnCompleted": False,
            "completionRetries": 0,
            # Runtimes supporting own_session use the session ID allocated for this run.
            # Persist it immediately when starting the CLI with that explicit session ID.
            # Otherwise session consoles cannot resolve the session and may fall back to an unrelated shell.

            # Runtimes that allocate their own IDs report them through parsed output in local_stream.
            # Leave the ID empty here for those runtimes until that output arrives.
            "seen": seen, "cfg": dict(cfg or {}),
            "cliSid": (sid if prof.get("own_session") else ""), "pid": None, "proc": None,
            "segment": 1, "round": 1, "mode": mode, "detached": False, "queue": [],
            "admissionKey": str((cfg or {}).get("_admissionKey") or ""),
            "admissionStartSeq": 0,
            "tokens": {},  # Unknown until this run receives its first context measurement.
            "ctxWindow": win, "ctxWindowKnown": win_known,
            # tokens measures current context occupancy; each step's input includes earlier history.
            # Track cumulative usage separately from context occupancy.
            # Keep firstStarted separate from started, which resets on follow-ups and compaction.
            # Total elapsed time must include all execution segments.
            "usage": {"input": 0, "output": 0, "total": 0, "cost": 0.0, "turns": 0, "steps": 0},
            "firstStarted": time.time(),
        }
    from .runtime_messages import epoch_ms
    conversation_text = str(ctx.get("conversationUserText") or "").strip()
    if conversation_text:
        _record_event(sid, {
            "kind": "user", "tool": "", "text": conversation_text[:20000],
            "full": conversation_text[:50000],
            "sentAt": epoch_ms(ctx.get("conversationSentAt")) or int(time.time() * 1000),
            "plugins": conversation_plugins.badges(ctx.get("conversationPlugins")),
            "attachments": [{"name": str(item.get("name") or ""),
                             "path": str(item.get("path") or "")}
                            for item in staged],
        })

    _save_baseline(sid, seen)
    _save_meta(sid)
    _spawn(exe, prof["start"](sid, mode, ws, cfg), prompt, ws, sid, cfg, prof)
    return {"ok": True, "issueId": sid, "identifier": "LOCAL-" + sid[:8],
            "url": "", "assigneeType": "agent", "assigneeId": "local:" + key,
            "assigneeName": _seat_name(prof["name"]), "assigneeCli": prof["name"],
            "agentCli": key, "agentCliName": prof["name"],
            "agentSessionId": sid if prof.get("own_session") else "",
            "model": model, "selection": dict((assignee or {}).get("selection") or {}),
            "reasoningEffort": reasoning_effort,
            "files": len(staged), "provider": "local",
            "dispatchId": dispatch_id, "duplicate": False,
            "contextReport": context_report}

# Status, activity, and output contract.
def _new_files(run: dict) -> list[str]:
    """Return up to _ART_CAP new or changed deliverables, newest modification first. Record omitted
    counts in run['artDropped'] so output truncation remains visible.
    """
    fresh = _fresh_entries(run)
    # Update the shared run dictionary directly.
    with _LOCK:
        run["artDropped"] = max(0, len(fresh) - _ART_CAP)
    return [rel for rel, _m in fresh[:_ART_CAP]]


def _bundle_artifact(run: dict, entries: list[tuple[str, float]]) -> dict | None:
    return local_artifacts._bundle_artifact(
        run, entries, store_dir=_store_dir, max_bytes=_BUNDLE_MAX_BYTES)




def status_sync(cfg: dict, ref: str) -> dict:
    with _LOCK:
        run = _RUNS.get(ref)
    if not run:
        return {"ok": False, "error": "本地会话不在了"}
    artifact_mode = str(run.get("artifactMode") or ("git" if run.get("codeTask") else "files"))
    code_task = artifact_mode == "git"
    # When the remote branch is authoritative, skip full repository snapshots and ZIP creation.
    entries = [] if run["state"] == "running" or code_task else _fresh_entries(run)
    if run["state"] != "running":
        declared = declared_outputs.changed_entries(run)
        by_path = {str(rel).replace("\\", "/"): (rel, mtime)
                   for rel, mtime in entries}
        for rel, mtime in declared:
            by_path[str(rel).replace("\\", "/")] = (rel, mtime)
        entries = sorted(by_path.values(), key=lambda item: (-(item[1] or 0), item[0]))
    files = [rel for rel, _m in entries]
    bundle = _bundle_artifact(run, entries) if entries else None
    room = _ART_CAP - (1 if bundle else 0)
    shown = files[:max(0, room)]
    hidden = max(0, len(files) - len(shown))
    with _LOCK:
        run["artDropped"] = 0 if bundle else hidden
    # Office/files tasks have no branch delivery. Running Git in their temp folders
    # only adds latency and used to trigger the Runner worker-pool storm.
    git_delivery = _git_delivery(run) if artifact_mode in {"git", "mixed"} else {}
    from . import workspace_guard
    guard = workspace_guard.evaluate(run["ws"], run.get("workspaceGuard"))
    says = [str(item.get("full") or item.get("text") or "").strip()
            for item in (run.get("lines") or []) if item.get("kind") == "say"]
    final_text = next((text for text in reversed(says) if text), "")[:20000]
    attachments = ([{"id": bundle["id"], "filename": bundle["filename"]}] if bundle else [])
    attachments += [{"id": f, "filename": _rel_name(f)} for f in shown]
    return {
        "ok": True, "status": access_policy.visible_state(run), "title": run.get("title") or "",
        **access_policy.snapshot(run),
        "identifier": "LOCAL-" + ref[:8],
        # Context segments and semantic work rounds are different: compression may
        # open a segment, while every accepted follow-up starts a new artifact round.
        "segment": int(run.get("segment") or 1),
        "round": int(run.get("round") or 1),
        "admissionKey": str(run.get("admissionKey") or ""), "turnCorrelationVersion": 1,
        "running": run["state"] == "running",
        # Expose the provider completion signal used to advance the plugin DAG.
        # Otherwise a successfully exited session can remain stuck in running state.
        "done": run["state"] != "running",
        "comments": len(run.get("lines") or []),
        "last": " / ".join(x.get("text", "")[:80] for x in (run.get("lines") or [])[-3:]),
        # Stable cross-CLI result contract: only the last completed assistant message
        # counts as text delivery. Tool output and progress lines never satisfy it.
        "finalText": final_text,
        "error": run.get("error") or "",
        "failureKind": run.get("failureKind") or "",
        "failurePath": run.get("failurePath") or "",
        # Identify outputs by paths relative to this execution's workspace.
        # Keep relative paths in filenames as well.
        # Preserve website directory structure so extracted HTML can resolve styles and assets.
        "attachments": attachments,
        # Report the number of outputs omitted by the cap.
        "artifactsDropped": int(run.get("artDropped") or 0),
        "artifactsBundled": int(bundle.get("files") or 0) if bundle else 0,
        "artifactsHidden": hidden if bundle else 0,
        "artifactUrl": "",
        "deliveryKind": "code" if artifact_mode == "git" else artifact_mode,
        "workDirAbs": run["ws"],     # Local outputs are read directly from this location.
        "gitBranch": git_delivery.get("branch") or "",
        "gitRemoteBranch": git_delivery.get("remoteBranch") or "",
        "gitHead": git_delivery.get("head") or "",
        "gitDeliveryPending": bool(git_delivery.get("_pending")),
        "contextReport": dict(run.get("contextReport") or {}),
        "workspaceGuard": guard,
        "executionPolicyGuard": execution_policy.guard_status(
            run.get("executionPolicy"), run.get("executionPolicyState"),
            run.get("executionPolicyViolation")),
    }


def runner_info_sync(cfg: dict, ref: str) -> dict:
    with _LOCK:
        run = _RUNS.get(ref)
    if not run:
        return {}
    prof = _PROFILES.get(run["cli"]) or {}
    return {"workDir": run["ws"], "workDirAbs": run["ws"],
            "taskStatus": run["state"],
            "done": run["state"] not in ("running",),
            "failed": run["state"] in ("failed", "interrupted"),
            "error": run.get("error") or "",
            "failureKind": run.get("failureKind") or "",
            "failurePath": run.get("failurePath") or "",
            "agentName": _seat_name(prof.get("name") or run["cli"]),
            "cli": run["cli"], "cliName": prof.get("name") or run["cli"],
            "cliSid": run.get("cliSid") or "",
            "model": run.get("model") or "",
            "device": os.environ.get("COMPUTERNAME", "本机")}




def session_sync(cfg: dict, ref: str, since: int = 0, limit: int = 400) -> dict:
    """Return incremental console activity plus current context occupancy, segment count, and
    state. Use memory when available and archives for older or restarted sessions.
    """
    with _LOCK:
        run = _RUNS.get(ref)
    # A client can reconnect before the startup reclaim pass reaches this ref.
    # Rehydrate the persisted snapshot so context tokens and model-window data
    # are available immediately after a Hub restart.
    if not run:
        meta_path = os.path.join(_STORE, ref, "meta.json")
        if os.path.isfile(meta_path):
            reclaim()
            with _LOCK:
                run = _RUNS.get(ref)
    with _LOCK:
        if run:
            mem = list(run.get("lines") or [])
            state, seq = run.get("state"), int(run.get("seq") or 0)
            pct, seg = ctx_pct(run), run.get("segment", 1)
            round_no = int(run.get("round") or 1)
            admission_key = str(run.get("admissionKey") or "")
            admission_start = run.get("admissionStartSeq")
            task_id = str(run.get("taskId") or "")
            tokens = dict(run.get("tokens") or {})
            win, detached = run.get("ctxWindow"), bool(run.get("detached"))
            known = bool(run.get("ctxWindowKnown"))
            err, ws = run.get("error") or "", run.get("ws") or ""
            failure_kind = run.get("failureKind") or ""
            failure_path = run.get("failurePath") or ""
            cli = run.get("cli") or ""
            cli_name = (_PROFILES.get(cli) or {}).get("name") or cli
            cli_sid, model = run.get("cliSid") or "", run.get("model") or ""
    if not run:
        items = _read_events(ref, since, limit)
        if not items and since == 0:
            return {"ok": False, "items": [], "error": "本地会话不在了"}
        return {"ok": True, "items": items, "status": "unknown",
                "last": items[-1]["seq"] if items else since}
    first = mem[0]["seq"] if mem else 0
    if mem and since >= first - 1:
        items = [x for x in mem if x["seq"] > since][:limit]
    else:
        items = _read_events(ref, since, limit)      # Read the archive when the requested history predates the memory buffer.
    return {"ok": True, "ref": ref, "taskId": task_id, "items": items, "status": access_policy.visible_state(run) if run else state,
            **(access_policy.snapshot(run) if run else {}),
            "last": items[-1]["seq"] if items else since,
            "seq": seq, "segment": seg, "round": round_no, "detached": detached,
            "admissionKey": admission_key, "admissionStartSeq": admission_start, "turnCorrelationVersion": 1,
            "tokens": tokens, "ctxPct": round(pct, 1), "ctxWindow": win,
            "ctxWindowKnown": known, "error": err, "workDir": ws,
            "failureKind": failure_kind, "failurePath": failure_path,
            "cli": cli, "cliName": cli_name, "cliSid": cli_sid, "model": model,
            "activeExecutionSelection": {"agentId": cli, "modelName": model,
                "reasoningEffort": str(run.get("reasoningEffort") or "")},
            # Report cumulative usage separately from current context occupancy.
            "usage": dict(run.get("usage") or {}) if run else {},
            "firstStarted": (run.get("firstStarted") or run.get("started") or 0) if run else 0,
            "started": run.get("started") or 0, "ended": run.get("ended") or 0,
            "executionStartedAt": run.get("executionStartedAt") or 0,
            "canStop": state == "running"}


def console_list_sync(cfg: dict, task_ids: list[str] | None = None) -> dict:
    """List local sessions from the in-memory mirror without network calls or directory scans; this
    endpoint is polled frequently.
    """
    keep = set(task_ids) if task_ids else None
    out = []
    with _LOCK:
        for ref, run in _RUNS.items():
            if keep is not None and run.get("taskId") not in keep:
                continue
            prof = _PROFILES.get(run.get("cli") or "") or {}
            item = {
                "ref": ref, "taskId": run.get("taskId") or "", "title": run.get("title") or "",
                "cli": run.get("cli") or "", "cliName": prof.get("name") or run.get("cli") or "",
                "state": run.get("state") or "", "started": run.get("started") or 0,
                "executionStartedAt": run.get("executionStartedAt") or 0,
                "ended": run.get("ended") or 0, "seq": int(run.get("seq") or 0),
                "segment": run.get("segment", 1), "round": int(run.get("round") or 1),
                "admissionKey": str(run.get("admissionKey") or ""), "turnCorrelationVersion": 1,
                "detached": bool(run.get("detached")),
                "ctxPct": round(ctx_pct(run), 1),
                "usage": dict(run.get("usage") or {}),
                "firstStarted": run.get("firstStarted") or run.get("started") or 0,
                "model": run.get("model") or "", "cliSid": run.get("cliSid") or "",
                "tokens": dict(run.get("tokens") or {}),
                "ctxWindow": run.get("ctxWindow") or _CTX_WINDOW_DEFAULT,
                "ctxWindowKnown": bool(run.get("ctxWindowKnown")),
                "queued": len(run.get("queue") or []), "error": run.get("error") or "",
                "failureKind": run.get("failureKind") or "",
                "failurePath": run.get("failurePath") or "",
                "workDir": run.get("ws") or "", "local": True,
            }
            out.append(item)
    out.sort(key=lambda x: (x["state"] != "running", -(x["started"] or 0)))
    return {"ok": True, "runs": out}


def comments_sync(cfg: dict, ref: str, limit: int = 30) -> dict:
    """Return agent responses as comments so planning can recover and parse the full plan."""
    with _LOCK:
        run = _RUNS.get(ref)
    lines = list((run or {}).get("lines") or []) or _read_events(ref, 0, 2000)
    if not run and not lines:
        return {"ok": False, "items": [], "error": "本地会话不在了"}
    # Prefer full response text over the truncated activity-display text.
    # Plan parsing requires the complete response.
    says = [(x.get("full") or x.get("text") or "") for x in lines if x.get("kind") == "say"]
    return {"ok": True, "items": [{"body": s, "author": "本地 CLI", "isAgent": True, "at": ""}
                                  for s in says[-limit:]]}


def attachment_path_for(run: dict, att_id: str) -> str:
    """Resolve a safe local artifact path, either a workspace file or a generated complete archive.

    """
    aid = str(att_id or "")
    if aid.startswith(_BUNDLE_PREFIX):
        name = aid[len(_BUNDLE_PREFIX):]
        if not name or name != os.path.basename(name):
            return ""
        path = os.path.join(_store_dir(str(run.get("ref") or "")), "bundles", name)
        return path if os.path.isfile(path) else ""
    return _safe_work_file(run, aid)


def _read_in(run: dict, att_id: str) -> bytes | None:
    p = attachment_path_for(run, att_id)
    if not p:
        return None
    try:
        if os.path.getsize(p) > _BUNDLE_MAX_BYTES:
            return None
        with open(p, "rb") as f:
            return f.read()
    except OSError:
        return None


def fetch_attachment_for_sync(cfg: dict, ref: str, att_id: str) -> bytes | None:
    """Fetch an artifact within a specific execution. Relative artifact paths can repeat across
    tasks, so the execution ref is required for unambiguous retrieval.
    """
    with _LOCK:
        run = _RUNS.get(str(ref or ""))
    return _read_in(run, att_id) if run else None


def fetch_attachment_sync(cfg: dict, att_id: str) -> bytes | None:
    """Legacy artifact lookup by workspace-relative path. Use only when no execution ref is
    available; same-named artifacts can otherwise resolve ambiguously.
    """
    with _LOCK:
        runs = list(_RUNS.values())
    for run in runs:
        p = os.path.join(run["ws"], att_id)
        if os.path.isfile(p) and os.path.abspath(p).startswith(os.path.abspath(run["ws"])):
            try:
                if os.path.getsize(p) > 20 * 1024 * 1024:
                    return None
                with open(p, "rb") as f:
                    return f.read()
            except OSError:
                return None
    return None


def preview_issue(t, cfg: dict, ctx: dict | None = None) -> dict:
    return {"title": getattr(t, "title", ""), "description": _compose(t, ctx or {})}
