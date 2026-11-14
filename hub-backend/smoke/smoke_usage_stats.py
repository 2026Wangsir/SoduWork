# -*- coding: utf-8 -*-
"""Offline session usage tests without business database access. Keep cumulative consumption
separate from the overwritten context watermark, capture Claude result usage, cost, duration,
and turns, retain the original session start across follow-ups and compaction, and report the
model for cost attribution.
"""
import asyncio
import os
import sys
import tempfile

_DB_DIR = tempfile.TemporaryDirectory(prefix="soduwork-usage-stats-")
DB = os.path.join(_DB_DIR.name, "usage.db")
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
sys.path.insert(0, ".")

from app.db import engine  # noqa: E402
from app.services.local_stream import _accumulate_usage  # noqa: E402

ok = fail = 0


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra) if extra else ""))


def new_run():
    return {"usage": {"input": 0, "output": 0, "total": 0, "cost": 0.0, "turns": 0, "steps": 0}}


def main():
    # Accumulate consumption rather than overwriting the context watermark.
    run = new_run()
    _accumulate_usage(run, {"input": 100, "output": 20}, step=True)
    _accumulate_usage(run, {"input": 300, "output": 50}, step=True)
    u = run["usage"]
    chk("★多步是累加不是覆盖", u["input"] == 400 and u["output"] == 70, u)
    chk("总数 = 输入 + 输出", u["total"] == 470, u)
    chk("步数记下来了", u["steps"] == 2, u)

    # Accept each CLI's distinct usage field names.
    run = new_run()
    _accumulate_usage(run, {"input_tokens": 10, "output_tokens": 2})
    _accumulate_usage(run, {"prompt_tokens": 5, "completion_tokens": 1})
    chk("认 input_tokens / prompt_tokens 这些别名",
        run["usage"]["input"] == 15 and run["usage"]["output"] == 3, run["usage"])

    # Include billable cache reads and writes in input accounting.
    run = new_run()
    _accumulate_usage(run, {"input": 10, "cache_read_input_tokens": 900,
                            "cache_creation_input_tokens": 90})
    chk("缓存读写算进输入", run["usage"]["input"] == 1000, run["usage"])

    # Capture cost and turn count from Claude result events.
    run = new_run()
    _accumulate_usage(run, {"input": 1000, "output": 200},
                      cost=0.0123, turns=3)
    chk("★收下了花的钱", run["usage"]["cost"] == 0.0123, run["usage"])
    chk("★收下了轮数", run["usage"]["turns"] == 3, run["usage"])
    _accumulate_usage(run, {"input": 500, "output": 100}, cost=0.01, turns=2)
    chk("钱和轮数也是累加", run["usage"]["cost"] == 0.0223 and run["usage"]["turns"] == 5,
        run["usage"])

    # Reject missing or malformed values without corrupting totals.
    run = new_run()
    _accumulate_usage(run, {})
    _accumulate_usage(run, None)
    _accumulate_usage(run, {"input": 0, "output": 0})
    _accumulate_usage(run, "不是字典")
    chk("空的、坏的一律不动统计", run["usage"]["total"] == 0 and run["usage"]["steps"] == 0,
        run["usage"])

    # Keep context occupancy and token consumption in separate fields.
    run = {"tokens": {"input": 0}, "usage": {"input": 0, "output": 0, "total": 0}}
    for wave in (5000, 9000, 14000):          # Context occupancy grows with history at each step.
        run["tokens"] = {"input": wave, "output": 100, "total": wave + 100}
        _accumulate_usage(run, {"input": wave, "output": 100}, step=True)
    chk("★水位仍是最后一步的快照", run["tokens"]["input"] == 14000, run["tokens"])
    chk("★消耗是自己那一份，和水位分开", run["usage"]["input"] == 28000, run["usage"])
    chk("★两者不是同一个对象（改一个不会动另一个）",
        run["tokens"] is not run["usage"])

    # Expose usage and firstStarted in local execution lists and session views.
    import inspect

    from app.services import ai_local, execution_sessions
    src = inspect.getsource(ai_local.console_list_sync)
    chk("控制台一览带上了 usage", '"usage"' in src, src[:200])
    chk("控制台一览带上了整条活的开始时间", "firstStarted" in src)
    src2 = inspect.getsource(execution_sessions.session_api)
    chk("执行会话回执带上了 usage", '"usage"' in src2)
    src3 = inspect.getsource(execution_sessions.ingest_runner_snapshots)
    chk("runner 心跳里的 usage 会落库", '"usage"' in src3)
    chk("runner 心跳里的 firstStarted 会落库", "firstStarted" in src3)
    from unittest.mock import patch
    from app.services import local_base
    from runner_main import Runner
    machine = Runner.__new__(Runner)
    machine._agent_inventory, machine._session_marks = [], {}
    tracked = {"ref": "usage-push", "taskId": "fixture-task", "cli": "qwen",
               "model": "hub-model", "state": "done", "seq": 1,
               "cfg": {"llm": {"model": "hub-model"}}}
    _accumulate_usage(tracked, {"input": 7, "output": 3})
    with patch.object(ai_local, "console_list_sync", return_value={"runs": [tracked]}), \
         patch.object(ai_local, "session_sync", return_value={"seq": 1, "items": []}), \
         patch.dict(local_base._RUNS, {"usage-push": tracked}):
        snapshots, _ = machine._session_snapshots()
        chk("Runner reports Hub-funded usage", snapshots[0]["usage"]["total_tokens"] == 10)
        chk("Runner reports the managed model", snapshots[0]["model"] == "hub-model")
        tracked["cfg"]["llm"] = {"model": "private-wire-model", "localOnly": True}
        tracked["model"] = "private-wire-model"
        _accumulate_usage(tracked, {"input": 900, "output": 100})
        snapshots, _ = machine._session_snapshots()
        chk("Runner retains local model identity on device", snapshots[0]["model"] == "")
        chk("Runner excludes local usage from Hub totals", snapshots[0]["usage"]["total_tokens"] == 10)

    # Exercise actual continuation and segment-transition entry points rather than source layout.
    from unittest.mock import Mock, patch
    from app.services import local_base, local_ctx, local_stream
    ref = "usage-context-smoke"
    run = {"cli": "usage-fixture", "cliSid": "old-native-session", "ws": ".",
           "cfg": {}, "mode": "plan", "state": "done", "started": 200,
           "firstStarted": 100, "round": 1, "segment": 1,
           "tokens": {"input": 9000}, "usage": {"input": 17000, "output": 500,
           "total": 17500, "cost": 0.123, "steps": 7}, "ctxWindowKnown": False}
    usage = dict(run["usage"])
    profile = {"bin": lambda: "fixture", "own_session": True,
               "start": lambda *args: ["start"], "resume": lambda *args: ["resume"]}
    with patch.dict(local_base._RUNS, {ref: run}), \
         patch.dict(local_base._PROFILES, {"usage-fixture": profile}), \
         patch.object(local_stream, "_spawn", Mock()), \
         patch.object(local_ctx, "_save_meta", Mock()), \
         patch.object(local_ctx, "_note", Mock()), \
         patch.object(local_ctx, "_handoff_brief", return_value="archived checkpoint"):
        resumed = local_stream._resume(ref, "继续")
        chk("★追问不会重置整条活的开始时间",
            resumed.get("ok") and run["firstStarted"] == 100 and run["started"] > 200)
        chk("追问保留累计消耗", run["usage"] == usage, run["usage"])
        relayed = local_ctx._relay(ref, "继续")
        chk("★上下文压缩换段也不会重置",
            relayed and run["segment"] == 2 and run["firstStarted"] == 100)
        chk("压缩换段时水位归零但消耗不清",
            local_base.ctx_pct(run) == 0 and not run["tokens"] and run["usage"] == usage)

    print("\nusage stats smoke: %d passed, %d failed" % (ok, fail))
    return 1 if fail else 0


try:
    result = main()
finally:
    asyncio.run(engine.dispose())
    _DB_DIR.cleanup()
sys.exit(result)
