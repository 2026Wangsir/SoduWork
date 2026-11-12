# Plugin authoring (schemaVersion 1)

[简体中文](plugin-authoring.md) · **English** · [Documentation](README.md)

A SoduWork plugin is a portable capability package containing instructions, skills, MCP connections, tools, permissions, and an optional workflow. Source examples live in `hub-backend/plugins/*.json`.

Application authors can use the built-in application developer from Applications → Add → Develop application. Application drafts use root `template: "app"`, real HTTP(S) pages in `ui.contributions` / `workspace.navigation`, and `source.openMode: "workspace"`. Installing local HTML resources does not start a server. The default independent application window is 1280×800 and supports maximize/fullscreen. Versioning and export follow the same plugin lifecycle. See the [application-authoring skill, Chinese](../skills/app-developer/SKILL.md).

A plugin need not be a workflow. Direct instructions, skills, and connectors can run from conversations or tasks. Add a workflow for multiple agents, explicit handoffs, approvals, quality checks, publication, or recovery.

## Core objects

| Object | Role | Change rules |
| --- | --- | --- |
| `PluginVersion` | Capabilities, entry points, optional execution graph | Immutable; change content with a new SemVer |
| `PluginBinding` | Organization/project MCP, secrets, agents, models, Runners | Configurable; analyze compatibility before upgrades |
| `WorkflowRun` | Actual execution, progress, evidence | Persistent; resume at the appropriate failed stage |

Do not hardcode organization URLs, machines, models, or credentials. The package defines a method, binding connects it to an environment, and a run locks versions, routes, context, and evidence.

Lifecycle: author → package → static preflight → quarantine → capability review → binding → real-environment simulation → execution → acceptance and recovery.

## Personal and organization plugins

Personal authoring, import, preflight, install, enable/disable, and deletion occur in the client. Personal plugins are private by default and are not uploaded automatically. Authors may maintain packages in version-controlled source; complex DAGs should remain reviewable in code.

The management UI handles candidate import, quarantine, evaluation, review, publishing, binding, rollback, and audit. It is not the plugin editor.

An author may explicitly upload a personal plugin for all organization members or selected members. Hub repeats preflight and creates an immutable candidate in quarantine. Uploading does not alter the personal copy. First publication from a client signs the package with an Ed25519 key held in system secure storage. A candidate public key may verify that package without becoming trusted. Administrators must compare Key ID and SHA-256 fingerprints, register the publisher explicitly, then independently review and enable the version.

My submissions retains each submitted version and its review history when a newer version is submitted. Each record opens that exact version, including its earlier review decisions and feedback. Unpublishing a listed plugin sends an in-app notice to its publishers and accounts with an active installation. Revoking a version notifies its publishers and accounts with that version installed. Notices are saved with the change and remain available after reconnecting; retrying an unchanged operation does not send another notice. Plugin notices follow the recipient's account and company scope.

- Personal identity is `local:<uuid>`, stored in the current client profile.
- Package definitions contain no passwords, tokens, private keys, or API keys. Organization credentials use Secret References.
- Version audiences are immutable and restricted to active accounts in the organization. Runtime checks repeat visibility validation.
- Discoverability, personal installation, and organization execution binding are separate decisions.
- Organization installation state follows the user's account across clients and pins the accepted version. A new version needs explicit upgrade acceptance.
- Personal disabling/deletion does not remove a published version. Tasks and organization automations remain governed by bindings.

## Package and version format

A `.soduwork-plugin` ZIP contains root `plugin.json`, at most 10 MB and 300 files. Legacy package extensions remain import-compatible. Optional `workflow.json` may hold the workflow.

```json
{
  "schemaVersion": 1,
  "key": "weekly-brief",
  "version": "1.0.0",
  "name": "Weekly brief",
  "description": "Summarize work, outcomes, and risks",
  "author": "Your team",
  "instructions": "Use the week's recorded facts. Do not invent results.",
  "entrypoints": {"conversation": true, "task": true, "automation": false},
  "inputs": [
    {"key": "goal", "type": "textarea", "label": "Goal", "required": true}
  ],
  "capabilities": {
    "skills": [], "mcpServers": [], "secrets": [], "runtime": [], "network": false
  }
}
```

Keys use lowercase letters, digits, and hyphens. Built-in identities use `soduwork/<key>`; organization identities use `org:<org-id>/<key>`. Display names may change without changing stable identity. Keys are unique within a platform or organization; concurrent imports enforce this.

