# Plan 3: Unify journey topology and context

> **For agentic workers:** REQUIRED SUB-SKILL: Use `/executing-plans` to execute this plan inline, task by task.

**Goal:** Make sequence shorthand and authored graphs use one journey execution model and give each respondent the same cumulative, branch-safe view of material they have encountered.

**Target development version:** `0.3.0-dev.4`. This is the next intentional develop checkpoint after the merged `0.3.0-dev.3` Plan 2 checkpoint. It is not a stable release and receives no release tag.

**Execution strategy:** Native `executing-plans`, inline. The plan changes one coupled contract across graph normalization, packet compilation, durable resume, preview, preflight, skill guidance, and compiler identity. One implementation context can keep these semantics aligned; independent task delegation would create extra contract handoffs. A fresh whole-branch reviewer remains the final code-review gate.

**Authority:** [Agreed dogfood improvement scope](../../specs/2026-10-02-v0.3.0-dogfood-improvements.md), section 1; [roadmap](roadmap.md); repository runbooks and playbooks.

## Contract

- Treat `sequence` as shorthand for the existing all-items-then-tasks order, compiled into the same linear graph execution used by graph journeys. Explicit linear graphs may interleave expose and ask nodes. The generated terminal outcome is `complete`, preserving the durable sequence-run value.
- At each question, include the exact text of every distinct item exposed so far on that respondent's path, ordered by first exposure. A repeated exposure remains a separate history event but does not duplicate stimulus text in the packet. Do not include unexposed items or material from another branch.
- Keep material scope separate from answer history. Preserve task-level `responseHistory: include | omit`; omitting responses does not erase exposure events or previously encountered material. New dependent-question examples state their response-history choice explicitly.
- Preview, preflight/context measurement, first-turn admission, later execution, recall, and resume must agree on the packet for a route. Context overflow remains explicit; do not trim material or history.
- New admissions use the new packet contract identity. A run admitted under the current develop compiler identity `a39d72d1ba77b0560dac5b7ccedf07b72e80b9d7bc1330679acd9c209e831526` keeps its original compiler identity and v6 packet semantics if it resumes after this change. Already frozen packets remain byte-for-byte unchanged.
- Do not silently reinterpret accepted runs. Keep isolated-passage follow-ons' explicit material and history choices unchanged.

## Non-goals

Do not add per-selection material reuse, lifecycle/failure projection changes, new response types, provider memory claims, automatic context trimming, or a combined material-and-answer history flag. Do not change Portfolio articles or retained pilot data. Do not use paid provider inference or publish/tag a stable release.

## Source map

- `src/domain/study/presentation.ts` and `src/domain/study/arm.ts` define sequence and graph input.
- `src/domain/journey/run.ts`, `preview.ts`, and `packet-walker.ts` currently have separate sequence and graph traversal paths.
- `src/domain/decision/prompt.ts` currently sends all arm items for sequence and only exposures since the last decision for graph.
- `src/application/run-inspection.ts`, `src/application/question-worker.ts`, and `src/infrastructure/run-store.ts` admit, continue, validate, and freeze durable journey turns.
- `test/prompts.test.ts`, `test/journey.test.ts`, `test/journey-preview.test.ts`, `test/packet-walker.test.ts`, `test/application-preflight.test.ts`, `test/run-inspection.test.ts`, `test/run-store.test.ts`, `test/question-worker.test.ts`, and `test/package.test.ts` cover the relevant behavior and integration seams.
- `skills/study-design/` and `skills/stimulus-response-polling/` teach journey setup and packet interpretation. Their `tests/behavior/` files hold scenario inputs and test results and remain excluded from the shipped plugin.
- `docs/decisions/README.md` and a new ADR record the durable topology/context contract.
- `.agents/playbooks/semver-version-alignment.md` and `docs/guides/releases.md` explain how the roadmap assigns deliberate candidate versions.
- `package.json`, both root version fields in `package-lock.json`, `plugin.json`, and generated runtime output must agree on `0.3.0-dev.4`.

## Tasks

### Task 1: Normalize sequence and graph traversal

**Test first:** Add behavior tests proving that a sequence and its equivalent all-items-then-tasks linear graph produce the same ask order, stable node/task mapping, typed response routing, terminal outcome `complete`, and normalized preview nodes/routes. Cover Choice, Score, and Noul routes. Add a linear graph with interleaved exposure and questions to prove that the shorthand does not constrain graph topology. Packet equivalence belongs to Task 2 because that task changes the current sequence/graph context-window difference.

**Implement:** Add one pure journey-topology normalization boundary that compiles sequence shorthand to a deterministic linear graph while preserving graph requests as authored. Route `runJourney`, `advanceJourney`, preview, preflight packet traversal, durable initial exposure creation, and run-store next-target validation through the normalized graph. Keep request schemas and serialized authored presentation readable as `sequence` or `graph`; normalization is an execution projection, not a rewrite of the accepted request.

**Verify:** Run the focused journey, preview, packet-walker, run-store, and durable worker suites. Confirm equivalent topology tests fail before the implementation and pass afterward.

### Task 2: Make encountered material cumulative and consistent

**Test first:** Extend packet tests for a graph that exposes item A, asks, exposes B, asks, then re-exposes A. The later packet contains A then B once each; the exposure history still records both A occurrences. Add a branch test where sibling-only material never appears in another path. Compare corresponding sequence and linear-graph packet state after Task 1 normalized their traversal. Verify `responseHistory: omit` removes prior responses while retaining all encountered material and exposure evidence.

