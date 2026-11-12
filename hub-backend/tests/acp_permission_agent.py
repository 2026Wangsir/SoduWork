"""Offline native-peer fixture; envelopes transcribed from installed ACP sources.

No model, vendor service or business store. The real SoduWork subprocess bridge and
HTTP broker decide whether this peer may perform each harmless temporary write.
"""
import json
import os
from pathlib import Path
import re
import sys
from opencode_peer_outcome import NativeOutcome


def send(value):
    print(json.dumps(value), flush=True)


def peer(agent, mode):
    native_outcome = NativeOutcome()
    assert "SODUWORK_APPROVAL_CHANNEL" not in os.environ
    work = Path.cwd()
    options = [{"optionId": "always", "kind": "allow_always"},
               {"optionId": "once", "kind": "allow_once"},
               {"optionId": "deny", "kind": "reject_once"}]
    counter = 0

    def ask(kind, args, name, *, metadata=None, call_id=None):
        nonlocal counter
        counter += 1
        call_id = call_id or "operation-%s" % counter
        title = args.get("description") or args.get("command") or name
        live = {"sessionUpdate": "tool_call", "toolCallId": call_id,
                "kind": kind, "status": "pending", "title": title, "rawInput": args}
        send({"method": "session/update", "params": {"update": live}})
        call = {"toolCallId": call_id, "kind": kind, "title": title, "rawInput": args,
                "_meta": {"toolName": name}}
        if agent == "opencode":
            call = {"toolCallId": call_id, "kind": kind, "title": "native " + name,
                    "rawInput": metadata if metadata is not None else args, "locations": []}
        elif agent == "dsh":
            call = {"toolCallId": call_id}
        send({"jsonrpc": "2.0", "id": "permission-%s" % counter,
              "method": "session/request_permission", "params": {"toolCall": call, "options": options}})
        reply = json.loads(sys.stdin.readline())
        assert reply["id"] == "permission-%s" % counter, reply
        selected = reply["result"]["outcome"].get("optionId")
        assert selected in {"once", "deny"}, reply  # Never native blanket always.
        send({"method": "session/update", "params": {"update": {
            "sessionUpdate": "tool_call_update", "toolCallId": call_id,
            "status": "completed" if selected == "once" else "failed"}}})
        return selected == "once"

    for line in sys.stdin:
        request = json.loads(line)
        method, params = request.get("method"), request.get("params") or {}
        result = {}
        if method == "initialize":
            result = {"protocolVersion": 1, "agentCapabilities": {"loadSession": True}}
        elif method == "session/new":
            result = {"sessionId": "isolated-native-peer"}
            if agent == "opencode":
                from urllib.parse import urlsplit, unquote
                config = json.loads(os.environ["OPENCODE_CONFIG_CONTENT"])
                markers = []
                for plugin in config["plugin"]:
                    value = unquote(urlsplit(plugin).path)
                    if os.name == "nt":
                        value = value.lstrip("/")
                    source = Path(value).read_text(encoding="utf-8")
                    if match := re.search(r"const agentId = (.*);", source):
                        markers.append(json.loads(match[1]))
                assert len(markers) == 1, "Exactly one native permission guard is required"
                marker = markers[0]
                result["configOptions"] = [{"id": "mode", "options": [
                    {"value": marker}, {"value": "plan"}, {"value": "build"}]}]
            else:
                ids = ("default", "plan", "yolo") if agent == "qwen" else ("workspace-write", "read-only", "danger-full-access")
                result["modes"] = {"currentModeId": ids[2], "availableModes": [{"id": x} for x in ids]}
        elif method in {"session/set_mode", "session/set_config_option"}:
            expected = {"qwen": {"standard": "default", "readonly": "plan"},
                        "dsh": {"standard": "workspace-write", "readonly": "read-only"},
                        "opencode": {"standard": "build", "readonly": "build"}}[agent][mode]
            assert params.get("modeId", params.get("value")) == expected
        elif method == "session/prompt":
            native_outcome.begin("isolated-native-peer")
            path_key = "file_path" if agent == "qwen" else "filePath" if agent == "opencode" else "path"
            read = {path_key: str(work / "source.txt"), "limit": 20}
            if agent == "qwen":
                read["pages"] = None
            assert ask("read", read, "read_file", metadata={})
            assert (work / "source.txt").read_text() == "source"
            resource = work.parent / "resources" / "guide.md"
            if agent == "opencode":
                assert ask("other", {"filepath": str(resource), "parentDir": str(resource.parent)},
                           "external_directory", call_id="resource-read")
            assert ask("read", {path_key: str(resource), "limit": 20}, "read_file",
                       metadata={}, call_id="resource-read")
            assert resource.read_text() == "selected resource"
            write = {path_key: str(work / "document.txt"), "content": "workspace output"}
            if agent == "qwen":
                write["record_as_artifact"] = False
            approved = ask("edit", write, "write_file", metadata={
                "filepath": str(work / "document.txt"), "diff": "@@ -0,0 +1 @@\n+workspace output"})
            assert approved == (mode == "standard")
            if approved:
                (work / "document.txt").write_text(write["content"])
            for index in range(2):
                args = {"command": "isolated-marker", "timeout": 5000}
                if agent == "qwen":
                    args.update(directory=str(work), description="explanation %s" % index)
                elif agent == "opencode":
                    args.update(workdir=str(work), description="explanation %s" % index)
                approved = ask("execute", args, "run_shell_command", metadata={"command": args["command"]})
                assert approved == (mode == "standard")
                if approved:
                    (work / ("approved-%s.txt" % index)).write_text("authorized")
            args = {"command": "changed-command", "timeout": 5000}
            assert not ask("execute", args, "run_shell_command", metadata=args)
            assert not (work / "denied.txt").exists()
            result = {"stopReason": "end_turn"}
            native_outcome.end("isolated-native-peer")
        else:
            raise AssertionError(method)
        send({"jsonrpc": "2.0", "id": request["id"], "result": result})


if __name__ == "__main__":
    peer(sys.argv[1], sys.argv[2])