SemVer is mandatory. Different content at the same version is rejected. Entry points permit conversation, task, and automation separately. A direct plugin can omit workflow but must supply instructions, skills, or MCP. Canonical file paths and contents determine SHA-256, independent of ZIP compression order/time. Import does not execute scripts, connect to services, or establish trust.

## Application window configuration

Optional root `appWindow` sits beside name/version:

```json
{
  "appWindow": {
    "width": 1280, "height": 800,
    "minWidth": 480, "minHeight": 360,
    "maxWidth": 2680, "maxHeight": 17800,
    "rules": [{"maxScreenWidth": 1366, "width": "100vw", "height": "100vh"}]
  }
}
```

This is a fragment; retain the other required package fields. Numbers default to px; px/vw/vh are supported. The default window is centered on the main window's display and adapted to available space. 100vw/100vh refer to available logical display area. Maximums limit initial sizing without blocking maximize/fullscreen. Minimums relax on small screens.

At most 12 rules are evaluated top-down; the first matching inclusive screen-width interval applies. Missing dimensions inherit defaults. Changes require a version increment. Existing open windows retain state; reopen to apply new defaults.

## Process identity

Optional root `process` identifies organization workflows before execution:

```json
{
  "process": {
    "enterprise": true,
    "label": "Engineering workflow",
    "route": "Implement → Review → Merge → Deploy",
    "environments": [{"label": "QA example", "scope": "project"}]
  }
}
```

Route is at most 200 characters; environments at most 8; scope is company, department, or project. Older packages containing merge/deploy/deploy_chain nodes infer enterprise identity. This metadata explains the route and target environment without embedding real infrastructure.

The platform generates component, dependency, permission, and entry-point reports from the immutable package. Bindings must not expand the package's declared capability ceiling. Closing an existing entry point is a breaking change; opening another requires review.

## Optional workflow DAG

Use 1–100 nodes, acyclic `dependsOn`, and failure/retry strategies instead of backward edges. Retry limits are at most 5. AI/AI-review timeoutSeconds ranges from 60 to 86400; timeout stops execution, retains evidence, and follows retry policy.

```json
{
  "key": "implement", "type": "ai", "name": "Implement and verify",
  "dependsOn": ["understand"],
  "inputs": [], "outputs": [], "capabilities": {},
  "config": {"timeoutSeconds": 3600},
  "retry": {"maxAttempts": 2}
}
```

| Type | Execution and purpose |
| --- | --- |
| ai | Runner Agent CLI: analysis, implementation, skills/MCP |
| ai_review | Independent review routing; no self-authorization |
| spec | Human requirement baseline |
| human_review | Human business review or acceptance |
| approval | Explicit high-risk authorization |
| quality | Build/test checks in a clean Runner workspace |
| script | Controlled command execution and evidence |
| tool | Trusted Hub tool registry |
| merge | Policy-governed merge through Hub/Runner |
| deploy | Runner deployment to a bound environment |
| deploy_chain | Ordered environment deployment/check/acceptance/rollback |
| validate | Declarative artifact checks |
| condition | Input-based routing |
| publish | Completion and delivery receipt |

## Conversations and task workflows

Conversations and full workflows share message, tool, attachment, and artifact components. Creating a task from a conversation links it to that conversation. Opening a task's conversation neither creates another session nor starts execution. Queued work waits for full execution completion; pending approval is not completion.

Node routing selects agents/models. AI node instructions, tools, and results stream into the original conversation. Human decisions occur there too; missing, revoked, or rejected approval blocks subsequent nodes. Organization inheritance preserves audience and project boundaries.

A slash-plugin conversation trial is not full workflow execution. It must not claim script, approval, merge, or deployment stages ran.

## Explicit context and output contracts

Cross-agent context uses declared outputs and inputs, not hidden terminal history or concatenated chats. A downstream input identifies its source node and output. The runtime records checksums and truncation boundaries.

Output kinds are `file`, `git`, `evidence`, `url`, and `decision`. File output declares an exact relative path. Engineering changes should deliver Git commits rather than substitute archives. Evidence can be checks or captures. Each node may declare at most one decision.

A decision is UTF-8 JSON, even if an immutable historical package used a Markdown extension:

```json
{
  "schemaVersion": 1,
  "outcome": "proceed",
  "reasonCode": "ready",
  "summary": "Evidence and deliverables were checked",
  "evidence": ["Source record matched the delivered result"],
  "nextAction": ""
}
```

Missing verification returns outcome blocked, a non-ready reason, and a concrete nextAction. File-review AI nodes require a decision. Code reviews retain fixed Git revision and code-review.json requirements; neither format replaces human approval.

