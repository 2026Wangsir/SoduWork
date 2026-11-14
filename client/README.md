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

Native history and downloaded conversation replicas retain their account and Hub boundaries when listed, read, restored, or changed, including offline use. Unknown-owner archives require explicit import as separate read-only copies. Cached content does not grant permission to execute a requirement or cloud conversation; resolving a verified native source must preserve its original runtime, model, and permissions.

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

On Windows, the execution runtime joins a native Job Object before tools initialize. A private Windows PowerShell helper retains the job until shutdown and verifies its processes have exited, including Git Bash descendants whose intermediate Windows parent has already exited. This is lifecycle cleanup, not a security sandbox; Linux and macOS retain their existing process-tree cleanup.

To verify summary export against a disposable authenticated Hub, run `node e2e/acceptance-summary-export.cjs /absolute/evidence/directory /path/to/test/python`. The Python environment needs the backend test dependencies. This exercises native IPC and saved bytes with injected save-dialog choices, not a real model or production account.

## Packaging

Before distributing native installers, complete the outstanding [distribution materials](../third-party/README.md) and platform acceptance.

On Windows, install `../hub-backend/requirements-runner-build.txt` in the backend build environment, then run `npm run build` or `npm run build-portable`. Packaging rebuilds the single-file Runner from `runner_main.py` and `runner.spec`. Do not reuse an old EXE as build input.

Windows packaging freezes source payloads through `scripts/payload-sources.cjs` to handle filesystems that expose different bytes to different processes. Source changes after manifest generation fail the build. Generated `.runtime/installer/payload-sources/` is not versioned. Native installer builds share resources and should run sequentially.

The interactive Windows installer offers English, Simplified Chinese, Japanese and Korean. It defaults to the Windows UI language, with English as the fallback, and lets the user choose before installation. Silent updates do not show the selector. Installer language does not overwrite the desktop's saved interface language. macOS and Linux retain their platform installation interfaces.

Windows uninstall retains local application data by default. The interactive wizard can optionally remove the current Windows account's `%APPDATA%\SoduWork` directory after a second confirmation. It displays the exact directory before deletion and refuses linked directories. External workspaces, other Windows accounts, Hub service data, and custom `SODUWORK_USER_DATA` locations are outside this cleanup. Silent uninstall and upgrades retain data; the legacy `--delete-app-data` switch is rejected so it cannot bypass confirmation.

Frozen input directories contain at most 64 files to avoid repeated compiler scans. Installation and verification share one extraction function with compression and per-file verification; the verifier documents compatibility exceptions for older installers. Installer fault-injection tests share the build directory and must also run sequentially. Before release, verify the final installer, upgrade, and rollback. Packaging excludes test files and selects only the single-file Runner executable as a Runner resource.

OpenCode is optional and is neither bundled nor downloaded during packaging. There is one lightweight build recipe. Agent identifiers, display metadata, model scope, and permissions come from the shared `../hub-backend/app/agent_catalog.json`, copied into release resources. Avoid a second renderer-owned catalog.

Agent management still detects installed OpenCode and offers explicit installation. `build-light` is retired; the normal build uses the lightweight recipe.

Device-owned models can be paired with any local managed runtime, including Pi, Qwen, OpenCode, DeepSeek Harness, Kimi, Harness2 and Codex Harness. Codex and Claude account runtimes keep their own model catalogs. Local Agent defaults are encrypted and scoped to the current Hub, device and account; conversations, requirement execution and local automations use these selections. New conversations, conversation composers, requirement dispatch and automation forms use the first available model when no model is selected or the selected model has been deleted. Local models precede Hub models, and valid selections remain unchanged. Existing conversation history is retained when the next turn switches to the replacement model. Local model calls do not consume Hub model allowance, but normal account and execution permissions still apply.

In Agent management, a managed runtime with no saved model, or with a deleted model, displays and tests the first available model. The list places local models before Hub models, and valid saved choices remain selected. This fallback does not rewrite the encrypted preference. An empty catalog remains unavailable; a failed secure-store read is reported rather than treated as deletion. Run `node e2e/agent-single-model-default.cjs /absolute/evidence/directory` to verify selection, deletion fallback and probe routing with real Electron UI, encrypted storage and private IPC. Hub and Runner responses in this test are synthetic; it does not call real model services.

Unattended local automations resolve the same fallback before opening their conversation, after verifying ownership of any device model mapping. They retain the saved schedule preference and use the replacement only for execution. Deploy both client and Hub changes for schedules whose saved Hub model has been removed: the Hub must allow the owning desktop to resolve that missing selection. Remote targets and account runtimes retain their existing admission rules. An unreadable or incomplete catalog is not evidence of model deletion; offline local access does not authorize replacing an unverified Hub selection.

Cloud conversations, remote dispatch and Hub-controlled workflows do not accept device-owned model references. Local Agent tests execute through the desktop's private Runner pipe and do not publish model configuration or test logs to Hub. Pi can generate images directly with a local OpenAI-compatible image model; output stays in the local workspace and accepts base64 image data or same-origin result URLs. Local video generation is not provided. Legacy automation model mappings without verifiable account ownership are retained in encrypted storage and require explicit model reselection. The local-model admission E2E exercises default selection, deletion, account isolation and quota behavior with real Electron processes and synthetic loopback services.

See [release scope](../docs/release-scope.en.md), [plugin authoring](../docs/plugin-authoring.en.md), and the [H5 SDK](sdk/README.md).
