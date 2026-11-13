"""Static contract for the production Hub image.

The server used to be built from an untracked scratchpad Dockerfile. It omitted Alembic assets,
so a repository that passed migration tests could still deploy an image unable to migrate its
database. Keep the release image small, deterministic and self-contained at the quality gate.

Expensive, rarely-changing dependency layers (OS packages, global npm tooling, pinned Python
requirements) live in the `deps` stage so they can be published once as a dependency base image
at an operator-provided registry. ops/self-host/Dockerfile defaults to `deps` for a self-contained
build; operators can explicitly select a published base with the HUB_BASE_IMAGE build argument. Release
builds reconcile the current Python requirements before copying application source.
"""
from __future__ import annotations

import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
DOCKERFILE = ROOT / "ops/self-host/Dockerfile"
DOCKERIGNORE = ROOT / "ops/self-host/Dockerfile.dockerignore"
MAIN = ROOT / "hub-backend" / "app" / "main.py"
checks = 0


def ok(condition: bool, message: str) -> None:
    global checks
    if not condition:
        raise AssertionError(message)
    checks += 1


source = DOCKERFILE.read_text(encoding="utf-8")
ignored = DOCKERIGNORE.read_text(encoding="utf-8").splitlines()

for required in (
    "COPY hub-backend/app ./app",
    "COPY hub-backend/runner_main.py ./runner_main.py",
    "COPY hub-backend/db_admin.py ./db_admin.py",
    "COPY hub-backend/import_client_release.py ./import_client_release.py",
    "COPY hub-backend/client-update-trust.json ./client-update-trust.json",
    "COPY hub-backend/plugins ./plugins",
    "COPY hub-backend/alembic.ini ./alembic.ini",
    "COPY hub-backend/migrations ./migrations",
    "COPY --from=admin-build /build/hub-frontend/dist /srv/app/hub-frontend/dist",
    "COPY skills /srv/app/skills",
):
    ok(required in source, f"server image omits runtime asset: {required}")

for package in (
    "@earendil-works/pi-coding-agent",
    "@openai/codex",
):
    match = re.search(re.escape(package) + r"@(\d+\.\d+\.\d+)", source)
    ok(bool(match), f"server image does not pin {package}")

ok("@anthropic-ai/claude-code" not in source,
   "server image must not install the retired Claude Code substrate")

ok("opencode-ai" not in source and "fetch_opencode_assets" not in source,
   "server image must leave OpenCode installation to an explicit user action")

for required_ignore in ("**", "**/.git", "**/.env*", "**/node_modules", "**/*.db*"):
    ok(required_ignore in ignored, f"docker context does not exclude {required_ignore}")

ok("hub-frontend/package-lock.json" in source and "npm ci" in source,
   "admin build is not locked by package-lock.json")
ok("COPY hub-frontend/dist" not in source,
   "server image trusts a stale local admin build instead of building it")

ok('org.opencontainers.image.revision="${SODUWORK_VERSION}"' in source,
   "server image does not expose an immutable revision label")

# OS and global npm layers stay in `deps`. A published dependency base can lag
# behind the checkout, so the release stage must apply current Python changes.
ok(bool(re.search(r"(?m)^ARG HUB_BASE_IMAGE=deps\s*$", source)),
   "server image must default to the self-contained deps stage")
ok("--build-arg HUB_BASE_IMAGE=deps" in source,
   "self-contained build (--build-arg HUB_BASE_IMAGE=deps) is not documented in ops/self-host/Dockerfile")
RUNTIME_MARKER = "FROM ${HUB_BASE_IMAGE} AS runtime"
ok(RUNTIME_MARKER in source,
   "runtime stage does not derive from the dependency base")
if RUNTIME_MARKER in source:
    deps_stage, runtime_stage = source.split(RUNTIME_MARKER, 1)
    for fragment in (
        "apt-get install -y --no-install-recommends git openssh-client",
        "chromium fonts-noto-cjk",
        "postgresql-client-16",
        "COPY --from=node-runtime /usr/local/lib/node_modules",
        "COPY hub-backend/requirements.txt ./requirements.txt",
        "python -m pip install -r requirements.txt",
    ):
        ok(fragment in deps_stage, f"dependency base stage omits {fragment}")
    for forbidden in (
        "apt-get install",
        "npm install -g",
    ):
        ok(forbidden not in runtime_stage,
           f"runtime stage rebuilds dependency layer ({forbidden}); it belongs in the deps stage")
    ok(deps_stage.count("python -m pip install -r requirements.txt") == 1,
       "dependency base must install its Python requirements exactly once")
    requirements_copy = "COPY hub-backend/requirements.txt ./requirements.txt"
    ok(requirements_copy in runtime_stage,
       "release image keeps stale requirements from the published dependency base")
    runtime_install = re.search(
        r"(?m)^RUN\s+python\s+-m\s+pip\s+install\s+(?:--no-cache-dir\s+)?-r\s+requirements\.txt(?:\s|$)",
        runtime_stage,
    )
    ok(bool(runtime_install),
       "release image does not install newly added or changed Python requirements")
    ok(runtime_stage.index(requirements_copy) < runtime_install.start()
       < runtime_stage.index("COPY hub-backend/app ./app"),
       "current Python dependencies must install before application source invalidates the cache")
ok(source.index("COPY skills /srv/app/skills")
   < source.index("ARG SODUWORK_VERSION=dev"),
   "release metadata invalidates expensive dependency/source layers")
ok('SODUWORK_DEPLOY_COMMIT="${SODUWORK_VERSION}"' in source,
   "image cannot identify itself without an external environment file")
ok("USER 10001:10001" in runtime_stage,
   "shared Hub image must retain its non-root runtime user")
ok('SODUWORK_DATA_ROOT=/srv/runtime' in runtime_stage,
   "shared Hub image must retain its writable data root")
ok(not (ROOT / "ops/self-host/Dockerfile.server").exists(),
   "Hub builds must use one shared Dockerfile")

main_source = MAIN.read_text(encoding="utf-8")
ok('mobile-web-dist' not in source and '_mount_mobile' not in main_source,
   "server must not depend on the excluded mobile distribution")
ok('"version": version if version and version != "dev" else release or settings.version' in main_source
   and '"apiVersion": settings.version' in main_source,
   "health endpoint does not distinguish release identity from API version")
ok('"commit": release' in main_source,
   "health endpoint omits the source revision")

print(f"server image: {checks} checks passed")
