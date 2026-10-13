# Dogfood Follow-through Implementation Plan

> **For agentic workers:** implement in task order with failure-first behavior tests. Preserve the local datastore while the compatibility cause remains unproven.

**Goal:** Close the automatic evidence-query and follow-on gaps found in the installed v0.4.0 dogfood run, make authored graph failures actionable, improve native Clef setup guidance, and establish a safe disposition for the existing schema-14 user datastore incident.

**Architecture:** Resolve automatic provider selection from the accepted request's frozen catalogue and per-evaluation choices. Evidence reads project the provider frozen for each evaluation rather than infer a run-wide provider. Follow-on inspection and acceptance use the same selection policy, source snapshots, fit checks, and provider locks as polls and journeys; accepted choices are persisted before worker dispatch. Graph diagnostics retain field paths and include only bounded domain validation messages. Clef setup docs point users to the Cloudflare account-ID dashboard location and distinguish a saved token from a complete provider configuration. Datastore work remains read-only unless a narrowly validated, backup-preserving repair can be established from evidence.

**Tech Stack:** TypeScript, Zod, SQLite, Node test runner, CLI/MCP, generated self-contained plugin.

**Inputs:** Dogfood report at `Z:/_agent-scratch/portfolio/sheg04-dogfood/feedback.md`; approved visual-studies specification; current `develop` at `03f58b5`.

## Global constraints

- Do not reset, mutate, or reseal the existing default datastore during investigation. Do not infer provider-setting provenance from current rows; there is no settings audit table.
- Do not use live inference. The fixes are tested with deterministic providers and SQLite fixtures.
- Preserve old explicit-provider requests, exact source evaluation/context handles, frozen provider catalogue, comparison locks, and no-substitution semantics.
- Keep evidence provenance evaluation-specific for mixed-provider runs, including provider, model, and endpoint from the frozen selection.
- Preserve safe CLI error boundaries. Never return stack traces, file contents, credentials, or full request data.
- Add tests for demonstrated behavior gaps and prove each new behavior test fails before implementation.
- Increment the package to the next unique 0.4.0 development identity for the integration PR; regenerate package artifacts from canonical source.

## Task 1: Mixed-provider evidence query provenance

**Files:** `src/infrastructure/sqlite/evidence-query.ts`, query schemas/types as needed, and focused evidence-query tests.

- [ ] Add a failing public-store query test for an answered automatic journey evaluation whose `providerSelection` resolves through its frozen catalogue. Assert exact evaluation provider/model/endpoint, while an adjacent evaluation can resolve to a different provider.
- [ ] Trace stored `provider_selection_json`, attempt execution evidence, and legacy explicit request fields. Prefer the frozen per-evaluation selection; retain explicit run-level behavior for older and pinned runs.
- [ ] Remove the run-wide `requireExplicitProvider` assumption from automatic evidence projection. Reject missing or inconsistent frozen provider provenance as bounded data-integrity errors rather than inventing a provider.
- [ ] Verify mapped selected visual material stays present and no image bytes or unrelated sibling provenance are exposed.

## Task 2: Automatic follow-on inspection and admission

**Files:** `src/application/run-service.ts`, `src/application/run-inspection.ts`, provider-selection/application helpers, `src/application/question-worker.ts` only if frozen choice resolution requires it, and focused follow-on tests.

- [ ] Add failing tests proving automatic follow-on inspection resolves providers from settings, uses the exact selected source contexts, and refuses when no ready provider fits.
- [ ] Add a failing acceptance/worker test proving the chosen provider configuration and choice evidence are frozen before dispatch and survive reopening the store.
- [ ] Route follow-ons through common automatic candidate selection and fit admission without calling a provider during inspection.
- [ ] Preserve explicit provider selection and prevent silent comparison-lock drift. Automatic follow-on comparison locks that cannot be tied to unique source contexts must fail inspection with a clear explanation; do not silently ignore them or substitute after acceptance/provider failure.
- [ ] Assert stale selection fingerprints and source changes between inspection and acceptance are refused, and physical call accounting remains unchanged.

## Task 3: Useful authored-graph validation diagnostics

**Files:** domain journey/study schema validation owner, `src/application/run-service.ts` request normalization or CLI mapping only as needed, and `test/cli.test.ts` plus the relevant domain tests.

- [ ] Add failing CLI cases for duplicate item/task/node IDs and Score intervals missing a route. Assert field paths and the safe domain cause are both present.
- [ ] Trace the parse boundary that currently collapses errors to broad `journey.presentation` paths; retain existing path context while formatting domain issues from `safeParse`.
- [ ] Ensure thrown exceptions and arbitrary input text are not echoed. Keep errors bounded and stable enough for an agent to repair authored input.

## Task 4: Cloudflare account setup guidance

**Reader and destination:** A Sheg user configuring native Clef; update `docs/providers/clef.md` and its linked agent-facing `skills/stimulus-response-polling/references/native-clef.md`.

- [ ] Explain that a token can be saved while Clef remains unusable until a Cloudflare account ID is configured.
- [ ] Explain the dashboard navigation and the visible “Copy account ID” action, and show the provider-settings field where that ID is entered.
- [ ] Link the provider settings contract and retain the existing credential separation and permissions guidance.
- [ ] Check wording against actual CLI/MCP setup/status output; do not promise account-discovery behavior when the account-list API returns no entries.

## Task 5: Existing default-store incident disposition

**Files:** Read-only investigation first. Only change compatibility diagnostics or a recovery command if the repository already offers an auditable, non-destructive route supported by evidence.

- [ ] Confirm current database checksum, schema fingerprint, integrity, and migration SQL identity through read-only inspection. Do not inspect credentials or respondent payloads.
- [ ] Search available source history, migration assets, settings write paths, and retained logs/backups for the recorded v14 checksum and placeholder catalogue values.
- [ ] State whether each value's provenance is provable. If there is no audit event or matching migration source, record that source cannot attribute the past write; do not claim the likely actor as fact.
- [ ] If a safe resolution cannot be proven, improve only the compatibility error/help text to tell the user what evidence to preserve and how to proceed without reset or checksum replacement. Leave the database untouched and report the remaining manual recovery requirement.
- [ ] Add a read-only fixture test for the precise mismatch diagnostic only if its behavior is changed.

## Task 6: Full verification and packaging

- [ ] Run focused tests for the four behavior fixes and failure-first checks.
- [ ] Run `npm run verify`, `npm run build`, and the copied-plugin tests/package validation appropriate to changed sources and guidance.
- [ ] Review the final diff against source ownership and compatibility constraints; confirm generated files match canonical source.
- [ ] Publish a PR into `develop`, verify CI on its exact head, and update this roadmap row with the merged result only after integration.

