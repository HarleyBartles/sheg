# Jev Provider Routes and Secure Credentials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users deliberately run Jev through TypeSafe or OpenRouter with Windows Credential Manager credentials, bounded physical attempts, and optional per-decision cost evidence.

**Architecture:** Share one normalized Jev route configuration and one credential-store boundary across execution and admission checks. Replace billing semantics with an attempt ledger, migrate saved runs without losing their call history, and keep typed provider responses and route identity explicit.

**Tech Stack:** Node.js 24, TypeScript, Zod, fetch, Windows Credential Manager native APIs through a bundled PowerShell helper, existing Node behavior tests and esbuild packaging.

**Spec:** [Jev provider routes and call limits](../specs/2026-09-30-jev-provider-routes.md), [SHEG-3](https://linear.app/harleys-workspace/issue/SHEG-3/support-native-typesafe-and-openrouter-jev-routes).

**Status:** Draft implementation plan for human review. Writing this plan does not authorize implementation or mark the spec approved.

**Execution Strategy:** `executing-plans`. Route schemas, provider results, attempt settlement, checkpoints, and reports share contracts and need sequential integration. Keeping their implementation context inline reduces repeated reconstruction of migration and recovery behavior.

## Global Constraints

- Follow `AGENTS.md`, `.agents/doctrine/repo-runbook-policy.md`, the implementing and PR runbooks, and the Gitflow and SemVer playbooks. Guidance is Sheg-owned; add no AOM subscription.
- Use the existing `Z:\_agent-worktrees\sheg\codex\jev-auth-modes` worktree and `codex/jev-auth-modes` branch. The planning base is `origin/develop` at `3955863a0a69ab93d377bcbd408b3e6f57efc68d`. Preserve all existing work; refresh the base before approved implementation.
- Feature PR targets `develop` and may be squash merged. Keep package.json, both root package-lock.json version fields, and plugin.json aligned at `0.1.0`.
- No release tag or release publication in this slice. `release/0.2.0`, promotion to `main`, and the first GitHub Release are separate work after SHEG-3 merges.
- Windows only for secure credentials. No Jev environment-variable authentication, import, fallback, key-source override, SDK dependency, or route fallback.
- Secret entry occurs outside chat and MCP parameters. Never put a key in command arguments, environment variables, logs, reports, checkpoints, temporary files, or manifests.
- Preserve local Laya and graph `maxDecisions`. Preserve typed Choice, Score, and Noul behavior, replay, cancellation, and concurrent execution.
- `maxCalls` bounds physical attempts, including retries. No USD limits, cumulative billing ledger, charge reconciliation, or spend-based resume block.
- Costs are optional per-decision evidence, with reported or estimated provenance. Unknown rates or required token counts yield no estimate.
- Native model context limits require provider evidence. Unknown fit prevents paid inference; do not transfer OpenRouter's 32,768-token assumption to TypeSafe.
- Edit authoritative sources; regenerate `dist/` and skill assets using existing commands. Run `npm run verify` before feature publication.
- Extend responsibility-owned behavior tests for genuine behavioral changes; avoid tests that merely match source text or reproduce implementation logic.

## Review Focus

- Missing vault entry with environment variables present must still fail before fetch (Tasks 1 and 2).
- Concurrent attempts, interrupted reservations, and retries must never increase the remaining allowance or exceed the cap (Tasks 2 and 3).
- Legacy format 2 and current format 3 checkpoints must preserve source validation, replay, call counts, and explicit model/endpoint settings (Task 3).
- Unknown native context limits and model aliases must not acquire invented fit or price evidence (Task 2).
- Credential replacement must preserve resume identity; route or endpoint changes must invalidate it (Task 3).

## Source Map and Shared Interfaces

Create these focused source units:

- `src/providers/jev/config.ts`: strict normalized route configuration, defaults, and target names, shared by all input schemas.
- `src/providers/jev/model-metadata.ts`: model/route context and price evidence, including source URL and verification date.
- `src/infrastructure/credentials/windows.ts`: bounded, internal vault lookup and safe availability status.
- `src/infrastructure/credentials/windows-credential.ps1`: native CredReadW/CredWriteW/CredDeleteW operations and interactive no-echo setup.
- `src/domain/attempt-ledger.ts`: atomic call reservations and settlement; replaces `src/domain/budget-ledger.ts`.
- `src/infrastructure/checkpoint-migration.ts`: versioned legacy normalization, separate from filesystem persistence.

Use these interfaces consistently; equivalent naming changes must be applied to every consumer in the same task:

```ts
type JevRoute = 'openrouter' | 'typesafe';
type CredentialAvailability = 'available' | 'missing' | 'unavailable';
interface JevCredentialStore {
  availability(route: JevRoute): Promise<CredentialAvailability>;
  readForAuthentication(route: JevRoute): Promise<string>;
}
type CostEvidence = {
  amountUsd: number;
  basis: 'provider-reported' | 'published-rate-estimate';
};
type AttemptSnapshot = {
  maxCalls: number; usedCalls: number;
  reservedCalls: number; remainingCalls: number;
};
type AttemptReservation = { id: string; maxAttempts: number };
```

`jevConfigSchema` yields route, model, effective endpoint, and timeoutMs. Route defaults to OpenRouter only when absent; reject `keyEnv` and any key-source field. Credential targets are `Sheg/Jev/TypeSafe` and `Sheg/Jev/OpenRouter`. Only provider authentication consumes secret-bearing lookup output; admission checks consume availability.

## Task 1: Secure Vault Boundary and Interactive Setup

**Files:** Create the three credential/config files named above; create `test/windows-credentials.test.ts` and `test/jev-config.test.ts`; modify `scripts/build.ts` and `test/build.test.ts` to bundle and locate the helper.

**Consumes:** Selected Jev route, Windows native credential APIs, existing plugin build layout.

**Produces:** `jevConfigSchema`, `JevRoute`, `JevCredentialStore`, default Windows implementation, and a packaged helper supporting setup, status, remove, and internal read operations.

- [ ] After human approval and before implementation, refresh `origin/develop` while preserving the draft files, report branch/base/status, and commit the approved spec and plan. Retire the completed SHEG-4 plan in the first implementation commit through `/completing-planning-artifacts`, preserving its durable workflow records.
- [ ] Add behavior cases for route defaults, strict rejection of key fields, and explicit endpoint/model preservation. Use current OpenRouter defaults from the live adapter/config examples; TypeSafe defaults to `jev-latest` and `https://api.typesafe.ai/v1/systemone`.
- [ ] Add Windows tests using unique fixture target names, injected only through the test boundary. Save, read, replace, remove, verify missing status, and clean up in `finally`. Never write to the user's production targets in tests. Cover native write rejection and unavailable helper with injected failures.
- [ ] Implement the helper with native API return checking, Unicode credential targets, current-user persistence, and native buffer release. Setup uses `Read-Host -AsSecureString`; clear allocated unmanaged secret buffers in `finally`.
- [ ] Implement Node lookup via `spawn` with a fixed helper path, fixed operation, and allowlisted route. No shell interpolation. Capture secret read output only on the internal pipe, never in errors or logs; status returns only safe availability. Bound execution time and output; treat malformed output and native errors as safe failures.
- [ ] Expose interactive setup/remove as a local helper invocation with no secret argument. Keep its prompts out of the internal read operation. Setup failure stops setup; unsupported platforms report unavailable secure storage.
- [ ] Copy the helper into `dist/credentials/` through `buildPlugin`, and resolve it correctly from both source tests and bundled entrypoints. Extend the existing build behavior test to exercise the copied helper's safe status operation rather than just checking a filename.
- [ ] Run focused tests and typecheck; commit this task only when the existing suite remains valid.

```powershell
node --import tsx --test test/jev-config.test.ts test/windows-credentials.test.ts test/build.test.ts
npm run typecheck
```

**Exit:** A fake key survives vault replacement/read/removal, safe status contains no key, and the packaged helper works without a source checkout. No real key has been read or changed during tests.

## Task 2: Route-Aware Fetch and Shared Admission Checks

**Files:** Modify `src/providers/jev.ts`, `src/application/preflight.ts`, `src/application/packet-sizing.ts`, `src/application/run-manager.ts`, `src/entrypoints/mcp.ts`, and `src/infrastructure/checkpoint-store.ts`; create model metadata; extend `test/jev.test.ts`, `test/application-preflight.test.ts`, `test/packet-sizing.test.ts`, and `test/prelaunch.test.ts`.

**Consumes:** Task 1 route schema and credential-store boundary; existing domain result contract remains until Task 3.

**Produces:** Shared route handling, vault-only execution/admission, route-specific context evidence, and validated native response parsing.

- [ ] Retrieve official TypeSafe and OpenRouter wire/model documentation before changing adapter parsing. Record supported response shapes, native context limits, and published rate source/date in `docs/providers/jev.md` and maintained metadata. Non-secret model discovery may supplement documentation. If a native context limit remains unverified, keep native admission unavailable and report the limitation; never invent a limit to make a test pass.
- [ ] Replace duplicated Jev input objects with the shared schema. Update old ordinary configs/examples to remove key fields; only legacy checkpoint readers may consume obsolete `keyEnv` inertly. Inject the same store into preflight, packet sizing, run startup, and Jev provider construction.
- [ ] Update authentication and missing-key tests to use an injected vault. Prove that a set fake environment variable cannot authenticate a missing entry, and that the other route's available entry does not cause fallback. Verify rejected admission produces zero fetch attempts.
- [ ] Add fetch fixtures for both routes and each typed question. Check endpoint, model, selected authorization value, answer validation, served model, token counts, HTTP errors, malformed JSON, and safe errors. Do not echo authorization in test diagnostics.
- [ ] Make context measurement route/model-specific. Unknown metadata produces unavailable fit without a fabricated context limit. Preserve existing OpenRouter fit behavior for its verified model and explicit settings.
- [ ] Preserve the current one-attempt worker policy. The adapter may retry only inside its supplied `maxAttempts`; test a transient failure followed by success and exhaustion with exact fetch counts. Any future larger worker allowance must reserve the same count before dispatch, never hide retries inside an SDK.
- [ ] Keep this commit buildable: TypeSafe may still hit the old missing-cost restriction until Task 3 removes billing from the result contract. Mark that transitional behavior in commit evidence; do not publish the feature at this boundary.
- [ ] Run the focused tests, regenerate build output as needed for the hooked commit, and commit the route/auth integration.

```powershell
node --import tsx --test test/jev.test.ts test/application-preflight.test.ts test/packet-sizing.test.ts test/prelaunch.test.ts
npm run typecheck
```

**Exit:** Route selection, vault resolution, and fit checks agree across all consumers; fake environment keys cannot enable a request. Native no-cost acceptance is completed in Task 3.

## Task 3: Attempt-Only Execution, Cost Evidence, and Durable Migration

**Files:** Create attempt ledger and checkpoint migration; replace `src/domain/budget-ledger.ts`; modify `src/domain/decision/decision.ts`, `src/domain/decision/validate.ts`, `src/providers/jev.ts`, `src/providers/laya.ts`, `src/application/worker.ts`, `src/application/run-manager.ts`, `src/application/reports.ts`, `src/infrastructure/checkpoint-store.ts`, `src/infrastructure/identity.ts`, `src/entrypoints/cli.ts`, and `src/entrypoints/mcp.ts`. Extend `test/budget.test.ts`, `test/decision.test.ts`, `test/jobs.test.ts`, `test/identity.test.ts`, `test/report.test.ts`, `test/jev.test.ts`, `test/laya.test.ts`, `test/cli.test.ts`, and `test/mcp.test.ts`.

**Consumes:** Route-normalized configuration and vault-backed provider; existing source/choice replay fingerprint helpers and process locks.

**Produces:** Checkpoint format 4, attempt-only worker/recovery, optional `cost` evidence in decision results, and CLI/MCP/report contracts with no reconciliation or cumulative USD state.

This is one integrated contract change: result validation, provider errors, ledger settlement, persistence, reports, and entrypoints must land together. Do not commit an intermediate tree that cannot compile or resume a run.

- [ ] Replace ledger behavior tests with reservation/settlement cases: simultaneous reservations at capacity, zero-attempt release, partial reservation usage, failed attempt usage, duplicate/tampered settlement rejection, and interrupted reservation consumption. Assert `remainingCalls = maxCalls - usedCalls - reservedCalls` and reject invalid restored snapshots instead of increasing allowance.
- [ ] Implement `AttemptLedger.reserve(maxAttempts)`, `settle(reservation, { attempts })`, `snapshot()`, `restore(snapshot)`, and `consumeInterruptedReservations()`. Preserve serialized mutation and unique reservations. Remove all money and billing-block fields and methods.
- [ ] Replace decision charge fields with optional `cost: CostEvidence`; validate finite nonnegative amount and known basis. Jev success without cost is valid. Prefer provider cost when present; otherwise estimate only from complete required token counts and applicable sourced rates. Laya emits no cost by default. Preserve attempt evidence on provider errors without billing language.
- [ ] Make worker reserve/persist before dispatch, settle observed attempts, and release unused allowance on cancellation before fetch. Interrupted reservations consume allowance once. Keep one attempt per worker decision and adapter retries bounded by an explicitly reserved allowance. Extend concurrent fake-provider and resume tests to observe actual invocation counts.
- [ ] Add a format-4 writer and explicit readers for formats 2 and 3. Live code currently writes 3 and reads 2, so migrating only 2 would strand the current installed user's runs. Normalize missing route to OpenRouter, preserve model/endpoint, strip keyEnv and obsolete money fields, retain used counts, consume reserved counts, and clear billing-only blocks.
- [ ] Convert saved `billed` amounts into provider-reported per-decision cost; remove charge states without amounts. Preserve typed journey history and legacy choice events/request replay. Use explicit legacy schemas rather than accepting arbitrary old fields in active schemas.
- [ ] Before replacing a legacy fingerprint, validate unchanged study inputs using the old fingerprint rules and stored hashes. Recompute the new execution identity from normalized saved settings and verified current inputs. Persist migration atomically under the run lock before further mutation; concurrent reads must not migrate twice or reset allowance.
- [ ] Include route, model, and effective endpoint in new Jev identity. Add tests for route/endpoint change rejection and key rotation stability. Do not include key material, vault source, target, or environment names in identity. Preserve Laya identity behavior.
- [ ] Remove spend fields and projections from run config, preflight bounds, status, and reports. Remove `reconcileRun`, CLI `reconcile`, and MCP `poll_reconcile` together. Reports preserve per-decision provenance without summing USD. Update fixtures to current contracts, retaining explicit legacy fixtures only in migration coverage.
- [ ] Run focused behavior tests and typecheck. Commit the entire contract transition as a coherent unit after regeneration and the normal hooked gate.

```powershell
node --import tsx --test test/budget.test.ts test/decision.test.ts test/jobs.test.ts test/identity.test.ts test/report.test.ts test/jev.test.ts test/laya.test.ts test/cli.test.ts test/mcp.test.ts
npm run typecheck
```

**Exit:** Both legacy formats resume without billing reconciliation while retaining allowance and source checks; both routes accept valid no-cost answers; concurrent and retry attempts remain capped; local Laya works.

## Task 4: Agent Onboarding, Documentation, and Architecture Records

**Files:** Modify `README.md`, `docs/providers/jev.md`, `docs/reference/data-contracts.md`, `skills/stimulus-response-polling/SKILL.md`, its `references/run-and-recovery.md` and `references/interpret-results.md`, and `skills/study-design/references/packet-budgeting.md`. Update related examples found through the scoped search below. Create ADRs using `docs/decisions/template.md` and update the index.

**Consumes:** Working helper, route defaults, attempt/report/checkpoint contracts from Tasks 1-3.

**Produces:** Copyable secure setup, optional onboarding, accurate recovery guidance, and durable decisions.

- [ ] Describe connect TypeSafe, connect OpenRouter, or skip. Provide copyable PowerShell helper invocation with no key argument; explain replace/remove and reconnect after skipping. Local Laya and installation remain usable when setup is deferred.
- [ ] Instruct agents to relay commands or open a user-visible interactive terminal when available. The user pastes into the no-echo prompt; agents never ask for chat paste or invoke a key-bearing MCP argument. Do not claim an installer secret dialog exists.
- [ ] Document Windows Credential Manager targets, availability/errors, deliberate route selection, route defaults, optional cost provenance, maxCalls, and checkpoint recovery. Explicitly defer macOS/Linux and retain the spec's local/repo-marketplace distribution boundary.
- [ ] Record consequential choices as separate ADRs for route/identity, Windows vault-only credentials, and attempt limiting versus provider billing, following the repository's one-decision-per-ADR rule. Supersede any affected accepted decision rather than rewriting its history; link the new records in the index.
- [ ] Search active source, examples, and guidance for obsolete setup/accounting language. Remove active references; retain clearly labeled historical ADR/legacy migration references where needed.

```powershell
rg -n 'keyEnv|maxUsd|maxPerCallUsd|poll_reconcile|unpriced|chargeStatus|chargeUsd|OPENROUTER_API_KEY|TYPESAFE_API_KEY' src test README.md docs skills
```

**Exit:** Users can connect either key securely or defer, choose a route, and understand calls/cost evidence without spend-cap or reconciliation instructions.

## Task 5: Integrated Windows Proof and Feature PR

**Files:** Extend `test/windows-credentials.test.ts`, `test/prelaunch.test.ts`, `test/build.test.ts`, and existing ownership tests only where integration gaps remain; regenerate `dist/` and skill assets through source commands. Update this plan's execution evidence and status at handoff.

**Consumes:** Complete implementation and guidance, approved spec, Gitflow feature branch.

**Produces:** Verified feature PR against `develop` with reproducible evidence; no release artifact publication.

- [ ] Prove with a unique fake vault credential that packaged preflight and the adapter use the vault. With that entry removed and a fake env key set, prove startup fails before fetch. Restore the test environment and delete only fixture targets in `finally`.
- [ ] Run end-to-end fake-provider studies across start/status/report/resume, current and legacy checkpoints, and a partial run at its attempt ceiling. Check saved artifacts and safe errors for accidental secret exposure using fixtures, never real credentials.
- [ ] Regenerate source-derived outputs and run the required gate. Do not hand-edit dist or generated schema assets. Avoid repeating the full gate immediately around a successful hooked commit unless a new change justifies it.

```powershell
npm ci
npm run contracts:build
npm run build
npm run verify
```

- [ ] Check package.json, both root lockfile version values, and plugin.json remain `0.1.0`. Inspect the complete diff and generated-output explanation. Use a fresh whole-branch review when authorized and available; correct findings and verify the affected behavior.
- [ ] For the user's existing installation, run safe availability checks for both production targets. If verified native context metadata permits admission, complete a bounded Jev request using the vault while environment variables remain in place, without inspecting those variables or emitting credentials. Observe the same paid-run approval requirement used by Sheg; fixture tests require no paid request. Report any blocked live proof accurately.
- [ ] Commit completed implementation through the normal pre-commit hook, push the feature branch, and open a reviewable feature PR with base `develop`. Include SHEG-3, final SHA, tests, vault/route/migration proof, and limitations. Do not merge or prepare a release within this execution slice.
- [ ] Mark the plan `completed-awaiting-retirement` once the requested implementation and PR handoff are complete. Record subsequent human approval/merge and release preparation as follow-on actions, not unfinished execution tasks.

**Exit:** The feature PR targets develop, its verification evidence is current, versions are unchanged, and the human can review the complete implementation. If native fit evidence or paid-run approval is absent, report precisely which live proof remains unavailable.

## Acceptance Coverage

| Spec criterion | Owning tasks |
| --- | --- |
| 1: Secure onboarding or deferral | 1, 4, 5 |
| 2: Explicit routes and strict vault-only config | 1, 2 |
| 3: Shared lookup and safe missing/unreadable failure | 1, 2, 5 |
| 4: Windows vault integration with no env fallback | 1, 2, 5 |
| 5: Both fetch routes and optional cost | 2, 3 |
| 6: Reported/estimated evidence without totals | 2, 3, 4 |
| 7: Counted physical attempts and logical bounds | 2, 3, 5 |
| 8: Identity and legacy recovery without accounting | 3, 5 |
| 9: Entry points, docs, and ADR alignment | 3, 4 |
| 10: Verify before feature publication | 5 |

No implementation has been performed by writing this plan. Record execution evidence only when the relevant commands, native APIs, or GitHub state prove it.
