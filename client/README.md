# SoduWork desktop client

[简体中文](README.zh-CN.md) · **English** · [Developer guide](../docs/development.en.md#desktop-client)

Command examples use `sh start.sh` on macOS/Linux. On Windows, use `.\start.cmd` in PowerShell or `start.cmd` in Command Prompt with the same arguments. Standalone Python tools use `python3`; use `py` on Windows, or `python` inside an activated virtual environment.

The desktop uses Electron and native HTML/CSS/JavaScript. The React management UI is a separate application.

## Source map

| Location | Responsibility |
| --- | --- |
| `main.js`, `main/` | Application lifecycle, native windows, device identity, updates, files, and execution runtimes; overlay lifecycle is in `main/desktop-overlay.cjs` |
| `preload.js` | Restricted renderer IPC; no general Node access for pages |
| `desk.html`, `desk-boot.js` | Main workspace loading and startup |
| `index.html` | Transparent pet and shortcut overlay |
| `core/` | State, synchronization, localization, and shared utilities |
| `components/requirements/` | Requirement pool, requirement drawer, dispatch lifecycle, and shared fields |
| Other `components/` directories | Conversations, AI team, and business views; runtime selectors also live under `panels/` |
| `theme/`, `assets/`, `vendor/` | Themes, assets, and licensed renderer dependencies |
| `tests/`, `e2e/` | Unit/contract checks and Electron validation; excluded from product packaging |
| `scripts/`, `build/` | Runtime preparation and native packaging |
| `runner/`, `dist/`, `.runtime/` | Generated Runner, release packages, and runtime resources |

Conversations and task execution share the same session path: `panels-chat` → `conversationSession` → main-process IPC → `agent-runtime` → Pi or Runner. AI team assignments open the corresponding conversation. Requirement drawers expand task traces; legacy detail links resolve the same requirement rather than creating duplicate records.

The desktop rail opens the requirement pool directly. The old task board, detail chat box, and separate AI workstation conversation are retired. The [release scope](../docs/release-scope.en.md) describes the shared structure, assignment rules, and compatibility boundaries.

HTML script order defines dependencies. When splitting scripts, verify resource references, shared state, loading order, and actual Electron behavior.

Account-backed conversation replicas retain their account and Hub boundaries when read, restored, or changed. Cached content does not grant permission to execute a requirement or cloud conversation. Ordinary native history remains local to the device; resolving a native source must preserve its original runtime, model, and permissions.

Remote notice history and receipt markers use account-scoped IndexedDB transactions and Web Locks when both browser capabilities are available. Local reminders remain in the existing localStorage cache. Migration retires a legacy snapshot only after a successful durable commit, and a failed write preserves that snapshot for retry. Environments without these capabilities keep the existing cache behavior.

The requirement delivery section can export one acceptance summary as Markdown through the native save dialog. Export requires execution-record access and an existing fixed delivery version. It reads one consistent snapshot, separates current requirement text from recorded acceptance criteria, and leaves missing validation or runtime attribution explicitly unrecorded. Exporting does not approve or change the requirement.

The same section has a collapsed dispatch-instructions history. New desktop dispatches retain the explicitly entered supplementary note and selected/effective submission policy for each admitted conversation turn, including failed attempts. Native, Runner and workflow execution share this receipt path. Retrying the same turn cannot replace its note; later turns retain separate records. Only existing execution viewers can read this history. Old clients and historical entries without an explicit snapshot show missing fields as unrecorded; chat text, truncated legacy context and current routing are never used to reconstruct them.

## Run and verify

For a first local session, run `sh start.sh --desktop` from the repository root. For independent development, keep Hub running and execute:

```sh
cd client
npm ci
npm start
```

Use Node.js 22.19+. A separately started client retains its own profile and Hub connection settings. See the [developer guide](../docs/development.en.md) for service addresses and profile isolation.

The root source launcher prepares both Hub and Runner dependencies in its private `venv/` and explicitly binds the generated desktop to that Python interpreter. Independent `npm start` development uses `../hub-backend/.venv` with `requirements-runner.txt` installed. Both paths execute the current backend source; do not substitute a Runner copied from an old release.

Run `npm test` for unit/contract tests and `npm run check:layout` for source boundaries. Inspect the requirements of each `e2e/` script before using it. Fixture success does not establish real-model or production acceptance.

To verify summary export against a disposable authenticated Hub, run `node e2e/acceptance-summary-export.cjs /absolute/evidence/directory /path/to/test/python`. The Python environment needs the backend test dependencies. This exercises native IPC and saved bytes with injected save-dialog choices, not a real model or production account.

## Packaging

Before distributing native installers, complete the outstanding [distribution materials](../third-party/README.md) and platform acceptance.

On Windows, install `../hub-backend/requirements-runner-build.txt` in the backend build environment, then run `npm run build` or `npm run build-portable`. Packaging rebuilds the single-file Runner from `runner_main.py` and `runner.spec`. Do not reuse an old EXE as build input.

Windows packaging freezes source payloads through `scripts/payload-sources.cjs` to handle filesystems that expose different bytes to different processes. Source changes after manifest generation fail the build. Generated `.runtime/installer/payload-sources/` is not versioned. Native installer builds share resources and should run sequentially.

Frozen input directories contain at most 64 files to avoid repeated compiler scans. Installation and verification share one extraction function with compression and per-file verification; the verifier documents compatibility exceptions for older installers. Installer fault-injection tests share the build directory and must also run sequentially. Before release, verify the final installer, upgrade, and rollback. Packaging excludes test files and selects only the single-file Runner executable as a Runner resource.

OpenCode is optional and is neither bundled nor downloaded during packaging. There is one lightweight build recipe. Agent identifiers, display metadata, model scope, and permissions come from the shared `../hub-backend/app/agent_catalog.json`, copied into release resources. Avoid a second renderer-owned catalog.

Agent management still detects installed OpenCode and offers explicit installation. `build-light` is retired; the normal build uses the lightweight recipe.

See [release scope](../docs/release-scope.en.md), [plugin authoring](../docs/plugin-authoring.en.md), and the [H5 SDK](sdk/README.md).
