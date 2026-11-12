"""Real clean-directory startup, HTTP, persistence and shutdown verification.

No business database or paid model is used. The retained temporary directory
contains only generated test data; passwords/tokens stay in this process memory.
"""
from __future__ import annotations

from contextlib import closing
import io
import json
import os
from pathlib import Path
import re
import secrets
import signal
import socket
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, Request, build_opener

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from tools.dev.local_environment import stop_child  # noqa: E402
from tools.dev.start_local import desktop_profile  # noqa: E402


HTTP = build_opener(ProxyHandler({}))


def request(base, path, data=None, *, method=None, token="", headers=None, raw=False):
    headers = dict(headers or {})
    if token:
        headers["Authorization"] = "Bearer " + token
    if data is not None and not isinstance(data, bytes):
        headers["Content-Type"] = "application/json"
        data = json.dumps(data).encode("utf-8")
    req = Request(base + path, data=data, headers=headers, method=method)
    with HTTP.open(req, timeout=8) as response:
        body = response.read()
        return body if raw else json.loads(body)


def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def start(state, port, password=None, *, desktop=False):
    log = (state.parent / (state.name + ".launcher-" + secrets.token_hex(4) + ".log")).open("wb")
    # Launch the base interpreter, not an existing venv or Windows venv redirector.
    launcher = ROOT / 'tools/dev/verify_desktop_fixture.py' if desktop and sys.platform == 'darwin' else ROOT / 'start.py'
    command = [getattr(sys, "_base_executable", sys.executable), str(launcher), "--data-dir", str(state),
               "--port", str(port), "--no-browser"]
    if password:
        command += ["--password-stdin"]
    if desktop:
        command += ['--desktop']
    # Deliberate poison values prove neither this environment nor the checkout's
    # .env can redirect the child service to a real database/model/storage.
    env = dict(os.environ, DATABASE_URL="postgresql://must-never-connect.invalid/soduwork",
               OPENAI_API_KEY="fixture-must-not-inherit", MINIO_ENDPOINT="must-never-connect.invalid")
    options = ({"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt"
               else {"start_new_session": True})
    child = subprocess.Popen(command, cwd=ROOT, env=env, stdin=subprocess.PIPE,
                             stdout=log, stderr=subprocess.STDOUT, **options)
    child.launcher_log = log.name
    if password:
        child.stdin.write((password + "\n").encode("utf-8"))
    child.stdin.close()
    return child, log


def wait_ready(child, base, state, timeout=600):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if child.poll() is not None:
            raise AssertionError(f"Launcher exited {child.returncode}; see {child.launcher_log}")
        try:
            if request(base, "/readyz").get("ready"):
                return
        except (OSError, URLError, ValueError):
            pass
        time.sleep(.5)
    raise AssertionError(f"Startup timed out; see {state / 'startup.log'}")


def stop(child, base):
    if child.poll() is None:
        child.send_signal(signal.CTRL_BREAK_EVENT if os.name == "nt" else signal.SIGINT)
        try:
            assert child.wait(timeout=20) == 0, "Ctrl+C did not exit cleanly"
        except subprocess.TimeoutExpired:
            stop_child(child)
            raise AssertionError("Launcher left processes running after Ctrl+C")
    for _ in range(100):
        try:
            request(base, "/healthz")
        except (OSError, URLError):
            return
        time.sleep(.1)
    raise AssertionError("Hub is still serving after the launcher exited")


def desktop_ready(child, state, previous_pid=None):
    journal = desktop_profile(state) / 'diagnostics/lifecycle.jsonl'
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        if child.poll() is not None:
            raise AssertionError(f'Desktop session stopped; see {child.launcher_log} and {state / "desktop.log"}')
        if journal.is_file():
            entries = [json.loads(line) for line in journal.read_text(encoding='utf-8').splitlines() if line]
            # Read only events after the previous launch, including when older PIDs are reused.
            previous = [index for index, row in enumerate(entries)
                        if row['event'] == 'ready' and row.get('pid') == previous_pid]
            current = entries[previous[-1] + 1:] if previous else entries
            ready = [row for row in current if row['event'] == 'ready'
                     and row.get('pid') != previous_pid and process_alive(row['pid'])]
            if ready:
                latest = ready[-1]
                assert not any(row['event'] in ('uncaught-exception-monitor', 'unhandled-rejection')
                               for row in entries if row.get('runId') == latest['runId']), 'Desktop initialization failed'
                return latest['pid']
        time.sleep(.25)
    raise AssertionError(f'Electron did not become ready; see {state / "desktop.log"}')


def process_alive(pid):
    if os.name != 'nt':
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.OpenProcess(0x1000, False, pid)
    if not handle:
        return False
    try:
        code = wintypes.DWORD()
        return bool(kernel.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == 259
    finally:
        kernel.CloseHandle(handle)


def desktop_stopped(pid):
    for _ in range(80):
        if not process_alive(pid):
            return
        time.sleep(.1)
    raise AssertionError('Electron was left running after the source launcher stopped')


def verify(*, desktop=False):
    state = Path(tempfile.mkdtemp(prefix="soduwork-source-live-"))
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    password = secrets.token_urlsafe(24)
    checks = []
    child = output = None
    print(f"Isolated verification directory: {state}\nURL: {base}", flush=True)
    if desktop and sys.platform == 'darwin':
        print('Desktop fixture uses a mock native Keychain; real Keychain access is not verified.', flush=True)
    try:
        # The launcher must survive incomplete first setup without a default account.
        failed, failed_log = start(state, port, "short")
        assert failed.wait(timeout=30) == 1
        failed_log.close()
        assert not (state / "soduwork.db").exists()
        checks.append("failed-first-password-resumes")

        child, output = start(state, port, password, desktop=desktop)
        begin = time.monotonic()
        wait_ready(child, base, state)
        checks.append("clean-venv-npm-build-migrations-ready")
        desktop_pid = desktop_ready(child, state) if desktop else None
        if desktop:
            checks.append('native-electron-ready-with-isolated-local-hub-profile')
            endpoint = json.loads((desktop_profile(state) / 'hub-endpoint.json').read_text())
            assert endpoint['hub'] == base
        print(f"Clean startup: {time.monotonic() - begin:.1f}s", flush=True)
        page = request(base, "/", raw=True)
        assert b"<html" in page.lower()
        assets = re.findall(rb'(?:src|href)="(/assets/[^"<>]+)"', page)
        assert assets, "Management UI has no built assets"
        for path in assets:
            assert request(base, path.decode(), raw=True), "Empty production asset"
        checks.append("built-management-ui-and-assets")
        bundle = request(base, "/api/v1/download/runner?os=src", raw=True)
        with tarfile.open(fileobj=io.BytesIO(bundle), mode="r:gz") as archive:
            required = {"hub-backend/runner_main.py", "hub-backend/requirements-runner.txt",
                        "hub-backend/app/agent_catalog.json"}
            assert required <= set(archive.getnames()), "Runner source download is incomplete"
        checks.append("source-runner-download-has-dependencies-and-agent-catalog")

        try:
            request(base, "/api/v1/admin/me")
            raise AssertionError("Management data unexpectedly accessible without login")
        except HTTPError as exc:
            assert exc.code == 401
        login = request(base, "/api/v1/admin/login", {"user": "admin", "pass": password})
        token = login["token"]
        assert request(base, "/api/v1/admin/me", token=token)["id"] == login["user"]["id"]
        checks.append("actual-password-login-and-auth-rejection")
        org = request(base, "/api/v1/admin/orgs", {"name": "Startup verification team"}, token=token)
        updated = request(base, "/api/v1/admin/orgs/" + org["id"], {"name": "Persistent verification team"}, method="PATCH", token=token)
        assert updated["name"] == "Persistent verification team"
        task = request(base, "/api/v1/admin/inbox", {"title": "Source startup verification task", "orgId": org["id"]}, token=token)["task"]
        assert request(base, "/api/v1/admin/tasks/" + task["id"], token=token)["title"] == task["title"]
        checks.append("organization-and-task-http-create-read-update")
        boundary = "soduwork" + secrets.token_hex(12)
        content = b"SoduWork source launch persistent attachment\n"
        form = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"verification.txt\"\r\n"
                "Content-Type: text/plain\r\n\r\n").encode() + content + f"\r\n--{boundary}--\r\n".encode()
        attachment_path = "/api/v1/admin/tasks/" + task["id"] + "/attachments"
        attachment = request(base, attachment_path, form, token=token,
                             headers={"Content-Type": "multipart/form-data; boundary=" + boundary})
        uploaded = request(base, attachment_path, token=token)
        saved = next(row for row in uploaded if row["id"] == attachment["id"])
        assert request(base, saved["url"], raw=True) == content
        checks.append("real-attachment-upload-download")

        # A second launcher must refuse before preparing files or starting another Hub.
        duplicate, duplicate_log = start(state, port)
        assert duplicate.wait(timeout=30) == 1
        duplicate_log.close()
        assert request(base, "/readyz")["ready"]
        checks.append("duplicate-launch-does-not-disrupt-service")
        secret_before = json.loads((state / "local-service.json").read_text())["authSecret"]
        stamps = {p.name: p.stat().st_mtime_ns for p in state.glob("*.sha256")}
        stop(child, base)
        if desktop:
            desktop_stopped(desktop_pid)
        output.close()
        child = output = None
        checks.append("ctrl-c-reaps-hub-and-releases-port")
        with closing(sqlite3.connect(state / "soduwork.db")) as db:
            assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
            assert db.execute("SELECT COUNT(*) FROM app_user").fetchone()[0] == 1
            assert db.execute("SELECT version_num FROM alembic_version").fetchone()[0]

        child, output = start(state, port, desktop=desktop)
        begin = time.monotonic()
        wait_ready(child, base, state, timeout=90)
        if desktop:
            desktop_pid = desktop_ready(child, state, previous_pid=desktop_pid)
        print(f"Repeat startup: {time.monotonic() - begin:.1f}s", flush=True)
        assert request(base, "/api/v1/admin/me", token=token)["id"] == login["user"]["id"]
        assert request(base, "/api/v1/admin/tasks/" + task["id"], token=token)["title"] == task["title"]
        saved = next(row for row in request(base, attachment_path, token=token) if row["id"] == attachment["id"])
        assert request(base, saved["url"], raw=True) == content
        assert json.loads((state / "local-service.json").read_text())["authSecret"] == secret_before
        assert {p.name: p.stat().st_mtime_ns for p in state.glob("*.sha256")} == stamps
        assert request(base, "/api/v1/admin/login", {"user": "admin", "pass": password})["token"]
        checks.append("restart-preserves-account-login-token-task-attachment-and-build-cache")
        combined_logs = (state / "startup.log").read_text(encoding="utf-8", errors="replace")
        assert password not in combined_logs and token not in combined_logs
        assert password not in (state / "local-service.json").read_text()
        checks.append("no-admin-password-or-token-written-to-config-or-logs")
        # Closing a console or killing the launcher must not leave a headless Hub.
        child.kill()
        child.wait(timeout=10)
        stop(child, base)
        if desktop:
            desktop_stopped(desktop_pid)
            checks.append('electron-stopped-after-ctrl-c-and-killed-launcher')
        output.close()
        child = output = None
        checks.append("closed-launcher-pipe-stops-orphan-hub")
    finally:
        if child is not None:
            stop(child, base)
        if output is not None:
            output.close()
        report = {"ok": len(checks) == (14 if desktop else 12), "checks": checks, "dataDir": str(state), "url": base,
                  "nativeKeychain": "mocked" if desktop and sys.platform == 'darwin' else "not-verified"}
        (state / "verification.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(json.dumps(report, indent=2), flush=True)
    assert len(checks) == (14 if desktop else 12)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--desktop', action='store_true', help='Also verify native Electron readiness and cleanup (requires a graphical desktop)')
    verify(desktop=parser.parse_args().desktop)
