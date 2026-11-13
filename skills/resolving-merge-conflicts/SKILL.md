---
name: resolving-merge-conflicts
description: "Use when you need to resolve an in-progress git merge/rebase conflict."
---

> SoduWork runtime: follow the user's authorized scope and repository instructions. This method grants no additional tool, network, credential, or publishing permissions. Use the tools actually available in the selected runtime. If sub-agent tools are unavailable, perform the independent passes sequentially and report that limitation; do not claim parallel execution.

1. **See the current state** of the merge/rebase. Check git history, and the conflicting files.

2. **Find the primary sources** for each conflict. Understand deeply why each change was made, and what the original intent was. Read the commit messages, check the PRs, check original issues/tickets.

3. **Resolve each hunk.** Preserve both intents where possible. Where incompatible, pick the one matching the merge's stated goal and note the trade-off. Do **not** invent new behaviour. Continue resolving within the user's authorized goal; if the user asks to stop or abort, preserve their work and follow that instruction.

4. Discover the project's **automated checks** and run them, typically typecheck, then tests, then format. Fix anything the merge broke.

5. **Finish the merge/rebase.** Review the resolved diff, stage only the files belonging to this operation, and follow the repository's commit requirements. Preserve unrelated user changes. If rebasing, continue the already-authorized rebase until all commits are resolved. Do not push, rewrite published history, or update a protected branch without the user's authorization.
