# SoduWork Hub backend

[简体中文](README.zh-CN.md) · **English** · [Developer guide](../docs/development.en.md#hub-backend)

Command examples use `sh start.sh` on macOS/Linux. On Windows, use `.\start.cmd` in PowerShell or `start.cmd` in Command Prompt with the same arguments. Standalone Python tools use `python3`; use `py` on Windows, or `python` inside an activated virtual environment.

Hub provides identity, authorization, execution governance, plugins, shared materials, and desktop connectivity. It uses FastAPI and asynchronous SQLAlchemy with PostgreSQL; local development can use SQLite.

## Start locally

For a first session, use `sh start.sh` from the repository root; it creates an isolated database, environment, and administrator.

For direct backend development, create a dedicated environment:

```sh
cd hub-backend
python3 -m venv .venv
```

Windows PowerShell:

```powershell
.venv/Scripts/python -m pip install -r requirements.txt
.venv/Scripts/python -m uvicorn app.main:app --reload --port 9080
```

macOS / Linux:

```sh
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m uvicorn app.main:app --reload --port 9080
```

Direct development uses local configuration and data; keep it separate from real deployments. Configure bootstrap identity with `ADMIN_USER` / `ADMIN_PASS` in a private environment; no shared default password is supplied. The root launcher handles this interactively instead.

API documentation: **http://127.0.0.1:9080/docs**. Health check: `GET /healthz`.

## Offline quality gate

Use the dedicated test environment, not a production service environment:

```sh
python3 -m pip install -r requirements-test.txt
python3 quality_gate.py --list
python3 quality_gate.py --profile release --scope backend
python3 quality_gate.py --profile extended --scope all
```

The manifest in `quality_manifest.py` registers checks and their profiles. Unregistered checks block the gate. `live` checks connect to real Hubs, Runners, providers, or business data; they are not part of default offline acceptance.

Smoke checks live in [`smoke/`](smoke/). To run one directly, use its module from the `hub-backend/` directory, for example `python3 -m smoke.smoke_capabilities`. The quality gate selects the appropriate registered modules. Unit tests and `tests/` integration helpers keep their existing locations.

## Database configuration

Set `DATABASE_URL` in private configuration when overriding the SQLite default:

| Environment | Value |
| --- | --- |
| Local SQLite | `sqlite+aiosqlite:///./soduwork_hub.db` |
| PostgreSQL | `postgresql+asyncpg://soduwork:<PASSWORD>@db.example.com:5432/soduwork` |
| Docker self-hosting | Run `python3 ops/self-host/deploy.py up` from the repository root; it generates independent credentials |

The PostgreSQL value is a placeholder. Use a dedicated database and a minimally privileged account. Never commit environment files or credentials. See [self-hosting](../ops/self-host/README.md) for backups and deployment.

## API and trust boundaries

- Devices enroll with `POST /api/v1/clients/enroll`, then use a short-lived device session. Device long-term keys remain in the Electron main process; Hub stores only their digest.
- Business requests use `Authorization: Device <session>`. WebSocket connectivity uses the same short-lived session at `/api/v1/ws`.
- Tasks use `/api/v1/tasks`, task-specific operations, batch updates, completed-task clearing, and agent run/retry/takeover routes. Configuration uses `/api/v1/config`.
- Administrators sign in at `/api/v1/admin/login` and use bearer tokens for administrator APIs, including clients, tasks, and dispatch.
- Long-term device keys must not enter renderers, logs, or URLs. Server state is authoritative; offline client caches must not overwrite it.

Account conversation directory and source projections include `contentLocation`: `hub` for legacy Hub content, `source` for content retained by the original endpoint, `replica` for a valid migrated copy at the current source revision, or `unknown` when the reference cannot be established. The field does not expose private replica identifiers or grant access; clients must retain existing account, Hub, and execution checks. An unknown location must not be used to discard a potentially independent local copy.

See [OAuth deployment and validation](CONNECTOR_OAUTH.en.md) for connector credentials and authorization.

## Requirement migration and access

Task APIs retain their public contract. `requirementContent` contains requirement text; execution `title/note` can contain private context. Updates carry `requirementVersion` and write only authorized projections. `canEditRequirement` and `canViewExecution` are separate capabilities.

Requirement project selection uses the existing active Hub business-project catalog from `GET /api/v1/projects`, including its organization scope and public projects. Only the task's owning device and account may change or clear `projectId`, before any execution history, with the current `requirementVersion`; `null` clears the association. A repository-linked task's project stays fixed. Explicit new associations must be visible, active, and consistent with any repository. Unchanged legacy associations and repository-only callers retain their existing behavior; personal conversation projects are not Hub business projects.

Migration 0053 preserves original records in `legacy_requirements` and records creator/requester/manager scope in `task_requirement_access`. Users with access to only some original requirements may read their own snapshots and materials, but cannot edit the combined requirement or read the others. Sharing a requirement does not grant access to execution records, comments, or output attachments. Lists, details, attachments, and WebSockets share these rules. Restore archived requirements before dispatching them; archiving completed work preserves its acceptance and completion state.

Back up matching source and database before upgrading. Migration 0053 transfers the records transactionally and drops the old requirements table; file contents and object-storage keys remain unchanged. Merging requirements with different visibility scopes fails and rolls back rather than broadening permissions. Repeating the migration does not duplicate records. Automatic downgrade is disabled; rollback requires the verified pre-upgrade database and matching application. Retired `/work-items` routes return 410; the old `work.task.create` plugin method remains an alias for unified Task creation.

Upgrade checks:

```sh
python3 -B tests/unified_requirements_upgrade.py --sqlite
python3 -B tests/unified_requirements_upgrade.py
```

The second command creates and tears down an isolated local PostgreSQL instance. Do not point it at a business database. `test_unified_requirements_acl.py` exercises access controls through authenticated HTTP identities and WebSocket projections after real migration.

See [release scope](../docs/release-scope.en.md) for distribution boundaries.

## OpenCode model selection on resume

Managed native OpenCode turns pass the current model explicitly. ACP turns select the exact advertised model before prompting, using the existing session ID and history. Updating the injected default alone does not change the model retained by a native session. Missing routes or an unconfirmed model change stop the turn; the adapter does not restore old credentials, rename models, or create a replacement session.

Run `SODUWORK_TEST_OPENCODE_BIN=/absolute/path/to/opencode python3 -m unittest test_opencode_native_model_selection` with the backend test dependencies to verify native and ACP model changes against loopback endpoints. The test uses isolated native state and synthetic credentials, and checks retained history, model IDs, and credential rotation over three turns. It does not exercise a production provider or desktop UI.

## Requirement automation drafts

An authorized manager of an unarchived requirement can copy its public content into an independent automation draft. Opening or canceling the form creates nothing. Saving always creates a disabled schedule and never changes the source requirement, its version, or its existing automation link. Later schedule edits and enabling are independent of the requirement.

`POST /api/v1/schedules` accepts `sourceRequirement: {id, requirementVersion}` and a stable `creationRequestId` for this path. Hub checks current management access, archive state and the expected version, then stores a server-derived `source_requirement` snapshot of the source ID, public title and version. The response exposes these three fields as `sourceRequirement`; ordinary schedule edits cannot replace them, and provenance grants no additional task access. No execution routing, credentials or local model references are copied.

Repeating the same creation request for the same account and device returns its existing schedule. Reusing its ID with different content returns 409. This also recovers a lost response after the source changes. Migration `0088_schedule_requirement_source` adds an empty JSON default for existing schedules; it does not infer historical sources or rewrite old links.
