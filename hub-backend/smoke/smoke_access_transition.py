"""Real local spool + ACP process tests; no model, network service or user data."""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import sys
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def fake_agent():
    from app.services.access_transition import CONTINUATION
    from tests.opencode_peer_outcome import NativeOutcome
    native_outcome = NativeOutcome()
    scenario, agent = sys.argv[-2:]
    lock = threading.Lock()
    prompt_id = None
    resumed = False
    mode_count = 0
    def send(value):
        with lock:
            print(json.dumps(value), flush=True)
    def update(value):
        send({"jsonrpc": "2.0", "method": "session/update", "params": {"update": value}})
    def record(value):
        with open("trace.jsonl", "a", encoding="utf-8") as handle:
            handle.write(json.dumps(value) + "\n")
    modes = ["default", "plan", "yolo", "agent", "read-only", "agent-full-access"]
    config = {"sessionId": "native-kept", "modes": {"availableModes": [{"id": x} for x in modes]}}
    if agent == "opencode":
        from urllib.request import url2pathname
        from urllib.parse import urlparse
        plugins = json.loads(os.environ["OPENCODE_CONFIG_CONTENT"])["plugin"]
        markers = [match[1] for plugin in plugins
                   if (match := re.search(r'const agentId = "([^"]+)";',
                       Path(url2pathname(urlparse(plugin).path)).read_text(encoding="utf-8")))]
        assert len(markers) == 1, "Exactly one native permission guard is required"
        marker = markers[0]
        config["configOptions"] = [{"id": "mode", "options": [{"value": x} for x in [marker, "build", "plan"]]}]
    for raw in sys.stdin:
        message = json.loads(raw)
        method, params = message.get("method"), message.get("params") or {}
        if not method:
            record({"permission": message.get("result")})
            update({"sessionUpdate": "tool_call_update", "toolCallId": "approval", "status": "failed",
                    "content": [{"type": "content", "content": {"type": "text", "text": "Permission request withdrawn"}}]})
            if scenario == "approval-end":
                native_outcome.end("native-kept")
                send({"jsonrpc": "2.0", "id": prompt_id, "result": {
                    "stopReason": "end_turn"}})
            continue
        result = {}
        if method == "initialize":
            record({"capabilities": params["clientCapabilities"], "pid": os.getpid()})
            if scenario == "cold-start":
                time.sleep(1)
            result = {"protocolVersion": 1, "agentCapabilities": {"loadSession": scenario != "unsupported"}}
        elif method in {"session/new", "session/load", "session/resume"}:
            if method != "session/new":
                resumed = True
                assert params["sessionId"] == "native-kept"
            record({"session": method, "id": params.get("sessionId")})
            result = config
        elif method in {"session/set_mode", "session/set_config_option"}:
            mode_count += 1
            record({"mode": params.get("modeId") or params.get("value")})
            if scenario == "slow-apply" and (resumed or mode_count > 1):
                time.sleep(.8)
            if scenario == "apply-fail" and (resumed or mode_count > 1):
                send({"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32000, "message": "Fixture rejects the new mode"}})
                continue
        elif method == "session/prompt":
            native_outcome.begin("native-kept")
            prompt_id = message["id"]
            text = params["prompt"][0]["text"]
            record({"prompt": text})
            internal = text == CONTINUATION
            if internal:
                update({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Continued saved work"}})
                # Remain active until the fixture explicitly ends/stops it.
                continue
            if scenario in {"tool", "stop", "timeout"}:
                update({"sessionUpdate": "tool_call", "toolCallId": "side-effect", "status": "in_progress"})
                def finish_tool():
                    time.sleep(.8 if scenario != "timeout" else 1.5)
                    with open("effects.txt", "a", encoding="utf-8") as handle:
                        handle.write("once\n")
                    update({"sessionUpdate": "tool_call_update", "toolCallId": "side-effect", "status": "completed"})
                threading.Thread(target=finish_tool, daemon=True).start()
            if scenario in {"approval", "approval-end"}:
                update({"sessionUpdate": "tool_call", "toolCallId": "approval", "status": "pending"})
                send({"jsonrpc": "2.0", "id": "permission", "method": "session/request_permission", "params": {
                    "toolCall": {"toolCallId": "approval", "kind": "execute", "rawInput": {"command": "fixture"}},
                    "options": [{"optionId": "allow", "kind": "allow_once"}, {"optionId": "deny", "kind": "reject_once"}]}})
            continue
        elif method == "session/cancel":
            record({"cancel": True})
            if scenario == "raced-tool":
                update({"sessionUpdate": "tool_call", "toolCallId": "late-tool", "status": "in_progress"})
                update({"sessionUpdate": "tool_call_update", "toolCallId": "late-tool", "status": "failed"})
            send({"jsonrpc": "2.0", "id": prompt_id, "result": {"stopReason": "cancelled"}})
            continue
        else:
            raise AssertionError(method)
        send({"jsonrpc": "2.0", "id": message["id"], "result": result})


if "--fake-agent" in sys.argv:
    fake_agent()
    raise SystemExit(0)

DATA = tempfile.TemporaryDirectory(prefix="soduwork-access-transition-")
os.environ["SODUWORK_DATA_ROOT"] = DATA.name
from app.services import access_policy, access_transition, access_broker, acp_agents, ai_local, local_base, local_stream
from app.services.acp_transition import Transition


def wait_for(check, timeout=12):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(.025)
    raise AssertionError("Fixture condition timed out")


class TransitionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-access-live-")
        self.ws = Path(self.temp.name)
        self.refs = []
        self.patches = []

    def tearDown(self):
        for ref in self.refs:
            if local_base._RUNS.get(ref, {}).get("state") in {"running", "access-changing"}:
                local_stream.stop_sync({}, ref)
            access_broker.close(ref)
        for thread in list(local_base._THREADS):
            if thread.name.startswith("ai_local:"):
                thread.join(2)
        for ref in self.refs:
            local_base._RUNS.pop(ref, None)
        for handle in self.patches:
            handle.stop()
        self.temp.cleanup()

    def start(self, scenario="stream", agent="qwen", mode="standard"):
        profile = dict(local_base._PROFILES[agent])
        profile.update(bin=lambda: sys.executable, needs_llm=False,
            command=lambda exe, args, ws, cfg: [sys.executable, "-B", str(ROOT / "app/services/acp_bridge.py"),
                "--cwd", ws, "--agent-name", agent, "--permission", "workspace",
                *(["--session", "native-kept"] if acp_agents._metadata(args)[0] or "--session" in args else []),
                "--", sys.executable, "-B", str(Path(__file__).resolve()), "--fake-agent", scenario, agent])
        handle = patch.dict(local_base._PROFILES, {agent: profile})
        handle.start(); self.patches.append(handle)
        if agent == "opencode":
            from app.services import local_process
            handle = patch.object(local_process, "_command_argv", lambda exe, args, ws, cfg, prof: prof["command"](exe, args, ws, cfg))
            handle.start(); self.patches.append(handle)
        policy = access_policy.normalize({"schema": access_policy.SCHEMA, "revision": 1,
            "mode": mode, "workspaceRoot": str(self.ws)})
        result = ai_local.dispatch_sync({"local_cli": agent, "local_workspace_root": str(self.ws)},
            SimpleNamespace(id="live-access-fixture", title="original request", note=""),
            assignee={"id": "local:" + agent}, capability_grants=["files"],
            ctx={"accessPolicy": policy, "workDir": str(self.ws), "conversationMode": "adaptive",
                 "deliveryMode": "files", "requiredAgentCapabilities": ["files"]})
        self.assertTrue(result["ok"], result)
        ref = result["issueId"]; self.refs.append(ref)
        try:
            wait_for(lambda: self.prompts())
            # The child's trace precedes the real spool follower. These cases
            # change an initialized session, not one awaiting its first identity.
            wait_for(lambda: local_base._RUNS[ref].get("cliSid") == "native-kept" and
                     (local_base._RUNS[ref].get("appliedAccessPolicy") or {}).get("state") == "applied")
        except AssertionError:
            raise AssertionError(str(local_base._RUNS[ref].get("error")) + "\n" + str(local_base._RUNS[ref].get("lines")))
        return ref, local_base._RUNS[ref], policy

    def trace(self):
        try:
            return [json.loads(x) for x in (self.ws / "trace.jsonl").read_text().splitlines()]
        except FileNotFoundError:
            return []

    def prompts(self):
        return [x["prompt"] for x in self.trace() if "prompt" in x]

    def change(self, ref, policy, mode="full", **kwargs):
        return access_transition.apply(ref, {**policy, "mode": mode, "revision": policy["revision"] + 1}, policy["revision"], **kwargs)

    def test_three_agents_resume_same_turn_after_real_cancel_and_reinitialize(self):
        for agent in ("qwen", "codex-harness", "opencode"):
            with self.subTest(agent=agent):
                ref, run, policy = self.start(agent=agent, mode="readonly")
                round_number, context, original = run["round"], run.get("contextRequest"), self.prompts()[-1]
                started = run["started"]
                run["queue"] = ["preserved queued instruction"]
                changed = self.change(ref, policy)
                self.assertTrue(changed["ok"], changed)
                self.assertEqual(changed["effective"], "current-turn")
                self.assertEqual(run["appliedAccessPolicy"]["mode"], "full")
                persisted = json.loads((Path(local_base._STORE) / ref / "meta.json").read_text(encoding="utf-8"))
                self.assertEqual(persisted["accessPolicy"]["mode"], "full")
                self.assertEqual(persisted["accessPolicy"]["revision"], 2)
                self.assertEqual(persisted["appliedAccessPolicy"]["policyHash"], run["accessPolicy"]["policyHash"])
                wait_for(lambda: len(self.prompts()) >= 2)
                self.assertEqual(self.prompts().count(original), 1)
                self.assertEqual(self.prompts()[-1], access_transition.CONTINUATION)
                self.assertEqual(run["cliSid"], "native-kept")
                self.assertEqual(run["round"], round_number)
                self.assertEqual(run["started"], started)
                self.assertEqual(run.get("contextRequest"), context)
                self.assertEqual(run["queue"], ["preserved queued instruction"])
                caps = [row["capabilities"] for row in self.trace() if "capabilities" in row]
                self.assertFalse(caps[-2]["fs"]["writeTextFile"])
                self.assertTrue(caps[-1]["fs"]["writeTextFile"])
                local_stream.stop_sync({}, ref)
                wait_for(lambda: run["state"] != "running")
                (self.ws / "trace.jsonl").unlink()

    def test_waits_for_started_tool_without_repeating_side_effect(self):
        ref, run, policy = self.start("tool")
        changed = self.change(ref, policy)
        self.assertTrue(changed["ok"], changed)
        self.assertEqual((self.ws / "effects.txt").read_text(), "once\n")
        self.assertEqual(len(self.prompts()), 2)

    def test_standard_full_hot_transition_keeps_process_and_avoids_cold_initialization(self):
        for agent in ("qwen", "codex-harness"):
            with self.subTest(agent=agent):
                ref, run, policy = self.start("cold-start", agent=agent)
                initial_pid = run["pid"]
                original_prompt = self.prompts()[-1]
                started = time.monotonic()
                changed = self.change(ref, policy)
                elapsed = time.monotonic() - started
                print("hot-transition %s standard->full %.3fs" % (agent, elapsed), flush=True)
                self.assertTrue(changed["ok"], changed)
                wait_for(lambda: len(self.prompts()) == 2)
                self.assertLess(elapsed, .9, "one-second native cold initialization must not repeat")
                self.assertEqual(run["pid"], initial_pid)
                self.assertEqual(len([x for x in self.trace() if "capabilities" in x]), 1)
                self.assertEqual(len([x for x in self.trace() if "session" in x]), 1)
                self.assertEqual(self.prompts().count(original_prompt), 1)
                self.assertEqual(self.prompts()[-1], access_transition.CONTINUATION)
                self.assertEqual(run["appliedAccessPolicy"]["mode"], "full")
                # A subsequent downgrade uses the same native process too,
                # restoring the standard gate before another internal prompt.
                downgraded = self.change(ref, run["accessPolicy"], "standard")
                self.assertTrue(downgraded["ok"], downgraded)
                wait_for(lambda: len(self.prompts()) == 3)
                self.assertEqual(run["pid"], initial_pid)
                self.assertEqual(run["appliedAccessPolicy"]["mode"], "standard")
                self.assertEqual(run["accessPolicy"]["revision"], 3)
                local_stream.stop_sync({}, ref)
                wait_for(lambda: run["state"] != "running")
                (self.ws / "trace.jsonl").unlink()

    def test_waiting_approval_is_invalidated_and_not_granted(self):
        ref, run, policy = self.start("approval")
        row = wait_for(lambda: run.get("pendingPermissions"))[0]
        changed = self.change(ref, policy)
        self.assertTrue(changed["ok"], changed)
        self.assertFalse(access_broker.respond(ref, row["requestId"], "once", 1)["ok"])
        self.assertEqual([x["permission"]["outcome"]["optionId"] for x in self.trace() if "permission" in x], ["deny"])
        withdrawn = next(x for x in local_base._read_events(ref, 0) if x.get("kind") == "out" and x.get("callId") == "approval")
        self.assertFalse(withdrawn["isError"])
        self.assertEqual(withdrawn["state"], "cancelled")
        self.assertEqual(withdrawn["cancelReason"], "access-change")
        self.assertEqual(withdrawn["text"], "Permission request withdrawn")
        self.assertFalse(any(x.get("isError") for x in run["lines"]))

    def test_permission_cancellation_end_turn_continues_instead_of_settling(self):
        ref, run, policy = self.start("approval-end")
        wait_for(lambda: run.get("pendingPermissions"))
        changed = self.change(ref, policy)
        self.assertTrue(changed["ok"], changed)
        wait_for(lambda: len(self.prompts()) == 2)
        self.assertEqual(self.prompts()[-1], access_transition.CONTINUATION)
        self.assertEqual(run["state"], "running")

    def test_unsupported_resume_leaves_original_turn_running(self):
        ref, run, policy = self.start("unsupported")
        changed = self.change(ref, policy)
        self.assertFalse(changed["ok"])
        self.assertEqual(run["accessPolicy"], policy)
        self.assertEqual(run["state"], "running")
        self.assertFalse(any("cancel" in x for x in self.trace()))

    def test_timeout_does_not_abort_or_replay_started_tool(self):
        ref, run, policy = self.start("timeout")
        changed = self.change(ref, policy, timeout=.2)
        self.assertFalse(changed["ok"])
        self.assertEqual(run["accessPolicy"], policy)
        wait_for(lambda: (self.ws / "effects.txt").exists())
        self.assertEqual(len(self.prompts()), 1)
        self.assertFalse(any("cancel" in x for x in self.trace()))

    def test_user_stop_cancels_automatic_continuation(self):
        ref, run, policy = self.start("stop")
        result = []
        thread = threading.Thread(target=lambda: result.append(self.change(ref, policy)))
        thread.start()
        wait_for(lambda: run.get("_accessTransition"))
        local_stream.stop_sync({}, ref)
        thread.join(8)
        self.assertFalse(thread.is_alive())
        self.assertFalse(result[0]["ok"])
        self.assertEqual(len(self.prompts()), 1)

    def test_racing_cancelled_tool_never_automatically_replays(self):
        ref, run, policy = self.start("raced-tool")
        changed = self.change(ref, policy)
        self.assertFalse(changed["ok"])
        self.assertEqual(run["accessPolicy"], policy)
        self.assertEqual(len(self.prompts()), 1)

        # The authenticated control reply can precede the durable stdout
        # follower. Wait for the real event, never replace it with a mock.
        failure = wait_for(lambda: next((x for x in run["lines"] if x.get("kind") == "out" and x.get("callId") == "late-tool"), None))
        self.assertTrue(failure["isError"])
        self.assertNotIn("cancelReason", failure)

    def test_native_mode_failure_restores_old_policy_without_replaying_prompt(self):
        ref, run, policy = self.start("apply-fail")
        changed = self.change(ref, policy)
        self.assertFalse(changed["ok"])
        self.assertEqual(run["accessPolicy"], policy)
        self.assertEqual(run["state"], "interrupted")
        self.assertEqual(run["cliSid"], "native-kept")
        self.assertEqual(len(self.prompts()), 1)

    def test_cancel_requires_live_matching_control_acknowledgement(self):
        for acknowledgement in ({"requested": False}, {"requested": True, "id": "different"}):
            requests, sends = [], []
            def call(_path, payload):
                requests.append(payload)
                return {"requested": True, "id": "selected"} if payload["stage"] == "query" else acknowledgement
            bridge = SimpleNamespace(access=SimpleNamespace(enabled=True, call=call),
                terminals={}, session_id="native-kept", send=sends.append)
            transition = Transition(bridge)
            transition.resumable = True
            transition.tick("session/prompt")
            self.assertEqual([x["stage"] for x in requests], ["query", "cancel-sent"])
            self.assertEqual(sends, [])
            self.assertFalse(transition.cancel_sent)

    def test_public_snapshot_waits_for_native_applied_ack(self):
        ref, run, policy = self.start("slow-apply")
        results = []
        thread = threading.Thread(target=lambda: results.append(self.change(ref, policy)))
        thread.start()
        wait_for(lambda: run.get("accessPolicy", {}).get("revision") == 2)
        public = access_policy.snapshot(run)
        self.assertEqual(public["accessPolicy"]["mode"], "standard")
        self.assertEqual(public["nextAccessPolicy"]["mode"], "full")
        self.assertFalse(public["appliedAccessPolicy"])
        self.assertEqual(results, [])
        thread.join(12)
        self.assertFalse(thread.is_alive())
        self.assertTrue(results[0]["ok"], results)
        public = access_policy.snapshot(run)
        self.assertEqual(public["accessPolicy"]["mode"], "full")
        self.assertFalse(public["nextAccessPolicy"])

    def test_user_stop_during_hot_mode_ack_never_sends_continuation(self):
        ref, run, policy = self.start("slow-apply")
        results = []
        thread = threading.Thread(target=lambda: results.append(self.change(ref, policy)))
        thread.start()
        wait_for(lambda: (run.get("_accessTransition") or {}).get("phase") == "in-process-applying")
        local_stream.stop_sync({}, ref)
        thread.join(8)
        self.assertFalse(thread.is_alive())
        self.assertFalse(results[0]["ok"])
        self.assertEqual(run["accessPolicy"], policy)
        self.assertEqual(len(self.prompts()), 1)

    def test_hot_native_ack_timeout_is_failed_closed_without_late_continuation(self):
        ref, run, policy = self.start("slow-apply")
        result = self.change(ref, policy, timeout=.4)
        self.assertFalse(result["ok"], result)
        time.sleep(1)
        self.assertEqual(run["accessPolicy"], policy)
        self.assertEqual(run["state"], "interrupted")
        self.assertEqual(len(self.prompts()), 1)

    def test_failed_transition_fences_late_ack_before_process_cleanup(self):
        policy = access_policy.normalize({"schema": access_policy.SCHEMA, "revision": 1,
            "mode": "standard", "workspaceRoot": str(self.ws)})
        target = access_policy.normalize({**policy, "mode": "full", "revision": 2})
        ref = "late-permission-ack"
        run = {"state": "running", "ws": str(self.ws), "accessPolicy": target,
               "appliedAccessPolicy": {"state": "applied", "policyHash": target["policyHash"]},
               "_accessTransition": {"id": "expired-change", "phase": "in-process-applying",
                   "inProcess": True, "oldHash": policy["policyHash"], "targetPolicy": target}}
        local_base._RUNS[ref] = run
        self.refs.append(ref)
        observed = []
        def slow_cleanup(_ref):
            # Simulate the native ACK arriving while process termination is still pending.
            reply = access_transition.control(ref, target,
                {"id": "expired-change", "stage": "in-process-applied"})
            observed.append(reply)
            return True
        with patch.object(local_stream, "_kill_tree", side_effect=slow_cleanup):
            result = access_transition._restore_failed(ref, run, {"accessPolicy": policy})
        self.assertFalse(result["ok"])
        self.assertEqual(len(observed), 1)
        self.assertFalse(observed[0]["requested"], "An expired change must not authorize continuation")
        self.assertEqual(run["accessPolicy"], policy)
        self.assertEqual(run["state"], "interrupted")

    def test_hot_control_rejects_unmatched_transition_and_native_session(self):
        ref, run, policy = self.start()
        target = access_policy.normalize({**policy, "revision": 2, "mode": "full"})
        run["_accessTransition"] = {"id": "trusted-change", "phase": "cancelling",
            "oldHash": policy["policyHash"], "previousPolicy": policy, "targetPolicy": target,
            "allowInProcess": True}
        try:
            for update in ({"id": "stale", "sessionId": "native-kept"},
                           {"id": "trusted-change", "sessionId": "different-native"}):
                result = access_transition.control(ref, policy, {"stage": "in-process-ready", **update})
                self.assertFalse(result["requested"])
                self.assertEqual(run["accessPolicy"], policy)
            result = access_transition.control(ref, policy, {"stage": "in-process-applied", "id": "trusted-change"})
            self.assertFalse(result["requested"], "commit requires the new native ACK")
        finally:
            run.pop("_accessTransition", None)


if __name__ == "__main__":
    unittest.main()