Bindings define default agents, models, availability policy, and Runner labels, with per-AI-node overrides. Preflight compares requested routing with actual online workers. Strict requires the requested runtime; best-effort may select a permitted alternative. Runs retain expected/actual routing and fallback reasons.

## Minimal capabilities

Declare a package ceiling, then explicit minimal per-node subsets. Nodes cannot request undeclared capabilities. Older nodes without capabilities inherit the package declaration for compatibility; new nodes should be explicit.

- Skills are delivered only as needed for the node.
- MCP starts with the node's permitted servers. The organization binding approves individual tools from the actual catalog. Unapproved tools are neither listed nor callable; Agent-global MCP settings cannot bypass Hub/Runner checks.
- Signed per-turn tickets carry invocation budgets. Hub bounds calls, concurrency, catalog reads, and repeated connection failures. Connections also have timeout/response-size budgets enforced before the Agent runtime.
- Runtime facts include files, terminal, repository, browser, office, and computer. Missing capability blocks routing rather than silently falling back to an unsuitable Hub.
- Network is a reviewable declaration and narrows tool policy where supported. Worker network policy can provide stronger isolation.
- Secrets are logical variable names, mapped to enabled same-organization runner-env Secret References. Hub passes names only; values remain on the Runner and are injected only into the node subprocess, outside package, binding, evidence, and logs.

## Command nodes

Quality and script commands execute argv directly without a shell:

```json
{
  "key": "build", "type": "quality", "name": "Build and test",
  "dependsOn": ["implement"],
  "config": {"commands": [
    {"name": "Install", "argv": ["js:install"], "timeoutSeconds": 600},
    {"name": "Build", "argv": ["js:build"], "timeoutSeconds": 600},
    {"name": "Test", "argv": ["js:test"], "timeoutSeconds": 900}
  ]},
  "retry": {"maxAttempts": 2}
}
```

js:install, js:ci, js:build, js:test, and js:type-check resolve the repository's package manager and lockfile. Working directories must remain repository-relative. Quality checks also inspect conflicting lockfiles, runtime output, and unusually large changes.

## Preflight, trust, and evaluation

Static import validates structure, versions, DAGs, commands, references, capability subsets, and sensitive configuration. Outputs form a version-level result contract.

A version may declare at most 20 evaluations, each with instruction, credential-free inputs, criteria, and expectedOutputs. Changing them requires review. Administrators select agents/models/Runner labels and secret references; isolated runs retain immutable cases, actual execution location, sizes, and SHA-256.

Contract checks still require a human acceptance decision. Rerunning a case immediately invalidates its previous conclusion. All declared evaluations must pass before enabling a version. Without evaluations, publishing requires explicit risk acceptance; the catalog distinguishes evaluated from reviewed versions.

Publication evaluation defaults to zero side effects. Prefer file/evidence/decision contracts. Mandatory Git/URL outputs without a dedicated environment producing real evidence block publication; unexecuted is not passed.

Quarantine import does not execute, trust, or bind. Capability review precedes binding simulation against actual repositories, environments, secret references, online workers, and node routes. Startup snapshots lock versions, bindings, configuration, and inputs. Missing configuration can be saved as a draft but blocks execution at the affected stage; resume there after correction.

## Upgrades and recovery

| Upgrade level | Example | Requirement |
| --- | --- | --- |
| safe | Add a node without breaking existing contracts | Pass preflight |
| review | Change prompts/config/dependencies/permissions | Repeat review and simulation |
| breaking | Remove/change nodes or required outputs; change input references; add required inputs | Explicit impact review and confirmation |

Existing runs retain old snapshots. Only explicitly switched bindings use the new version.

Failures distinguish configuration, authorization, infrastructure, contract, upgrade review, quality, and execution. Retry only the current failed node and retain earlier attempts. Fix environment/permission issues at that stage. Rework contract/quality failures under plugin policy. Uncertain AI decisions need human handling. Timeouts retain stop evidence. Each retry creates a separate attempt without replacing logs, routes, context hashes, or evidence.

## Codex and Claude imports

The importer recognizes .codex-plugin/plugin.json and .claude-plugin/plugin.json and maps supported instructions, skills, agents, and real workflows into the immutable model. Hooks, arbitrary binaries, and unsupported components are reported or blocked rather than silently executed. Import success is not full semantic compatibility; inspect preflight and simulate.

## Slash use and automation

A conversation can select enabled personal plugins or visible, trusted, bound organization plugins installed at the accepted version. Hub rechecks organization, audience, trust, binding, and installation. New binding versions remain pending until explicit acceptance. Each message pins its own snapshot; queueing, session changes, and upgrades do not mutate it.

