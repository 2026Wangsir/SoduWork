# SoduWork adaptations

Upstream content is pinned as described in [UPSTREAM.md](UPSTREAM.md). Local changes recorded on 2026-11-13:

- Add a runtime note to `SKILL.md` preserving user authorization and repository instructions and providing a truthful sequential fallback when sub-agents are unavailable.
- Omit upstream `agents/openai.yaml`, which is host-specific discovery metadata and is not part of the SoduWork skill package format.
- Retain the complete original MIT license and add English provenance and adaptation records.
- Replace the host-specific Skill-tool calls with local references to the interview and domain-modeling methods. Bundle both methods, including the domain-modeling format guides, for independent skill exports.
- In bundled references, remove skill-discovery front matter, rename the entry document to `GUIDE.md`, preserve the runtime note, and adjust links to that entry so the package is self-contained without duplicate skill registrations.

All remaining method text and supporting files retain the pinned upstream content.
