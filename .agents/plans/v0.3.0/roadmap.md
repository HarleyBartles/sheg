# Sheg v0.3.0 release roadmap

Status: approved roadmap; Plans 1-7 are implemented on the v0.3.0 feature branch. Draft PR #11 is open against `develop`; merge and release preparation remain separate. Authority: [approved epic specification](../../specs/2026-10-01-v0.3.0-epic-spec.md). Linear: [release project](https://linear.app/harleys-workspace/project/sheg-v030-richer-studies-and-inspectable-evidence-6d11068a2761).

## Outcome

An agent submits a useful request, leaves the chat, discovers its durable results later, queries relevant evidence, and builds a follow-on using recorded respondent contexts and material. Sheg provides tools and skills; the agent owns relevance and interpretation. The release culminates in the section-three investigation defined in the spec.

## Consecutive plans

Plans 1-7 are delivered and SHEG-7 is Done. SHEG-6's implementation and bounded hosted pilot are complete; the issue remains open through PR #11 merge. Later rows are capability boundaries, not implementation plans. Write each next plan against the delivered code and evidence of its predecessor. A Linear issue may span more than one plan.

| # | Title | Status | Plan File | Commit | PR | Rating | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Submit one-question requests and recall durable results across chats | completed-awaiting-retirement | [Plan 1](01-durable-question-runs.md) | `3d683e4` (`8b0ccb2..3d683e4`) | - | - | SHEG-5 first deliverable; Credential Manager encoding diagnosis and safe malformed-credential response included; full staged gate 219 tests; final review clean. SHEG-5 closed after Plan 2 |
| 2 | Recover, resume, delete and inspect storage through the MCP | completed-awaiting-retirement | [Plan 2](02-resume-delete-storage.md) | `3ecb97f` (`ec3e70a..3ecb97f`) | - | - | SHEG-5 cross-process resume keeps identity and call ceiling; dry-run/transactional deletion; integrity and FK health plus Sheg-managed optimization; copied-package recovery verified; full staged gate 240 tests; whole-plan review clean. SHEG-5 closed after Plans 3-4 |
| 3 | Execute authored journeys with durable respondent turn contexts | completed-awaiting-retirement | [Plan 3](03-durable-journeys.md) | `ace6e98` (`3f31a02..ace6e98`) | - | - | SHEG-7 journey foundation; journey MCP request/details and copied-package kill/resume verified; malformed Credential Manager encoding diagnosis included; staged gate passed 260 tests, lint, typecheck, and generated consistency; final inline review clean. SHEG-7 closed Done after Plan 4 |
| 4 | Query recorded evidence and compose reusable follow-ons | completed-awaiting-retirement | [Plan 4](04-query-and-follow-on-reuse.md) | `e6eabe4`, `11495cc`, `9277057`, `1203e93` (`745094e..1203e93`) | - | - | SHEG-7 query and follow-on accepted and closed Done; exact typed criteria/references, four context modes, SQLite snapshot revalidation, retained lineage after source deletion, MCP `run_query`, and packaged section-three acceptance; full staged gate passed 279 tests, lint, typecheck, and generated consistency. User guidance explains relevance and incomplete-source decisions |
| 5 | Ask independent typed question groups at new or recorded contexts | completed-awaiting-retirement | [Plan 5](05-independent-question-groups.md) | `8915f51`, `a4e9675`, `4ef8d09` (`1046419..4ef8d09`) | - | - | SHEG-6 implementation and authorized OpenRouter pilot delivered: one physical call returned separate Choice/Score/Noul answers under `maxCalls: 1`, with shared context; deletion and isolated-store integrity verified. Offline full gate passed 299 tests, lint, typecheck and generated consistency. SHEG-6 remains open for full release acceptance. |
| 6 | Offer source-linked material choices and reuse their exact evidence | completed-awaiting-retirement | [Plan 6](06-source-linked-material-choices.md) | `fce1524`, `faabf39`, `e484226`, `7c31b2e`, `83d1c8a` (`0416cb5..83d1c8a`) | - | - | SHEG-8; exact authored Choice links, source and computed text digests, selection query projection, retained follow-on lineage, and provider-state privacy. Focused set: 96 tests. Final one-attempt OpenRouter confirmation selected `candidate-setup`, with exact text/source match and no provider-state provenance; source deletion/integrity yielded zero runs. `npm run verify`: 310 tests, lint, typecheck, generated consistency. The empty OS-temp SQLite file remains after safety-blocked cleanup. |
| 7 | Integrate the release workflow and packaged agent guidance | completed-awaiting-retirement | [Plan 7](07-release-integration-and-draft-pr.md) | `b9824f8` plus handoff docs | [Draft PR #11](https://github.com/HarleyBartles/sheg/pull/11) | - | Section-three package acceptance passed; five mixed independent questions use one selected respondent context with history omitted; retained evidence survives source deletion. PR #11 is open Draft against `develop`; merge and release preparation remain separate. |

Commit and PR columns record delivered implementation evidence, not this roadmap's own commit. Ratings are intentionally not persisted: the handoff-gates skill reports readiness in the conversation only. No row is executing or done merely because its plan exists. SHEG-9 and SHEG-10 remain cancelled.

## Capability exits and JIT inputs

### 1. A complete durable one-question path

Inline authored respondent profiles, material and one Choice/Score/Noul question can be inspected and accepted without study/cohort files. SQLite stores frozen inputs and typed results. A detached local worker completes independently of its originating MCP process. Another connection discovers the run, reads its status, request and answers, or requests cancellation. Identified submission retries do not duplicate work. Startup and reads never restart interrupted work.

This first user-value demonstration is delivered at `3d683e4`, reviewed against `origin/develop`, and passed the full staged verification gate. The copied distributable survived termination of its originating MCP; another MCP connection retrieved the answer and an identical submission retry reused its run ID. A killed worker was discovered as interrupted without relaunch. The credential integration fix identifies malformed encodings and tells the agent how to repair them without exposing or rewriting the credential. Plan 2 adds explicit same-run recovery, controlled deletion, and Sheg-owned storage tools.

Next plan uses the actual database schema, worker ownership, failure states, attempt records and cross-process evidence delivered here.

### 2. Orderly lifecycle and storage operations

Explicit resume processes only unfinished work under the remaining original budget. Cancelled/completed work stays stopped. Unknown provider completion is accounted conservatively. Deletion offers dry run, revalidates scope and settles active work first. `run_storage` reports SQLite and foreign-key integrity, byte size, and row counts without exposing paths or SQL; Sheg runs optimization only after integrity checks. No migration layer or automatic startup recovery job.

Plan 2 is delivered at `3ecb97f`. The copied distributable test killed a worker during an in-flight call, discovered the interrupted run from a second MCP, resumed the same run, retained its uncertain attempt, and completed within the original call ceiling. Transaction tests cover active blockers, stale previews, all-or-none behavior, and foreign-key cascades. Full staged verification passed 239 tests, lint, typecheck, and generated consistency. Direct review against SHEG-5 and the epic found no outstanding Critical or Important issues.

Next plan uses these lifecycle rules and the actual persistence boundary rather than introducing a second execution manager for journeys.

### 3. Authored journeys produce reusable recorded state

Finite authored exposure, evaluation and routing operate through the same durable run/worker path as simple questions. Save exact pre-question state for each respondent and turn occurrence, original typed answers, compiler fingerprints, and route outcomes. Preserve conditional exposure and logical journey limits. Ordinary agents do not handcraft manifests. Consolidated inspection exposes authored branches and history choices. Account for matched-arm capabilities and the CLI, and retire redundant file-run execution code where superseded.

This necessary substrate for the section-three query is delivered at `ace6e98`. The MCP accepts inline sequence/graph journeys and returns respondent-local turn, context, exposure, response, route, failure and unreached evidence. A copied distributable survived MCP closure, then a killed worker was resumed through a second MCP without replaying a completed answer; the pending turn kept its identifiers and call ceiling. The staged gate passed 260 tests, lint, typecheck and generated consistency. Inline review found no outstanding Critical or Important finding. Plan 4 completes SHEG-7 with query selectors and follow-on composition. Old formats and tool names carry no compatibility obligation below v1.

### 4. Query, interpret and compose follow-ons

Focused paginated projections expose typed answers/distributions, available confidence, reach/completion denominators, respondents, questions, material and context/provenance. Agents supply explicit criteria and receive input-compatible references. Exact-turn reuse, fresh material, continuation and deliberate context changes have the spec's defaults. Keep selection rationale outside model input.

Inspection of progressing sources reports current matches and completeness; acceptance freezes selection. Retained follow-ons remain usable when their source run is deleted. Extend Plan 2 deletion to the cross-run dependency model here. Use these results and references to design the independent-question contract JIT.

### 5. Independent questions and physical batching

Apply one or several typed questions to the same context, without sibling answers. Sheg chooses supported physical batching or splitting and accounts every physical attempt. Fit admission applies to actual packets. Do not trim input, change providers or make local inference limitations universal. Resolve actual Jev route capabilities from evidence; the existing native admission block is not silently removed. Demonstrate reuse of recorded turns, mixed answers and recovery.

Implemented across `8915f51` (shared attempt evidence), `a4e9675` (execution and recovery), and `4ef8d09` (packaged MCP, agent guidance, and ADR-0021). Offline acceptance includes mixed typed groups, selected-turn follow-ons, query by question ID, local singleton splitting, and copied-package interruption/resume without replaying a saved sibling. `npm run verify` passed all 299 tests, lint, typecheck, and generated consistency. The authorized bounded OpenRouter pilot completed one physical request under `maxCalls: 1` and returned separate Choice, Score, and Noul answers over one context. Sheg deleted the run and the temporary datastore reported integrity `ok` with zero runs remaining.

### 6. Exact offered material evidence

Agents choose candidate units and wording. Answers resolve to exact offered text and stable material identities accepted by the next request. Validate exposure, source identity and no-fit semantics. Selection, ordered Score position judgment and staged threshold crossing remain distinct. Do not add editorial-cut advice or a new scalar response primitive.

Plan 6's final bounded OpenRouter pilot used one physical attempt, returned Choice `setup-excerpt` linked to `candidate-setup`, and preserved the exact text and source provenance. The confirming packet state contained no source metadata; the run was deleted and `run_storage` reported integrity `ok` with zero runs. Two pre-fix packaged-runtime pilots each used one physical attempt and returned `benefit-excerpt` linked to `candidate-benefit`; both exposed the direct-poll state leak and were deleted with healthy zero-run stores. The first bounded attempt's answer and physical-attempt count were not captured because its helper failed during temporary-directory cleanup. The pilot exposed a direct-poll compiler leak before the fix: material provenance was retained in the respondent state because the shared compiler copied extra runtime fields. The compiler now selects only material ID and text, covered by a direct-poll behavior test and the Jev wire contract test. The empty SQLite file remains in its OS temporary directory because the local safety layer blocked file deletion after Sheg verified the zero-run store. A direct-poll behavior test caught the structural provenance leak; the shared compiler now whitelists only ID and exact text. The whole-branch `git diff --check` finding for two EOF blank lines was fixed in Plan 7 commit `b9824f8`.

### 7. Combined release acceptance

Demonstrate the spec's full section-three investigation, including original-state reuse and deliberate history removal, source-linked choices and another follow-on. Canonical skills explain when evidence may matter, how to query it and how to compose the next request. Verify the installed package, database/worker lifetime, tool schemas, current-format integrity and generated assets together.

Prepare the versioned release only after those exits and the applicable release authorization. Feature work targets develop; release preparation owns version alignment, release/0.3.0, main promotion, tagging, ZIP publication and reconciliation. Do not leave human-owned publication/merge approvals as unfinished implementation checkboxes in a completed plan.

Plan 7 extends the copied-package acceptance: query the exact section-three lost- interest selection, use its respondent/context/material references for five independent mixed Choice/Score/Noul questions, omit earlier history, and verify the retained answers/material lineage after source deletion. The local fixture confirms each provider request contains one sibling question over identical respondent state. `node --import tsx --test test/package.test.ts` passed all 6 tests; `npm run verify` passed 310 tests, lint, typecheck and generated consistency; `npm run build` and `git diff --check` passed. The commit hook also passed the 310-test gate for `b9824f8`. The verified zero-run pilot SQLite file remains in the OS temporary directory after safety-blocked filesystem cleanup; Sheg-level deletion and zero-run integrity checks succeeded.

Draft PR #11 was created through the authenticated GitHub CLI after the GitHub app connector returned 403 `Resource not accessible by integration`. The PR is Draft, targets `develop`, and its initial head was `7323b3a`; the final plan/roadmap update advances it. PR #11 is attached to this Codex task. Linear comments on the project and active SHEG-5, SHEG-6 and SHEG-8 record the PR and final branch head. Those issues remain In Progress, SHEG-7 remains Done, and SHEG-9/SHEG-10 remain Canceled. Merge and release preparation remain separate.

## Planning and evidence rules

- Write only the next executable plan. Every plan names its exclusions and the spec obligations assigned to later checkpoints; exclusions are not release cuts.
- Use a canonical isolated worktree from current origin/develop for implementation, read the full owning Linear issue and linked documents, and preserve existing dirt.
- Plans select concrete interfaces and files from current code. Record consequential choices through ADRs, superseding accepted decisions instead of rewriting them.
- Use meaningful behavior tests for genuine gaps. Provider properties are accepted contracts, not a model-validation workstream. Paid calls need explicit authorization.
- Stage intended source and generated outputs before a normal hooked commit. The tracked hook runs npm run verify against a clean staged snapshot; do not duplicate that full gate immediately around a successful hooked commit.
- Update delivery evidence and completion custody through the planning-artifact workflow. Keep this roadmap as a live look-ahead, not a permanent completed index.
- No backward compatibility is offered below v1. Breaking interfaces and storage formats are permitted; identify necessary reset/setup instructions without shims.

## Handoff notes

2026-10-01: The user approved the epic spec. SHEG-5 is deliberately split between one complete execution/recall path and its broader recovery/storage lifecycle. SHEG-7 is split between producing durable journey state and querying/reusing it. The skill guidance develops with every plan. Later plans remain unwritten until their prerequisites deliver working code and evidence. The sketch is preserved as pre-existing local discussion material, not used as an alternative authority.