At most three plugins may be selected per turn. Ordinary slash use applies methods and quality criteria without launching scripts, approvals, merges, or deployment. Project ambiguity blocks selection. Bindings, secret values/references, and package paths do not enter the conversation; history displays name, version, and scope.

Personal plugins remain local conversation trials. Full multi-agent workflows, evidence gates, retries, and deployment require reviewed organization versions and bindings.

entrypoints.automation permits scheduling a version. Schedules retain approved immutable binding IDs and ordinary inputs; secrets are injected by reference at execution. Updated local ordinary automation creates a conversation message instead of an extra business task. Explicit organization bindings, remote dispatch, and older-client compatibility retain controlled task execution. Missing/revoked capability or inputs fails explicitly, without falling back to an ordinary Agent.

## Packaging resources

Drafts may declare real templates, examples, scripts, assets, references, and UI resources next to soduwork-plugin-draft.json using relative paths. At most 64 files and 8 MB total are allowed under templates/, examples/, assets/, scripts/, references/, or ui/. Reject traversal, symlinks/junctions, key files, and obvious credentials. Credential detection is not a complete audit.

Importing a JSON draft collects declared neighboring files within its selected directory. Missing or escaping resources fail instead of being omitted. ZIP/plugin imports have a 24 MB input limit while resources retain the 8 MB cap. Updated native file selection requires a main-process restart.

Installed resources retain contents and SHA-256 per version. Portable JSON includes Base64 data; import on another device does not depend on author paths. Changed resources require a version increment. Conversation resources are prepared at .soduwork/plugins/<key>/<resource-digest>/ in the session workspace; copy templates before editing. Modified caches are not silently overwritten.

Uploaded organization packages carry equivalent resources under skills/<key>/. Resource bytes round-trip; this does not promise full external package semantics or byte-identical whole archives. Installation saves files without running scripts. UI resources are not automatically mounted; existing UI contributions follow host permissions. Unsupported workflow nodes block editing rather than becoming AI nodes.

A package contains plugin.json and optionally workflow.json, skills/, and README.md. Import through management Plugin Center, preferably starting from its current schema starter package.

## Local node debugging

Install a personal workflow, then use the conversation's plugin-debug action. Debugging stays in the same conversation without a new task or window.

Confirm plugin/version/public inputs/debug instructions first. Current text, attachments, and pending captures may be supplied. Nodes run in dependency order through the local Runner and supported node-specific agents/models. Organization model/device/skill policy and minimal MCP subsets still apply.

AI output and tools enter the existing message stream. File and decision outputs are verified, including SHA-256 at handoff. Approval cards preview verified artifacts. Relative historical attachments are resolved within their original conversation boundaries. human_review requires the conversation owner's explicit decision. Failure, missing approval, or unknown worker state blocks subsequent nodes and the normal queue.

Retry only the failed node within limits; confirm worker state before stopping. Logs retain fixed versions, attempts, and run IDs. Refresh can reopen debugging; main-process restart needs explicit recovery without redispatching completed nodes. Files live under plugin-debug/<runId>/<node>-<attempt>. Local publish ends debugging without organization upload or publication.

Hosted routes and remote worker labels cannot downgrade to local execution. Git-locked code review still needs organization workflow acceptance. HTML resources are not automatically hosted and unsupported script/deploy nodes do not run silently. Debug-record recovery does not imply persistence of ordinary pending messages; send or save them before quitting.

## H5 applications and settings

Use the public [H5 SDK](../client/sdk/README.md) for chat sends, refresh notifications, exact-origin direct iframes, and explicit conversation/composer capabilities. Business actions provide context; a separate user-facing skill picker is unnecessary.

settings.read/settings.write provide account/application/origin-isolated encrypted JSON settings. Explicit reads of the application's own ukey can restore its own service login. Native application-owned MCP can reference credentialKey:'ukey'; per-turn MCP keeps credentials out of models. Settings credentials are not draft setup, exported package data, or prompts, and do not establish SSO.

## Before publishing

- Keep stable keys and increment SemVer for changed content.
- Give AI nodes clear instructions, bounded timeouts, and minimal capabilities.
- Declare explicit handoffs and typed deliverables; separate implementation from AI review.
- Reserve human gates for business acceptance or high-risk actions.
- Keep environments, machines, ports, models, accounts, and secrets out of package definitions.
- Use argv commands and repository-contained working directories.
- Complete import preflight, real-environment simulation, and upgrade impact review.
- Exercise both success and failure/recovery paths; local debugging alone is not organization-publication acceptance.
