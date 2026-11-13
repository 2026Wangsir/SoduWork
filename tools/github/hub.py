"""Accept the exact public Hub image using disposable PostgreSQL and HTTP."""
from __future__ import annotations

import gzip
import json
import re
import secrets
import shutil
import subprocess
import time
import urllib.request
import uuid

from release import ROOT, expected, require


def docker(*args, output=False):
    result = subprocess.run(["docker", *args], cwd=ROOT, check=True,
                            stdout=subprocess.PIPE if output else None, text=True)
    return result.stdout.strip() if output else None


def wait(check, seconds=180):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        try:
            return check()
        except (OSError, ValueError, subprocess.CalledProcessError):
            if time.monotonic() >= end:
                raise
            time.sleep(2)
    raise TimeoutError("Isolated Hub acceptance timed out")


def build_and_accept(ctx, folder):
    image = "soduwork-public-hub:" + ctx["commit"]
    docker("build", "--file", "ops/self-host/Dockerfile", "--tag", image,
           "--build-arg", "HUB_BASE_IMAGE=deps",
           "--build-arg", "SODUWORK_VERSION=" + ctx["commit"],
           "--build-arg", "SODUWORK_HUB_VERSION=" + ctx["version"],
           "--build-arg", "SODUWORK_RELEASE_TAG=" + ctx["tag"], ".")
    image_id = docker("image", "inspect", "--format", "{{.Id}}", image, output=True)
    prefix = "soduwork-public-" + uuid.uuid4().hex
    network, db, hub = prefix + "-net", prefix + "-db", prefix + "-hub"
    created = []
    network_created = False
    try:
        docker("network", "create", network)
        network_created = True
        password = secrets.token_hex(24)
        docker("run", "-d", "--name", db, "--network", network, "--network-alias", "db",
               "-e", "POSTGRES_USER=soduwork", "-e", "POSTGRES_DB=soduwork", "-e", "POSTGRES_PASSWORD=" + password,
               "postgres:16-bookworm")
        created.append(db)
        wait(lambda: docker("exec", db, "pg_isready", "-U", "soduwork", "-d", "soduwork", output=True))
        docker("run", "-d", "--name", hub, "--network", network, "-p", "127.0.0.1::8989",
               "-e", "DATABASE_URL=postgresql+asyncpg://soduwork:" + password + "@db:5432/soduwork",
               "-e", "AUTH_SECRET=" + secrets.token_hex(32), "-e", "CONNECTOR_OAUTH_KEY=" + secrets.token_hex(32),
               "-e", "ADMIN_PASS=" + secrets.token_hex(24), "-e", "ADMIN_USER=admin",
               "-e", "DB_MIGRATION_MODE=auto", "-e", "HUB_LOCAL_EXECUTION_ENABLED=false",
               "-e", "REPORT_AUTO=false", "-e", "REPOSITORY_SYNC_INTERVAL_SECONDS=0", image_id)
        created.append(hub)
        require(docker("inspect", "--format", "{{.Image}}", hub, output=True) == image_id, "Running image differs")
        origin = "http://" + docker("port", hub, "8989/tcp", output=True)

        def fetch(path):
            with urllib.request.urlopen(origin + path, timeout=5) as response:
                return response.headers.get("Content-Type", ""), response.read()

        def ready():
            require(json.loads(fetch("/readyz")[1]).get("ready") is True, "Hub is not ready")

        wait(ready)
        health = json.loads(fetch("/healthz")[1])
        require(health.get("ok") is True and health.get("commit") == ctx["commit"]
                and health.get("version") == ctx["version"]
                and health.get("releaseTag") == ctx["tag"], "Health identity differs")
        runtimes = {}
        for executable in ("pi", "codex"):
            version = docker("exec", hub, executable, "--version", output=True)
            require(bool(version), "Missing runtime version: " + executable)
            runtimes[executable] = version
        docker("exec", hub, "python", "runner_main.py", "--help", output=True)
        docker("exec", hub, "python", "-c",
               "import os,pathlib,tempfile; assert os.getuid() == os.getgid() == 10001; "
               "paths = ['uploads','downloads','client-releases','workspaces','releases',"
               "'/srv/runtime','/srv/app/repos']; "
               "[tempfile.TemporaryFile(dir=p).close() for p in paths]; "
               "assert all(pathlib.Path(p).is_file() for p in "
               "['import_client_release.py','ops_publish_builtin_plugins.py',"
               "'../third-party/licenses/pi-LICENSE.txt',"
               "'../third-party/licenses/codex-hub-LICENSE.txt',"
               "'../third-party/licenses/codex-hub-NOTICE.txt'])")
        content_type, html = fetch("/")
        require("text/html" in content_type, "Frontend HTML missing")
        assets = set(re.findall(r'(?:src|href)=["\'](/assets/[^"\']+)["\']', html.decode()))
        require(any(name.endswith(".js") for name in assets), "No frontend entry script")
        for asset in assets:
            kind, body = fetch(asset)
            require(body and "text/html" not in kind, "Missing frontend asset: " + asset)
        docker("exec", hub, "python", "db_admin.py", "migrate")
        docker("exec", hub, "python", "-m", "alembic", "check")
        docker("restart", hub)
        origin = "http://" + docker("port", hub, "8989/tcp", output=True)
        wait(ready)
        archive = folder / expected(ctx, "hub")[0]
        with archive.open("xb") as target, gzip.GzipFile(fileobj=target, mode="wb", mtime=0) as compressed:
            process = subprocess.Popen(["docker", "save", image], stdout=subprocess.PIPE)
            try:
                shutil.copyfileobj(process.stdout, compressed)
            finally:
                process.stdout.close()
            require(process.wait() == 0, "Image export failed")
        # Load the actual exported bytes and verify the same immutable image ID.
        docker("load", "--input", str(archive))
        require(docker("image", "inspect", "--format", "{{.Id}}", image, output=True) == image_id, "Exported image identity differs")
        return {"ok": True, "imageId": image_id, "imageTag": image, "runtimes": runtimes,
                "checks": ["postgres-migration", "schema-drift", "health-ready", "frontend-assets",
                           "agent-cli-versions", "runner-entrypoint", "nonroot-data-directories", "runtime-license-notices",
                           "restart", "image-export-load"],
                "limitations": ["Single disposable Linux amd64 Hub; no production deployment, real-model calls or browser UI acceptance.",
                                "Agent CLI versions and Runner entrypoint only; no provider authentication or task execution."]}
    finally:
        for name in reversed(created):
            docker("rm", "-f", "-v", name)
        if network_created:
            docker("network", "rm", network)
