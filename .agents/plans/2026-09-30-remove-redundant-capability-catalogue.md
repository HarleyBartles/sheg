# Remove the Redundant MCP Capability Catalogue

**Status:** completed-awaiting-retirement
**Scope:** Remove `poll_capabilities`, whose static catalogue duplicates the tool metadata and skill guidance, and trim repeated generic caveats that distract from actionable study and result guidance.

## Decisions

- The MCP tool list already exposes Sheg tool names, descriptions, and input schemas.
- The Sheg skills are the primary agent teaching surface and explain when/how to use the tools.
- Do not add a second tool call returning a static copy of the skill/tool guide.
- State concrete study constraints where they affect decisions; do not repeatedly lecture users that the respondents are simulated or that results are not human research.

## Tasks

- [x] Remove the `poll_capabilities` endpoint and hardcoded catalogue.
- [x] Remove tests and skill/reference entries that instruct agents to call the duplicate catalogue; retain documented tool contracts and usage guidance.
- [x] Remove repeated generic simulation and causal-evidence caveats from active agent guidance and tool instructions; keep specific operational limits and durable decision records.
- [x] Run focused MCP tests, regenerate generated files, and pass the full repository verification.
- [x] Mark this plan `completed-awaiting-retirement`, push the PR update, and inspect the resulting PR state.

## Exit criteria

- No redundant capability-catalogue tool remains.
- Skill guidance remains the primary source for agent workflows; MCP tool metadata remains the machine-discoverable operation list.
- Focused and complete verification pass.
