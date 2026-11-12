"""Offline image handoff regressions; no real Agent, model or application data."""
from __future__ import annotations

import base64
import asyncio
import itertools
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zlib


def fake_agent():
    from tests.opencode_peer_outcome import NativeOutcome
    native_outcome = NativeOutcome()
    for line in sys.stdin:
        message = json.loads(line)
        method = message.get("method")
        if method == "initialize":
            result = {"protocolVersion": 1, "agentCapabilities": {
                "loadSession": True, "promptCapabilities": {"image": os.environ.get("FIXTURE_IMAGES") != "no"}}}
        elif method in ("session/new", "session/load"):
            result = {"sessionId": "fixture-image-session"}
        elif method == "session/prompt":
            native_outcome.begin("fixture-image-session")
            content = message["params"]["prompt"]
            report = {"types": [row["type"] for row in content],
                      "pixels": [row["data"] for row in content if row["type"] == "image"],
                      "mimes": [row["mimeType"] for row in content if row["type"] == "image"],
                      "privateEnvRemoved": "SODUWORK_RUNNER_INPUT_IMAGES" not in os.environ}
            print(json.dumps({"jsonrpc": "2.0", "method": "session/update", "params": {
                "sessionId": "fixture-image-session", "update": {"sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": json.dumps(report)}}}}), flush=True)
            result = {"stopReason": "end_turn"}
            native_outcome.end("fixture-image-session")
        else:
            result = {}
        if "id" in message:
            print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result}), flush=True)
    return 0


if "--fake-agent" in sys.argv:
    raise SystemExit(fake_agent())

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
from app.services import runtime_images as images
from app.services import ai_local, local_base, local_ctx, local_stream, ai_exec

ROOT = Path(__file__).resolve().parent.parent


def png(color=b"\xff\x00\x00"):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(b"\0" + color)) + chunk(b"IEND", b"")


class ImageHandoffTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-runner-images-")
        self.root = Path(self.temp.name)
        self.patch = patch.object(local_base, "_STORE", str(self.root / "store"))
        self.patch.start()
        self.refs = []

    def tearDown(self):
        for ref in self.refs:
            local_base._RUNS.pop(ref, None)
        self.patch.stop()
        self.temp.cleanup()

    def stage(self, data=None, name="pixel.png", content_type="image/png", ref="fixture"):
        staged = ai_local._stage_inputs(ref, [(name, png() if data is None else data, content_type)])
        root = os.path.join(local_base._store_dir(ref), "inputs")
        return images.prepare({}, staged, root), root

    def test_first_and_followup_stage_preserve_original_bytes_and_metadata(self):
        first, root = self.stage()
        second, _ = self.stage(png(b"\x00\xff\x00"))
        self.assertNotEqual(first["images"], second["images"], "same-name follow-up cannot replace archived original")
        for cfg, pixels in ((first, png()), (second, png(b"\x00\xff\x00"))):
            content = images.prompt("describe", {"promptCapabilities": {"image": True}}, images.environment(cfg, root))
            self.assertEqual(content[1]["mimeType"], "image/png")
            self.assertEqual(base64.b64decode(content[1]["data"]), pixels)

    def test_prompt_paths_are_never_treated_as_image_uploads(self):
        content = images.prompt("Please inspect C:/private/secret.png", {"promptCapabilities": {"image": True}})
        self.assertEqual([row["type"] for row in content], ["text"])
        cfg, root = self.stage(b"regular text", "notes.txt", "text/plain")
        self.assertEqual(cfg[images.CFG_KEY], [])
        self.assertEqual(images.environment(cfg, root), "")

    def test_decoding_is_delegated_and_signature_corrects_mislabeled_images(self):
        # The transport no longer decodes or rejects images on a format allowlist.
        for data, name, mime in ((b"\x89PNG", "a.png", "image/png"),
                                 (png()[:-4], "b.png", "image/png"),
                                 (png(), "c.png", "image/jpeg"),
                                 (png() + b"extra metadata", "d.png", "image/png"),
                                 (png()[:-1] + b"\0", "e.png", "image/png")):
            with self.subTest(name=name):
                cfg, root = self.stage(data, name, mime)
                content = images.prompt("describe", {"promptCapabilities": {"image": True}}, images.environment(cfg, root))
                self.assertEqual(content[1]["mimeType"], "image/png")
                self.assertEqual(base64.b64decode(content[1]["data"]), data)

    def test_other_image_types_and_unknown_image_subtypes_are_forwarded(self):
        for name, declared, expected in (
            ("vector.svg", "image/svg+xml", "image/svg+xml"),
            ("scan.tiff", "application/octet-stream", "image/tiff"),
            ("bitmap.bmp", "", "image/bmp"),
            ("photo.avif", "", "image/avif"),
            ("photo.heic", "", "image/heic"),
            ("photo.heif", "", "image/heif"),
            ("photo.jxl", "", "image/jxl"),
            ("photo.nef", "", "image/x-nikon-nef"),
            ("photo.psd", "", "image/vnd.adobe.photoshop"),
            ("no-extension", " IMAGE/X-FUTURE; version=2 ", "image/x-future"),
        ):
            with self.subTest(name=name):
                data = b'<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' if name.endswith('.svg') else b"format-specific bytes owned by the selected decoder"
                cfg, root = self.stage(data, name, declared)
                content = images.prompt("describe", {"promptCapabilities": {"image": True}}, images.environment(cfg, root))
                self.assertEqual(content[1]["mimeType"], expected)
                self.assertEqual(base64.b64decode(content[1]["data"]), data)
                self.assertEqual(Path(cfg["images"][0]).read_bytes(), data)

    def test_empty_and_encrypted_attachments_have_specific_errors(self):
        encrypted = b"\xe0\xa8\x91\xe7" + bytes(84) + b"Esafenet" + bytes(4000)
        for data, error in ((b"", "图片附件为空"), (encrypted, "图片附件受加密保护")):
            with self.subTest(error=error), self.assertRaisesRegex(images.ImageInputError, error):
                self.stage(data)

    def test_oversize_and_changed_image_fail_without_truncation(self):
        with patch.object(images, "MAX_IMAGE_BYTES", 32), self.assertRaises(images.ImageInputError):
            self.stage()
        cfg, root = self.stage()
        raw = images.environment(cfg, root)
        Path(cfg["images"][0]).write_bytes(png(b"\x00\xff\x00"))
        with self.assertRaises(images.ImageInputError):
            images.prompt("describe", {"promptCapabilities": {"image": True}}, raw)

    def test_outside_path_and_symbolic_link_rejected(self):
        cfg, root = self.stage()
        outside = self.root / "outside.png"
        outside.write_bytes(png())
        cfg[images.CFG_KEY][0]["path"] = str(outside)
        with self.assertRaises(images.ImageInputError):
            images.environment(cfg, root)
        # Symlink detection is mandatory on platforms lacking link privileges too.
        inside, root = self.stage()
        with patch.object(images.os.path, "islink", return_value=True), self.assertRaises(images.ImageInputError):
            images.environment(inside, root)

    def test_explicit_model_routes_and_unknown_models(self):
        self.assertFalse(images.transport_supported({}))
        self.assertTrue(images.transport_supported({"input": ["text", "image"]}))
        self.assertTrue(images.transport_supported({"imageRouting": "native"}))
        self.assertFalse(images.transport_supported({"base": "https://vendor.invalid/v1", "input": ["text", "image"], "imageRouting": "vision-fallback"}))
        fallback = {"base": "http://127.0.0.1/api/v1/ai-proxy/v1", "input": ["text"], "imageRouting": "vision-fallback"}
        self.assertFalse(images.transport_supported(fallback))
        self.assertFalse(images.transport_supported({**fallback, "visionFallbackAvailable": False}))
        self.assertTrue(images.transport_supported({**fallback, "visionFallbackAvailable": True}))

    def test_three_acp_agents_receive_real_image_blocks_on_new_and_loaded_sessions(self):
        formats = [("pixel.png", png(), "image/png"),
                   ("vector.svg", b'<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>', "image/svg+xml")]
        for agent, resume, (name, pixels, mime) in itertools.product(
                ("opencode", "codex-harness", "qwen"), (False, True), formats):
            with self.subTest(agent=agent, resume=resume, mime=mime):
                cfg, root = self.stage(pixels, name, mime)
                env = {**os.environ, images.ENV_KEY: images.environment(cfg, root), "PYTHONUTF8": "1"}
                args = [sys.executable, "-B", str(ROOT / "app/services/acp_bridge.py"), "--cwd", str(self.root),
                        "--agent-name", agent, "--permission", "readonly"]
                if resume:
                    args += ["--session", "fixture-image-session"]
                args += ["--", sys.executable, "-B", str(Path(__file__).resolve()), "--fake-agent"]
                result = subprocess.run(args, input="describe uploaded image", text=True, encoding="utf-8", capture_output=True, env=env, timeout=15)
                self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
                events = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
                content = json.loads(next(row["part"]["text"] for row in events if row.get("type") == "text"))
                self.assertEqual(content["types"], ["text", "image"])
                self.assertEqual(base64.b64decode(content["pixels"][0]), pixels)
                self.assertEqual(content["mimes"], [mime])
                self.assertTrue(content["privateEnvRemoved"])

    def test_agent_without_image_capability_fails_before_prompt(self):
        cfg, root = self.stage()
        raw = images.environment(cfg, root)
        for capabilities in ({}, {"promptCapabilities": {"image": False}}):
            with self.assertRaisesRegex(images.ImageInputError, "图片未发送"):
                images.prompt("describe", capabilities, raw)
        env = {**os.environ, images.ENV_KEY: raw, "FIXTURE_IMAGES": "no", "PYTHONUTF8": "1"}
        args = [sys.executable, "-B", str(ROOT / "app/services/acp_bridge.py"), "--cwd", str(self.root),
                "--agent-name", "qwen", "--permission", "readonly", "--",
                sys.executable, "-B", str(Path(__file__).resolve()), "--fake-agent"]
        result = subprocess.run(args, input="describe", text=True, encoding="utf-8", capture_output=True, env=env, timeout=15)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("图片未发送", result.stdout + result.stderr)
        self.assertNotIn('"types"', result.stdout)

    def test_dispatch_and_resume_hook_forward_only_current_turn_images(self):
        profile = {**local_base._PROFILES["qwen"], "bin": lambda: sys.executable}
        with patch.dict(local_base._PROFILES, {"qwen": profile}), patch.object(ai_local, "_spawn") as spawn:
            reply = ai_local.dispatch_sync({"local_cli": "qwen"}, SimpleNamespace(id="fixture", title="input", note=""),
                [("original.png", png(), "image/png")], {"id": "local:qwen"},
                {"workDir": str(self.root), "deliveryMode": "files", "requiredAgentCapabilities": ["files"]}, capability_grants=["files"])
            self.assertTrue(reply["ok"], reply)
            ref = reply["issueId"]; self.refs.append(ref)
            cfg = spawn.call_args.args[5]
            self.assertEqual(len(cfg[images.CFG_KEY]), 1)
            run = local_base._RUNS[ref]
            run.update(cliSid="fixture-session", state="completed", ctxWindowKnown=False)
            second, _ = self.stage(png(b"\x00\xff\x00"), ref=ref)
            with patch.object(local_stream, "_spawn") as resume:
                self.assertTrue(local_ctx.prepare_resume(ref, "follow-up", second)["ok"])
                self.assertEqual(resume.call_args.args[5][images.CFG_KEY], second[images.CFG_KEY])
                self.assertTrue(local_ctx.prepare_resume(ref, "text-only", None)["ok"])
                self.assertEqual(resume.call_args.args[5][images.CFG_KEY], [])
                self.assertEqual(resume.call_args.args[5]["images"], [])

    def test_real_runner_comment_stages_pixels_and_rejects_injected_paths(self):
        from runner_main import Runner
        runner = Runner.__new__(Runner)
        source = self.root / "upload.png"
        source.write_bytes(png())
        request = {"op": "job.comment", "ref": "fixture-comment", "text": "describe",
                   "_localParent": True, "_admitted": True,
                   "cfg": {"llm": {"input": ["text", "image"], "imageRouting": "native"}},
                   "localFiles": [{"path": str(source), "filename": "upload.png", "contentType": "image/png"}]}
        with patch.object(local_stream, "comment_sync", return_value={"ok": True}) as comment:
            self.assertTrue(asyncio.run(runner._job(request))["ok"])
            cfg = comment.call_args.args[0]
            self.assertEqual(Path(cfg["images"][0]).read_bytes(), png())
            self.assertNotEqual(cfg["images"][0], str(source), "the attachment is staged before image handoff")
            # The cfg object itself cannot authorize a new local file path.
            request.update(localFiles=[], cfg={"_inputImages": [{"path": str(source)}], "images": [str(source)]})
            self.assertTrue(asyncio.run(runner._job(request))["ok"])
            self.assertEqual(comment.call_args.args[0][images.CFG_KEY], [])
            self.assertEqual(comment.call_args.args[0]["images"], [])

    def test_model_metadata_and_codex_image_argument_contract(self):
        llm = {"base": "https://model.invalid/v1", "key": "fixture", "model": "fixture", "input": ["text", "image"], "imageRouting": "native", "visionFallbackAvailable": True}
        cfg = ai_exec.with_llm({"cfg": {}}, llm)["cfg"]
        self.assertEqual(cfg["llm"]["input"], llm["input"])
        self.assertEqual(cfg["llm"]["imageRouting"], "native")
        # model_catalog.resolve returns imageRouting but no input list.
        resolved = ai_exec.with_llm({"cfg": {}}, {k: v for k, v in llm.items() if k != "input"})["cfg"]
        self.assertTrue(images.transport_supported(resolved["llm"]))
        replaced = ai_exec.with_llm({"cfg": cfg}, {k: llm[k] for k in ("base", "key", "model")})["cfg"]
        self.assertNotIn("input", replaced["llm"])
        self.assertNotIn("visionFallbackAvailable", replaced["llm"])
        staged, _ = self.stage()
        args = local_base._codex_args("fixture", "work", str(self.root), staged)
        self.assertEqual([arg for arg in args if arg.startswith("--image=")], ["--image=" + staged["images"][0]])
        legacy = local_base._command_argv("opencode", ["run", "--format", "json"], str(self.root), staged, local_base._PROFILES["opencode"])
        self.assertEqual([arg for arg in legacy if arg.startswith("--file=")], ["--file=" + staged["images"][0]])
        for route, base, expected in (("native", "https://vendor.invalid/v1", ["text", "image"]),
                                      ("vision-fallback", "https://hub.invalid/api/v1/ai-proxy/v1", ["text", "image"]),
                                      ("vision-fallback", "https://vendor.invalid/v1", ["text"])):
            env = local_base._env_for(local_base._PROFILES["opencode"], {"llm": {**llm, "base": base, "imageRouting": route}})
            model = json.loads(env["OPENCODE_CONFIG_CONTENT"])["provider"]["company"]["models"]["fixture"]
            self.assertEqual(model["modalities"]["input"], expected)

    def test_empty_dispatch_and_preflight_errors_are_visible_without_child_processes(self):
        from app.services import local_process
        profile = {**local_base._PROFILES["qwen"], "bin": lambda: sys.executable}
        before = set(local_base._RUNS)
        with patch.dict(local_base._PROFILES, {"qwen": profile}), patch.object(ai_local, "_spawn") as spawn:
            reply = ai_local.dispatch_sync({"local_cli": "qwen"}, SimpleNamespace(id="fixture", title="input", note=""),
                [("empty.png", b"", "image/png")], {"id": "local:qwen"},
                {"workDir": str(self.root), "deliveryMode": "files", "requiredAgentCapabilities": ["files"]}, capability_grants=["files"])
            self.assertFalse(reply["ok"])
            self.assertIn("图片附件为空", reply["error"])
            spawn.assert_not_called()
            self.assertEqual(set(local_base._RUNS), before)

        for resumed, changed in ((False, False), (True, False), (True, True)):
            with self.subTest(resumed=resumed, changed=changed):
                ref = "preflight-%s-%s" % (resumed, changed)
                self.refs.append(ref)
                cfg, _ = self.stage(ref=ref)
                cfg["llm"] = {"base": "https://vendor.invalid/v1", "key": "fixture", "model": "fixture"}
                if changed:
                    cfg["llm"]["imageRouting"] = "native"
                    Path(cfg["images"][0]).write_bytes(png(b"\x00\xff\x00"))
                run = {"ref": ref, "state": "running", "cli": "qwen", "cfg": cfg,
                       "ws": str(self.root), "round": 2 if resumed else 1,
                       "cliSid": "fixture-session" if resumed else "", "gitDelivery": {"_checked": True}}
                local_base._RUNS[ref] = run
                finished = threading.Event()
                errors = []

                def finish(*args):
                    try:
                        local_stream._finish(*args)
                    except Exception as exc:
                        errors.append(exc)
                    finally:
                        finished.set()

                with patch.object(local_process.subprocess, "Popen") as popen, patch.object(local_stream, "_resume") as resume:
                    local_process.spawn("unused-agent", [], "describe", str(self.root), ref, cfg, profile,
                        gate_check=lambda *_: "", on_line=lambda *_: None, finish=finish, kill_tree=lambda *_: None)
                    self.assertTrue(finished.wait(3), "preflight must reach a bounded terminal result")
                    self.assertEqual(errors, [])
                    popen.assert_not_called()
                    resume.assert_not_called()
                self.assertEqual(run["state"], "failed")
                self.assertIsNone(run["proc"])
                expected = "图片附件已变化" if changed else "当前所选模型未启用图片输入"
                self.assertIn(expected, run["error"])
                persisted = json.loads(Path(local_base._store_dir(ref), "meta.json").read_text(encoding="utf-8"))
                self.assertEqual(persisted["state"], "failed")
                self.assertEqual(persisted["error"], run["error"])


if __name__ == "__main__":
    unittest.main()
