# Bundled skills

[简体中文](README.zh-CN.md) · **English** · [Development guide](../docs/development.en.md)

SoduWork discovers each skill from its `SKILL.md`. The Hub catalog, source
desktop client, and Runner packages use this directory. Localized names in the
desktop presentation catalog do not install a skill or replace its instructions.

## Development catalog

| Source | Skills |
| --- | --- |
| SoduWork | `browser-use`, `computer-use` |
| Matt Pocock | `code-review`, `codebase-design`, `diagnosing-bugs`, `domain-modeling`, `grill-with-docs`, `improve-codebase-architecture`, `prototype`, `resolving-merge-conflicts`, `tdd`, `wizard` |
| Anthropic | `frontend-design` |
| Superpowers | `using-superpowers`, `brainstorming`, `writing-plans`, `executing-plans`, `subagent-driven-development`, `dispatching-parallel-agents`, `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`, `receiving-code-review`, `finishing-a-development-branch`, `using-git-worktrees`, `writing-skills` |

`grilling` is also included as the interviewing method used by the engineering
skills. Required method references are retained inside the consuming packages
so exporting a skill does not silently drop its instructions. Project-owned
office, presentation, task, application, and connector skills remain available.

## Loading and deployment

- Update the Hub source/image and restart it to load this catalog. All bundled
  skills are available to the organization by default. The first policy upgrade
  also reopens existing bundled skills; later administrator opt-outs survive
  restarts, while newly added bundled skills default to available.
- Browser Use, Computer Use, and Office retain their existing baseline
  availability. Personal switches remain independent of organization defaults.
- Skill instructions remain in files. The database stores the versioned access
  policy, not a copy of every skill. Organization defaults do not replace saved
  personal selections or grant additional tool permissions. Imported company
  packages and skills from external directories still require explicit approval;
  an imported package does not inherit a same-named built-in's default access.
- Source desktops read this checkout's skills. Packaged desktops and Runners
  must be rebuilt and updated to receive the new resources. Updating only the
  Hub does not upgrade an already installed desktop's bundled files.
- Skills are instructions and supporting resources. They do not install model
  providers, browser binaries, external CLIs, or subagent capabilities.
  `computer-use` currently operates Windows desktops; its presence does not
  provide native macOS desktop control.
- Imported skill licenses and provenance travel with each package; see
  [third-party skill notices](THIRD-PARTY.md). Host-specific `agents/openai.yaml`
  display metadata and external plugin hooks are not bundled.

With the backend test dependencies installed, run from the repository root:

```sh
python3 -m unittest discover -s hub-backend -p test_bundled_development_skills.py
python3 -m unittest discover -s hub-backend -p test_skill_policy_defaults.py
node tools/check-public-source.cjs
node tools/check-third-party.cjs
```

The regression check exercises Hub discovery, Runner resource discovery, export
round trips, and administrator policy using isolated data. It does not establish
real-model execution quality or acceptance of native installers.
