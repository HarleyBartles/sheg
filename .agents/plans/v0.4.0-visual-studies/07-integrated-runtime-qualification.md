# Integrated Installed-Runtime Qualification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Demonstrate that Sheg's released v0.3.0 store and the complete v0.4 visual-study author journey work together through the self-contained installed plugin across process and connection boundaries.

**Architecture:** This is an integration qualification slice, not deferred product ownership. Reuse the shipped material, provider-selection, matched-fork, follow-on, migration, backup, recovery, CLI/MCP, and package owners. Add only behavior coverage for gaps found between those owners. Preserve actual v0.3.0 evidence while migrating schema 9 forward, then qualify one article journey with reached readers, matched visual/no-visual treatment, Clef image evaluation, compact onward text history, interruption/recovery, and asset/source-run deletion through the copied plugin.

**Tech Stack:** TypeScript, Node test runner, SQLite migrations, built self-contained Sheg plugin, MCP stdio client, deterministic mocked providers, Windows Credential Manager fixture.

**Spec:** `.agents/specs/2026-10-04-v0.4.0-visual-studies.md`, sections 3-10 and 12-13; acceptance criteria 5-9, 11-15. **Roadmap:** `roadmap.md`, Plan 7, based on merged Plan 6 `522ecf0`.

**Execution Strategy:** Execute inline. The goal is an integrated persisted lifecycle through copied package boundaries; splitting its fixture and recovery semantics among independent implementers risks weakening the cross-process assertions or duplicating credential/provider fixtures.

## Global Constraints

- Use only deterministic offline provider fixtures in tests; no live Clef calls, credential values, user portraits, or raw request logs enter the repository.
- Qualify an actual v0.3.0/schema-9 datastore with representative legacy text request, answer, lineage, and attempt evidence. Do not relabel a current-schema database or rewrite the released baseline.
- The installed plugin must run without checkout files, node_modules, or source assets. Exercise MCP and CLI paths where the existing package harness supports them.
- Preserve frozen accepted provider policy and packets when local catalogue/settings change. Resume only eligible incomplete work with its exact packet; never replay a completed prefix or successful branch member.
- Preserve assets required by accepted child studies after source removal and source-run deletion. Compact onward text history carries supplied description and typed choice meaning without pixels.
- Exercise safe schema migration failure and future-schema maintenance access through existing store/recovery owners; preserve database bytes, sidecars, and verified backup evidence.
- Do not add a versioned test receipt, release tag, stable publication, or source change beyond demonstrated integration gaps. The human-approved release process owns publication and tagging.
- Tests must prove reachable behavior and fail for the reason they exist. No source-shape/change-detector assertions or mirrored happy-path tests.

## Review Focus

- Confirm the schema-9 fixture is produced by the released v0.3.0 identity and that legacy rows remain readable after upgrade to the current schema.
- Prove an accepted visual fork remains frozen after a connection changes provider settings and the source import and source run are removed.
- Prove a failed branch can recover after process restart while completed prefix and counterpart provider calls remain unchanged.
- Verify complete-pair and incomplete-pair evidence, asset custody, and compact onward history from saved data rather than transient in-memory results.
- Keep future-schema refusal and failed-migration backup checks scoped to maintenance behavior; do not duplicate existing low-level migration assertions.
- Inspect final copied plugin contents and verify no checkout/runtime dependency leaks into the installed package.

---

## Task 1: Qualify the Released Schema-9 Store

**Files:** Extend `test/sqlite-migrations.test.ts` and/or add a focused fixture under `test/fixtures/datastore/`; update `test/run-store-upgrade.test.ts` only if a genuine maintenance gap appears.

**Consumes:** Released `v0.3.0` tag, baseline migration `migrations/0000_baseline_v9/`, existing schema 9-to-14 migration and backup behavior.

**Produces:** A deterministic representative store originating from v0.3.0 with a text-only request, typed answer, lineage, and attempt accounting. Opening it with the current runtime advances it to schema 14, preserves the historic rows and text-run read behavior, and produces an integrity-checked schema-9 backup. A deliberately failing migration retains the untouched schema-9 source plus verified backup; future-schema maintenance remains available without rewriting bytes.

