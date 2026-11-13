# SoduWork adaptations

Upstream content is pinned as described in [UPSTREAM.md](UPSTREAM.md). Local changes recorded on 2026-11-13:

- Add a runtime note to `SKILL.md` preserving user authorization and repository instructions and providing a truthful sequential fallback when sub-agents are unavailable.
- Omit upstream `agents/openai.yaml`, which is host-specific discovery metadata and is not part of the SoduWork skill package format.
- Retain the complete original MIT license and add English provenance and adaptation records.
- Preserve unrelated user changes and stage only the resolved operation's files. Respect a user request to stop or abort and the authorization boundary for pushes, published history, and protected branches.

All remaining method text and supporting files retain the pinned upstream content.
