"""Native terminal evidence must survive zero exits and the ACP translation."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from app.services import local_base, local_stream, local_turn_outcome, opencode_turn_outcome as outcome


class OpenCodeTurnOutcomeTests(unittest.TestCase):
    def setUp(self):
        self.observer = outcome.Observer()
        self.addCleanup(self.observer.close)

    def marker(self, kind, **fields):
        return outcome.PREFIX + json.dumps({"token": self.observer.token, "kind": kind, "invocation": self.observer.invocation, **fields})

    def begin(self, user="user-current"):
        self.observer.consume(self.marker("ready"))
        self.observer.begin("session-current")
        self.observer.consume(self.marker("begin", sid="session-current", user=user))

    def test_zero_exit_with_partial_text_is_failed_without_replaying_tools(self):
        with tempfile.TemporaryDirectory(prefix="soduwork-opencode-settle-") as folder:
            for reason in ("length", "max_tokens", "stop"):
                ref = "opencode-fixture-" + reason
                run = {"state": "running", "cli": "opencode", "ws": folder,
                       "seq": 0, "lines": [], "cfg": {}, "artifactMode": "files",
                       "expectedOutputPaths": ["fixture.txt"], "conversationMode": "adaptive", "turnStartSeq": 0}
                local_base._RUNS[ref] = run
                try:
                    terminal = {}
                    with patch.object(local_base, "_STORE", folder):
                        for event in ({"type": "text", "part": {"text": "A partial response"}},
                                      {"type": "step_finish", "part": {"reason": reason}}):
                            local_stream._on_line(ref, json.dumps(event), terminal)
                        with patch.object(local_stream, "_resume") as resume:
                            local_stream._finish(ref, 0, terminal, "")
                    self.assertEqual(run["state"], "done" if reason == "stop" else "failed")
                    if reason != "stop":
                        self.assertEqual(run["failureKind"], "execution_incomplete")
                        self.assertEqual(run["error"], local_turn_outcome.TRUNCATED)
                    resume.assert_not_called()
                finally:
                    local_base._RUNS.pop(ref, None)

    def test_context_measurements_other_agents_and_tool_steps_do_not_clear_truncation(self):
        terminal = {"outputTruncated": True}
        for cli, event in (("opencode", {"type": "step_finish", "contextOnly": True, "part": {"reason": "stop"}}),
                           ("opencode", {"type": "step_finish", "part": "malformed"}),
                           ("codex", {"type": "step_finish", "part": {"reason": "stop"}}),
                           ("opencode", {"type": "step_finish", "part": {"reason": "tool-calls"}})):
            local_turn_outcome.observe(cli, event, terminal)
            self.assertTrue(terminal["outputTruncated"])
        local_turn_outcome.observe("opencode", {"type": "step_finish", "part": {"reason": "stop"}}, terminal)
        self.assertNotIn("outputTruncated", terminal)

    def test_environment_keeps_guard_and_never_writes_channel_secret(self):
        env = self.observer.environment({"OPENCODE_CONFIG_CONTENT": json.dumps({
            "model": "company/fixture", "plugin": ["file:///fixture/guard.mjs"], "permission": {"edit": "deny"}}),
            "OPENCODE_PURE": "1", "SODUWORK_LLM_KEY": "fixture-private"})
        config = json.loads(env["OPENCODE_CONFIG_CONTENT"])
        self.assertEqual(config["permission"], {"edit": "deny"})
        self.assertEqual(config["plugin"][0], "file:///fixture/guard.mjs")
        self.assertNotIn("OPENCODE_PURE", env)
        self.assertEqual(env[outcome.ENV], self.observer.token)
        source = self.observer.path.read_text()
        self.assertNotIn(self.observer.token, source)
        self.assertNotIn("fixture-private", source)

    def test_owned_current_turn_only_and_internal_markers_are_never_diagnostics(self):
        self.begin()
        for marker in (outcome.PREFIX + "broken", outcome.PREFIX + json.dumps({"token": "wrong", "kind": "end"}),
                       self.marker("end", sid="other", user="user-current", reason="stop"),
                       self.marker("end", sid="session-current", user="old", reason="stop")):
            self.assertTrue(self.observer.consume(marker))
            self.assertIsNone(self.observer.reason)
        self.assertFalse(self.observer.consume("ordinary native diagnostic"))
        self.observer.consume(self.marker("end", sid="session-current", user="user-current", reason="length"))
        self.assertEqual(self.observer.finish(), "length")
        self.begin("user-next")
        self.observer.consume(self.marker("begin", sid="session-current", user="user-current", invocation=1))
        self.observer.consume(self.marker("end", sid="session-current", user="user-current", reason="stop", invocation=1))
        self.assertIsNone(self.observer.reason)
        self.observer.consume(self.marker("end", sid="session-current", user="user-next", reason="stop"))
        self.assertEqual(self.observer.finish(), "stop")

    def test_missing_plugin_missing_terminal_and_incomplete_tool_turn_fail_closed(self):
        with patch.object(self.observer.condition, "wait_for", return_value=False):
            with self.assertRaises(outcome.OutcomeError):
                self.observer.begin("fixture")
            with self.assertRaises(outcome.OutcomeError):
                self.observer.finish()
        for reason in ("", "tool-calls", "unknown"):
            self.begin("user-" + reason)
            self.observer.consume(self.marker("end", sid="session-current", user="user-" + reason, reason=reason))
            with self.assertRaises(outcome.OutcomeError):
                self.observer.finish()

    def test_cancelled_prompt_late_stderr_cannot_settle_next_prompt(self):
        self.observer.consume(self.marker("ready"))
        self.observer.begin("session-current")
        # The cancelled response overtakes its stderr. The next prompt starts
        # before either native marker from the cancelled prompt is consumed.
        self.observer.begin("session-current")
        self.observer.consume(self.marker("begin", sid="session-current", user="cancelled", invocation=1))
        self.observer.consume(self.marker("end", sid="session-current", user="cancelled", reason="stop", invocation=1))
        with patch.object(self.observer.condition, "wait_for", return_value=False):
            with self.assertRaises(outcome.OutcomeError):
                self.observer.finish()
        self.observer.consume(self.marker("begin", sid="session-current", user="current"))
        self.observer.consume(self.marker("end", sid="session-current", user="current", reason="length"))
        self.assertEqual(self.observer.finish(), "length")

    def test_conflicting_user_with_same_prompt_ordinal_cannot_recover_to_success(self):
        self.begin()
        self.observer.consume(self.marker("begin", sid="session-current", user="conflicting"))
        self.observer.consume(self.marker("end", sid="session-current", user="user-current", reason="stop"))
        with self.assertRaises(outcome.OutcomeError):
            self.observer.finish()

    def test_native_plugin_scopes_root_turn_and_keeps_latest_assistant_finish(self):
        program = """const {default: create} = await import(process.argv[1]);
