# Developer guide

[简体中文](development.md) · **English** · [Documentation](README.md)

Command examples use `sh start.sh` on macOS/Linux. On Windows, use `.\start.cmd` in PowerShell or `start.cmd` in Command Prompt with the same arguments. Standalone Python tools use `python3`; use `py` on Windows, or `python` inside an activated virtual environment.

## First visit

Follow the [startup guide](getting-started.en.md) and run `sh start.sh --desktop`. Once you can sign in, choose the component you want to change. The root holds project entry points, licensing, and contribution information. Dependency, build, and distribution configuration lives with the relevant component.

| Change | Source entry points | Component reference |
| --- | --- | --- |
| Desktop windows, conversations, settings | `client/main.js`, `client/main/`, `client/core/`, `client/components/` | [Desktop reference](../client/README.md) |
| APIs, authorization, data, execution | `hub-backend/app/main.py`, `app/api/`, `app/services/`, `runner_main.py` | [Backend reference](../hub-backend/README.md) |
| Browser administration UI | `hub-frontend/src/main.jsx`, `hub-frontend/src/` | [Frontend reference](../hub-frontend/README.md) |
| Skills, plugins, workflows | `skills/`, `hub-backend/plugins/` | [Plugin protocol](plugin-authoring.en.md) |
| Local startup and deployment | `start.py`, `tools/dev/`, `ops/self-host/` | [Self-hosting](../ops/self-host/README.md) |
| Distribution scope and integrity | `tools/distribution/`, `tools/export_source.py` | [Source distribution](open-source.en.md) |

Backend `app/` paths and `runner_main.py` in the table are relative to `hub-backend/`. Each application installs its own dependencies; there is no root npm workspace.

## Management UI

Run `sh start.sh` from the root in one terminal, then start Vite in another. The source launcher uses port **18989**, while Vite defaults to a backend on **9080**. Set the proxy target explicitly.

PowerShell:

```powershell
cd hub-frontend
npm ci
$env:SODUWORK_DEV_HUB = 'http://127.0.0.1:18989'
npm run dev
```

macOS / Linux:

```sh
cd hub-frontend
npm ci
SODUWORK_DEV_HUB=http://127.0.0.1:18989 npm run dev
```

Open the Vite URL printed in the terminal (normally **http://localhost:5173**) and sign in with your local Hub account. Changes under `src/` update automatically. Verify from this directory:

```sh
npm run build
node --test tests/*.test.mjs
```

## Hub backend

`app/api/` handles requests and access checks; `app/services/` contains business logic. Models under `app/` and migrations under `migrations/` manage persistence. `runner_main.py` starts an execution worker. Treat Hub and Runner trust and permissions separately.

The root launcher synchronizes source to a private runtime copy; **it does not hot reload a running backend**. After changing source, stop and restart the same launcher command to preserve data. Do not edit the `application/` copy inside the private data directory.

For automatic reload, create a separate development environment and start Uvicorn as described in the [backend reference](../hub-backend/README.md); its default port is 9080. Use an isolated database and test accounts. Keep environment files local. Add an Alembic migration for schema changes instead of deleting user data.

Run backend checks in its dedicated environment:

```sh
cd hub-backend
python3 -m pip install -r requirements-test.txt
python3 quality_gate.py --list
python3 quality_gate.py --profile release --scope backend
```

The full offline gate takes time. Start with the registered checks relevant to your change. `live` checks connect to real services or models and require your own isolated environment; they are outside default offline validation.

## Desktop client

The desktop uses Electron with native HTML/CSS/JavaScript; the React management UI is a separate application. Main-process code lives in `main.js` and `main/`, the restricted IPC bridge in `preload.js`, and UI code primarily in `desk.html`, `core/`, and `components/`.

Keep Hub running and open another terminal:

```sh
cd client
npm ci
npm start
```

The independently started client keeps its own connection settings and profile, separate from the dedicated profile used by the root launcher's `--desktop` mode. Change the Hub URL on the login screen if needed. Quit and restart the application after main-process changes. Reopen the client after UI script changes to verify loading order and interactions.

Run `npm test` and `npm run check:layout` in `client/`. Electron end-to-end checks live in `e2e/`; inspect each script's environment requirements. `dist/`, `.runtime/`, and generated `runner/` files are build outputs. Do not commit them or substitute old release binaries for current source.

## Skills and plugins

Bundled skills live at `skills/<name>/SKILL.md`; see the [skill catalog](../skills/README.md) for project-owned guides and reviewed upstream development skills. Generic plugins and workflows live in `hub-backend/plugins/*.json`. Follow the [plugin protocol](plugin-authoring.en.md) for immutable versions, minimal permissions, and import review. Adding a bundled skill also requires explicitly updating the release scope in `tools/distribution/PUBLIC-SOURCE.json` and retaining its original license and provenance.

Models, executors such as Codex, and imported plugins use credentials and permissions configured by the user. Do not include external commercial skills, real credentials, organization addresses, or business data in examples.

## Verify before submitting

Run the checks relevant to your change from the root:

```sh
python3 -m unittest tools.dev.test_start_local
node tools/check-public-source.cjs
node tools/check-repository-layout.cjs
node tools/check-third-party.cjs
node tools/check-docs.cjs
python3 tools/security/scan_secrets.py --download
```

For startup changes, also run `python3 tools/dev/verify_local_start.py --desktop`, which needs network access and a graphical desktop. For documentation changes, verify links and commands; do not imply unperformed platform acceptance. Review and stage new source files as described in [Contributing](../CONTRIBUTING.md); archive manifests are generated during export and are not committed.

## Comment conventions

Prefer English for new public interfaces, security boundaries, and compatibility explanations. Describe current behavior and reasons; rewrite or remove internal discussions, personal anecdotes, temporary machine details, and obsolete implementation notes. Preserve protocol identifiers, storage keys, test semantics, and original third-party notices. UI translations, skill instructions, and prompts need separate validation.

See [GitHub configuration](../.github/CI.md) for automated checks and platform limits. Secret scanning covers current source and does not replace private-history review.

## Documentation and translations

Use the relative language links at the top of each page on GitHub. The same paths work in downloaded source; no documentation server is needed.

- The root and component directories use English `README.md` and Chinese `README.zh-CN.md`. The documentation indexes follow the same convention in `docs/`. Previous `README.en.md` and `docs/index.en.md` URLs link to the canonical English pages.
- Root `NOTICE.md` is English, paired with `NOTICE.zh-CN.md`. `CONTRIBUTING.md` and `SECURITY.md` are English, with Chinese versions in `docs/contributing.zh-CN.md` and `docs/security.zh-CN.md`. Other paired guides use `name.md` (Chinese) / `name.en.md` (English).
- Keep commands, prerequisites, data handling, and permission guidance synchronized in both languages. Preserve reciprocal language links and a navigation link at the top.
- Use an explicit suffix for another language, such as `.ja.md`, and register completed pages in the overview and index. Label untranslated references with their actual language; do not add empty translations or label Chinese destinations as English.
- Use relative documentation links without hardcoded GitHub repository addresses or private development branch names so forks and source archives remain usable.
