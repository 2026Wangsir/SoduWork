# Docker self-hosting

[简体中文](README.zh-CN.md) · **English** · [Documentation](../../docs/README.md)

Command examples use `sh start.sh` on macOS/Linux. On Windows, use `.\start.cmd` in PowerShell or `start.cmd` in Command Prompt with the same arguments. Standalone Python tools use `python3`; use `py` on Windows, or `python` inside an activated virtual environment.

For a new single-host deployment with one Hub, its same-origin management UI, and PostgreSQL 16. Windows/macOS need Docker Desktop using Linux containers; Linux needs Docker Engine and Compose v2. The host needs Python 3.12+. Node.js and a host database installation are unnecessary.

Images build from current source using Docker Hub, npm, PyPI, and official PostgreSQL sources by default. This path manages an independent instance without modifying existing clusters or clients. It has no Redis/Valkey dependency. Multi-node storage and coordination require separate design.

Compose and GitHub releases use the same `ops/self-host/Dockerfile`; it replaces
the separate `Dockerfile.server`. The image includes Pi 0.83.0, Codex 0.147.0,
Runner source and the backup, client-release import and built-in plugin publication
tools. It runs as UID/GID 10001 and starts only the Hub. Existing mounted directories
must allow that user to write; installing the CLIs does not register or start a Runner.
Original Pi/Codex license snapshots are included in `/srv/app/third-party/licenses`;
their source references and digests are recorded in `third-party/manifest.json`.

The default `HUB_BASE_IMAGE=deps` builds dependencies from official sources. For
repeated operator builds, `docker build --target deps -f ops/self-host/Dockerfile .`
can produce a reusable dependency image. Pass its reviewed immutable reference as
`--build-arg HUB_BASE_IMAGE=<image@sha256:digest>` to a later build; it must retain
the CLI versions, Node.js, OS tools and license material from the `deps` stage.
Python requirements are reconciled with the current source. Release builds also
set `SODUWORK_VERSION` (full commit), `SODUWORK_HUB_VERSION` and
`SODUWORK_RELEASE_TAG` through build arguments; local builds default to `dev`.

## Start

Install and start Docker, then run from the source root:

```sh
python3 ops/self-host/deploy.py up
```

On Windows, use `py ops/self-host/deploy.py up`. Wrappers are also available: `ops/self-host/deploy.cmd up` or `sh ops/self-host/deploy.sh up`.

First run creates private configuration with separate random database and initial administrator passwords, a signing key, and a connector-authorization encryption key. It builds the UI and backend image and migrates the new database. Only after health checks pass does it report **http://127.0.0.1:18989** as ready. First build needs internet access and several GB of free disk space.

Retrieve this instance's bootstrap password:

```sh
python3 ops/self-host/deploy.py credentials
```

Sign in as `admin`, then change the password in user management. This command prints the original bootstrap password; it does not reset a password changed in the database. Normal startup and build logs omit plaintext passwords.

Choose a different port and independent instance directory if needed:

```sh
python3 ops/self-host/deploy.py up --port 18990 --data-dir "/private/soduwork-team"
```

For a new instance, use an empty directory outside the source tree. Each directory has its own Compose project and volumes. Repeat the same `--data-dir` for later commands. Remote Docker daemon contexts are rejected to avoid accidentally targeting another server. Docker must use Linux containers.

## Stop, restart, and inspect

```sh
python3 ops/self-host/deploy.py status
python3 ops/self-host/deploy.py logs
python3 ops/self-host/deploy.py stop
python3 ops/self-host/deploy.py up --no-build
```

`stop` preserves this instance's database, files, and keys. It does not remove volumes or clean other Docker resources. Build and health-check failures return an error; retry the same command after fixing the cause. Use `--no-build` only to restart an already built version. After source updates, run `up` to rebuild.

| Platform | Default private configuration directory |
| --- | --- |
| Windows | `%LOCALAPPDATA%\SoduWork\self-host` |
| macOS | `~/Library/Application Support/SoduWork/self-host` |
| Linux | `$XDG_DATA_HOME/soduwork/self-host`, or `~/.local/share/soduwork/self-host` |

`deployment.json` contains instance credentials and keys. Keep it private. Business data and files live in Docker named volumes prefixed by its `project` value. **The configuration directory alone is not a business-data backup.** Stopping preserves volumes; Docker Desktop resets, uninstallation, or manual volume deletion can destroy them.

## Team access and execution

Hub binds to loopback; PostgreSQL has no published host port. For team access, configure your own HTTPS reverse proxy to `127.0.0.1:18989`, supporting WebSockets and long-lived streaming. Set the public origin when first initializing:

```sh
python3 ops/self-host/deploy.py up --public-url https://work.example.com
```

Replace the example domain with your own. For an existing instance, stop it, change `publicUrl` in its private `deployment.json`, then run `up --no-build`. Use an HTTPS origin without `/api`, credentials, or query parameters. The helper does not provision certificates, DNS, or firewall rules. Verify HTTPS login, uploads, WebSockets, and streaming after configuring the proxy.

Connect the desktop to this Hub URL. Users supply model and connector authorization. Agents do not automatically execute in the management container: register a separate Runner for cloud execution; the client's Runner handles local execution. The management container runs as a non-root user without a Docker socket mount or automatic access to host SSH credentials.

## Updates, backups, and rollback

Before an upgrade, stop dispatching work, wait for current tasks, and back up the database and all business-file volumes. Separately preserve private configuration and the current source version. Restore the database and library from a consistent point in time.

See [full_backup.py](../../hub-backend/full_backup.py) for encrypted backups and [db_admin.py](../../hub-backend/db_admin.py) for database verification and restore tools. Rehearse restoration with your own backup storage before production use.

After backup, run `python3 ops/self-host/deploy.py stop`, switch to verified new source, and run `python3 ops/self-host/deploy.py up`. This single-instance path applies versioned migrations automatically and does not report readiness after migration failure. Do not run concurrent migrations on the same database. Rollback requires matching source, database, file volumes, and keys together; old source must not connect directly to an upgraded database.

Existing multi-node deployments need an upgrade process matched to their database and shared storage.

## Network and validation

For offline deployment, first build on a connected machine with matching platform/architecture. Prepare base images, the final Hub image, PostgreSQL, and fixed dependency caches, then run `up --no-build` on the target. Initial offline downloads are not supported. Configure proxies and CAs as needed while retaining TLS verification.

Developer checks from the source root:

```sh
python3 -m unittest tools.dev.test_start_local tools.dev.test_deploy
node --test client/tests/start-client.test.cjs
python3 tools/dev/verify_local_start.py
```

The last check starts an independent SQLite source instance and verifies HTTP, persistence, and shutdown. It does not establish Docker, native macOS/Linux desktop, or model-inference acceptance. Cross-platform releases need native tests on each platform and actual Docker login and data-restart checks in an isolated project.