- [x] **Step 1: Trace the release boundary and choose the fixture form.** Inspect the exact `v0.3.0` tag and its schema-9 store/run-writing path. Prefer a small SQL fixture exported from a real v0.3.0-generated store if deterministic; avoid checking in a binary store or hand-authored fake current schema.
- [x] **Step 2: Add the smallest failing compatibility behavior.** Assert released request/result/lineage/attempt facts via public current-store reads after upgrade, and assert backup integrity and original released evidence. Include an old typed request read or compatible execution through the current package boundary if the existing test surface makes this practical.
- [x] **Step 3: Prove RED against a meaningful failure.** Temporarily bypass migration or legacy decoding in a local patch and show the focused test fails on the lost/unsupported v0.3 behavior; restore the source before continuing.
- [x] **Step 4: Reuse current migration owners and close any real gap.** Do not alter schema-9 migration identity. Add implementation only if the new behavior exposes a defect, then place it in its established owner and add the narrow owner test.
- [x] **Step 5: Run focused migration, store-upgrade, and typed-request tests.** Confirm all pre-release/future-schema preservation cases remain intact.

## Task 2: Qualify the Integrated Installed Visual Journey

**Files:** Extend the nearest existing copied-runtime test in `test/package.test.ts`; update a test helper only if needed for independent process/connection boundaries. Do not add a second parallel provider-mock framework.

**Consumes:** Existing copied Clef visual journey and copied mixed-provider matched-fork recovery fixtures; accepted visual fork and compact-history contracts from Plans 2-5; article recipes from Plan 6.

**Produces:** One end-to-end test through the built, copied, self-contained plugin. It opens the released upgraded store, imports and then removes a source image, runs a text prefix, accepts a matched visual/no-visual branch at the article insertion point, changes the local catalogue after acceptance, interrupts one eligible branch while the counterpart/prefix succeeds, restarts and recovers through a fresh MCP connection, then continues to an onward text step and deletes the source run. Saved child data and reports retain the accepted packet/provider snapshot, visual asset, compact descriptor and typed response, pair denominators, and exact call/replay accounting.

- [x] **Step 1: Map existing package-test coverage to this journey.** Reuse the existing Clef and mixed-fork setup, identify assertions that currently rely on same-run in-memory evidence, and mark only the missing cross-connection/source-custody behavior.
- [x] **Step 2: Add one failing integration assertion per demonstrated gap.** Cover a frozen provider selection despite settings change, retained assets after source import and source-run deletion, no pixel bytes in onward text, no replay of completed prefix/counterpart, and correct pair denominator after recovery.
- [x] **Step 3: Prove RED by breaking the respective boundary behavior.** Use narrow temporary mutations or controlled fixture changes; demonstrate at least the relevant assertion fails because frozen data, custody, or replay semantics are lost. Restore each mutation immediately.
- [x] **Step 4: Implement only a confirmed runtime/package defect.** Preserve domain/application/infrastructure/provider ownership and CLI/MCP shared service semantics. A passing new integration test with existing behavior is the expected result when no defect exists.
- [x] **Step 5: Run the focused copied-package test and inspect persisted records.** Assert external fixture logs show only expected provider calls and do not contain credential material or raw image bytes.

## Task 3: Verify Release Qualification and Hand Off

**Files:** Update `.agents/plans/v0.4.0-visual-studies/roadmap.md` and this plan's checkboxes. Add no permanent qualification report; save any detailed map in task scratch if useful for review.

**Consumes:** Tasks 1-2, the approved spec and all merged Plans 1-6.

**Produces:** Verified schema-9 compatibility, installed-runtime integration, maintained generated/plugin parity, exact `npm run verify`, package validation, fresh whole-branch review, and roadmap handoff status. Plan 7 may complete once these checks pass; stable tagging/publication remains owned by the later approved release workflow.

- [x] **Step 1: Reconcile the acceptance matrix.** Map criteria 5-9, 11-15 to the existing shipped owners and the new integration test. Record unresolved requirement gaps as code work only when demonstrated by a failing behavior test.
- [x] **Step 2: Build and inspect the copied package.** Run `npm run contracts:build`, `npm run build`, `npm run plugin:package -- --validate-only`, and inspect generated parity plus the copied-runtime dependency boundary.
- [x] **Step 3: Run focused tests and `npm run verify`.** Include the released-store upgrade, package integration, recovery, and relevant typed-request tests. Fix any failure through its established owner and rerun the full gate after the final change.
- [x] **Step 4: Review the whole final diff and resolve findings.** Check the spec, source-quality method, boundaries, test value, generated output, user data custody, and version identity. Keep final findings in the working chat/PR, not in a new receipt file.
- [x] **Step 5: Publish and close the Plan 7 cursor.** Refresh `origin/develop`, confirm the unique version remains `0.4.0-dev.11`, rebuild/reverify if stale, commit/push and open the authorized feature PR to `develop`, confirm exact-head CI and merge, fast-forward the canonical checkout, update this roadmap with the merged commit/PR, then retire only this verified clean worktree and merged feature branch.

## Execution Handoff

This plan is approved for inline execution by the active goal. The author has authorized successive JIT plans to be written, executed, merged to `develop`, and cleaned up. Release tagging or stable publication is outside this plan.