**Implement:** Compile respondent-visible material from exposure events through the current turn, deduplicating by item ID in first-exposure order. Keep trajectory event counts and exposure IDs occurrence-based. Update the prompt contract identity. Ensure `responseHistory` stays independent of material inclusion.

**Verify:** Confirm live packet compilation, preview route contexts, exhaustive preflight packets, and provider fit measurement use the same material ordering and text. Run `test/prompts.test.ts`, `test/journey-preview.test.ts`, `test/packet-walker.test.ts`, `test/application-preflight.test.ts`, and the relevant fit tests.

### Task 3: Preserve frozen compiler semantics across resume

**Test first:** Add durable-run coverage using a dev.3/v6 incomplete graph run. After opening it with the new runtime, resume it and verify its next packet keeps v6's prior exposure window, its earlier saved packets are unchanged, and its original compiler fingerprint remains attached. Add a new-admission assertion for the v7 compiler identity and cumulative packet. Check that run-store transition validation and worker continuation reject unsupported identity drift rather than stamping new packet meaning with an old fingerprint.

**Implement:** Preserve v6's exact prompt-contract hash (`a39d72d1ba77b0560dac5b7ccedf07b72e80b9d7bc1330679acd9c209e831526`) and select the packet-context policy from the stored compiler identity for durable journey continuation and integrity validation. New admissions and preflight use the v7 contract. Keep frozen evaluation packets and fingerprints intact. Fail closed for an unrecognized journey compiler identity if a future turn would otherwise need recompilation.

**Record:** Add an accepted decision record for sequence normalization, cumulative exposure, separate answer history, and versioned resume semantics. Update `docs/decisions/README.md` in the same change.

**Verify:** Run focused run-inspection, run-store, question-worker, identity, resume, and copied-package tests. Confirm stored packet hashes and v6 identities are preserved.

### Task 4: Teach and pressure-test the author guidance

Update the two shipped skills with a concise example that distinguishes topology from material context, explains cumulative previously exposed text, and makes answer-history inclusion explicit on a dependent follow-up. Clarify that sequence is shorthand for a linear graph and that a graph branch cannot expose unseen sibling material. Do not teach authors to edit internal compiler details.

Potential later harness expansions include an immutable hook that records tool use, including subagent tool use, for inspection, and Devin trials whose actor-subagent profile frontmatter disables tool use in that runtime. These are future options only and are not part of this v0.3.0 change.

Version the relevant behavior scenario and evaluator under the owning skill. Before editing the skill wording, run at least five fresh-context guided trials against the current wording; after editing, run at least five against the candidate wording with the same requests and controlled facts at the recorded model settings. Preserve both conditions' prompt digests and outputs, manually inspect every failure or disputed result, and retain the successful existing baseline criteria. The harness prompt must retain `toolUseAudit: "not-captured"`; tool isolation hooks and Devin tool-disabled profiles remain future expansion options only. Keep actor/evaluator traces under skill-owned test assets, outside the plugin package.

**Verify:** Run deterministic scenario-harness tests, validate scenario/evaluator pairing and current guidance hashes, inspect trial inputs and outputs, and verify the candidate ZIP excludes all `tests/behavior/` data.

### Task 5: Set the dev.4 identity and complete the checkpoint

Align `package.json`, both root version fields in `package-lock.json`, and `plugin.json` at `0.3.0-dev.4`. Regenerate derived MCP/runtime output from its source. Update stale static dev.2 wording in `.agents/playbooks/semver-version-alignment.md` and `docs/guides/releases.md` so they describe the roadmap's next intentional checkpoint generically. Record Plan 2's verified merge in the roadmap: PR #13 merged to `develop` at `1d758ceae6db1b7f8245120ddc252354747a5652`, from exact head `ba95909cc13ef82d876f864fcfc49304b3fb5188`; hosted `sheg-verify` passed on that head and the staged gate passed all 352 tests.

**Verify:** Run generated-output checks, `npm run build`, the focused tests named above, `npm run plugin:package -- --validate-only`, and the tracked staged `npm run verify` gate before publication. Build a local no-tag candidate with `npm run plugin:package -- --output <scratch>/sheg-v0.3.0-dev.4.zip`, record file count and SHA-256, and confirm behavior test assets are absent. Do not tag or publish it.

## Readiness and handoff evidence

- Plan 2 merged through [PR #13](https://github.com/HarleyBartles/sheg/pull/13). PR head: `ba95909cc13ef82d876f864fcfc49304b3fb5188`. Squash merge: `1d758ceae6db1b7f8245120ddc252354747a5652`, now the `develop` base for this plan.
- Canonical worktree: `Z:/_agent-worktrees/sheg/codex/v0.3.0-journey-context`, created from `origin/develop` at `1d758ceae6db1b7f8245120ddc252354747a5652`.
- Initial status: clean. Baseline `npm test` passed 352 tests, zero failures or skips on rerun; the copied-MCP independent-question case passed in isolation and in the successful full rerun after one initial suite-level hang.
- Current develop candidate before this plan: `0.3.0-dev.3`. Target merge candidate: `0.3.0-dev.4`.
- The initial Plan 2 merge may advance the prompt contract only through the recorded v6 identity above. Preserve its accepted runs and packet semantics when implementing v7.