const hooks = await create();
const event = (type, properties) => hooks.event({event:{type, properties}});
const id = n => 'msg_' + n.toString(16).padStart(12,'0') + 'A'.repeat(14);
const message = (sid, user, number, finish, summary=false) => event('message.updated',
  {info:{id:id(number), sessionID:sid, parentID:id(user), role:'assistant', finish, summary, time:{created:1}}});
const begin = () => hooks['chat.message']({sessionID:'root'}, {message:{id:id(1)}});
const end = () => event('session.status',{sessionID:'root',status:{type:'idle'}});
const user = number => event('message.updated',{info:{id:id(number),sessionID:'root',role:'user'}});
await begin();
await message('child',1,99,'length');
await message('root',9,99,'length');
await message('root',1,99,'length',true);
await message('root',1,2,'tool-calls');
await message('root',1,3,'length');
await message('root',1,4,'stop');
await message('root',1,3,'length');
await end();
for (const [first,last] of [['stop','length'],['length','stop']]) {
  await begin();
  await message('root',1,2,first);
  await message('root',1,3,last);
  await message('root',1,2,first);
  await end();
}
for (const last of ['stop','length']) {
  await begin();
  await message('root',1,2,'tool-calls');
  await user(3);
  await message('root',3,4,'stop',true);
  await user(5);
  await message('root',5,6,last);
  await message('root',1,2,'stop');
  await message('root',9,99,'stop');
  await end();
}
await begin();
await message('root',1,2,'length');
await event('message.updated',{info:{id:id(2).replace(/A$/,'B'),sessionID:'root',parentID:id(1),role:'assistant',finish:'stop'}});
await end();
if (process.env.SODUWORK_OPENCODE_OUTCOME) throw Error('channel leaked to tools');
"""
        done = subprocess.run(["node", "--input-type=module", "-e", program, self.observer.path.as_uri()],
                              env={**os.environ, outcome.ENV: self.observer.token}, capture_output=True, text=True, timeout=10)
        self.assertEqual(done.returncode, 0, done.stderr)
        rows = [json.loads(line[len(outcome.PREFIX):]) for line in done.stderr.splitlines()]
        self.assertEqual([row["kind"] for row in rows], ["ready", *(["begin", "end"] * 6)])
        self.assertEqual([row["reason"] for row in rows if row["kind"] == "end"], ["stop", "length", "stop", "stop", "length", ""])
        self.assertNotIn("child", done.stderr)

    def test_observer_is_in_runner_source_closure(self):
        from app.services import runner_sources
        backend = Path(__file__).resolve().parent
        self.assertIn(Path(outcome.__file__), runner_sources.build_inputs(backend, backend.parent))


if __name__ == "__main__":
    unittest.main()
