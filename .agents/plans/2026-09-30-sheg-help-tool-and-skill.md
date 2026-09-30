# Name and Document the MCP Help Endpoint

**Status:** in-progress
**Scope:** Rename `poll_capabilities` to `sheg_help` and document it as optional MCP quick help, while keeping the skills as Sheg's primary agent guidance.

## Decisions

- The tool is help/discovery, not a study operation or provider-capability probe.
- Agents with the Sheg skills should follow those skills directly; MCP-only clients may call `sheg_help` for a compact structured overview.
- The tool must say that it returns static help and makes no provider or inference call.

## Tasks

- [ ] Add an MCP test for the `sheg_help` tool name and response; assert the former `poll_capabilities` name is absent and the call does not contact a provider.
- [ ] Rename the MCP endpoint and describe its static help semantics accurately.
- [ ] Update the study-design and stimulus-response-polling skills/reference table so the endpoint is optional MCP help, not a required discovery step.
- [ ] Run focused MCP tests, regenerate `dist`, and verify through the staged repository gate.
- [ ] Mark this plan `completed-awaiting-retirement`, push the PR update, and inspect the resulting PR state.

## Exit criteria

- `sheg_help` is clearly named and documented as a static MCP help endpoint.
- Skill-first guidance stays primary and does not require help-tool calls when skill context is available.
- Focused and complete verification pass.
