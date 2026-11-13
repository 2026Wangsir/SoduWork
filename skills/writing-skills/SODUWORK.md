# SoduWork runtime adaptation

This package retains the pinned upstream workflow and maps it to SoduWork's delivered skills and the tools exposed by the selected executor. Apply these integration rules before the upstream examples.

- Use only tools actually available in this session. Names such as `Skill`, `TodoWrite`, `Task`, and `Agent` describe upstream capabilities, not tools this package installs. Read the delivered `SKILL.md` with the executor's file-reading tool when no skill-invocation tool exists. Keep a Markdown checklist when no task-list tool exists.
- Names such as `superpowers:writing-plans` refer to the catalog skill `writing-plans` in SoduWork. Use the catalog's actual delivered path; never assume a global plugin directory or a sibling skill is accessible. If a referenced skill is unavailable, report that limitation. Continue with self-contained guidance where possible; request the missing skill through SoduWork when it is essential.
- Dispatch subagents only when the executor exposes a supported delegation tool. Otherwise perform work sequentially, label self-review accurately, and report that independent review was not performed. Do not invent tool calls or launch additional external agents to simulate missing integration.
- Preserve the user's current authorization, repository instructions, worktree ownership, and existing changes. Upstream examples do not authorize commits, pushes, merges, publishing, deleting work, or changing personal executor configuration. Existing explicit instructions take precedence over generic approval menus.
- Resolve resource paths from the directory containing the delivered `SKILL.md`. Invoke shell helpers with `bash /absolute/path/to/helper` and JavaScript helpers with `node /absolute/path/to/helper`, while keeping the shell's working directory in the target repository. Exported skill files may not retain executable permission bits; do not rely on directly executing their paths. Do not edit the installed skill cache to store task artifacts. Shell helpers require Bash; optional JavaScript helpers require Node.js 22 or later. A Windows executor also needs an available Bash runtime before running shell helpers.
- Installing or loading this package does not execute its scripts, install dependencies, enable hooks, or change host configuration. Check tool availability before use and distinguish static inspection, simulated checks, and real execution in the result.

## Local changes

- Added this runtime note and its entry-point link; upstream workflow content otherwise remains intact except for the adjustments listed below.
- Retained the original MIT license and expanded the provenance record to the full upstream commit.
- Preserved the earlier SoduWork replacement of a third-party documentation copy with the independently authored `anthropic-best-practices.md` checklist and official documentation links; the entry point identifies it as a local supplement.
- `render-graphs.js` is optional and requires the external Graphviz `dot` executable. It writes diagrams into the supplied skill directory, so run it only on a writable task copy; do not modify SoduWork's installed skill cache.
- `render-graphs.js` now returns a nonzero exit status when Graphviz fails in either separate or combined rendering mode, so a failed export cannot be reported as successful.
