"""Synthetic vendor-side completion channel for ACP transport fixtures only."""
import json
import os
import sys
import uuid


class NativeOutcome:
    def __init__(self):
        self.token = os.environ.pop("SODUWORK_OPENCODE_OUTCOME", "")
        self.user = ""
        self.invocations = {}
        self.invocation = 0
        self.emit("ready")

    def emit(self, kind, **fields):
        if self.token:
            print("SODUWORK_OPENCODE_OUTCOME:" + json.dumps({"token": self.token, "kind": kind,
                  "invocation": self.invocation, **fields}),
                  file=sys.stderr, flush=True)

    def begin(self, sid):
        self.invocation = self.invocations.get(sid, 0) + 1
        self.invocations[sid] = self.invocation
        self.user = "fixture-" + uuid.uuid4().hex
        self.emit("begin", sid=sid, user=self.user)

    def end(self, sid, reason="stop"):
        self.emit("end", sid=sid, user=self.user, reason=reason)
