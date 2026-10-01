# Sheg v0.3.0 release roadmap

Status: approved roadmap; implementation is in progress on the v0.3.0 feature branch.
Authority: [approved epic specification](../../specs/2026-10-01-v0.3.0-epic-spec.md).
Linear: [release project](https://linear.app/harleys-workspace/project/sheg-v030-richer-studies-and-inspectable-evidence-6d11068a2761).

## Outcome

An agent submits a useful request, leaves the chat, discovers its durable results
later, queries relevant evidence, and builds a follow-on using recorded respondent
contexts and material. Sheg provides tools and skills; the agent owns relevance
and interpretation. The release culminates in the section-three investigation
defined in the spec.

## Consecutive plans

Only Plan 1 is written. Later rows are capability boundaries, not implementation
plans. Write each next plan against the delivered code and evidence of its
predecessor. A Linear issue may span more than one plan.

| # | Title | Status | Plan File | Commit | PR | Rating | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Submit one-question requests and recall durable results across chats | completed-awaiting-retirement | [Plan 1](01-durable-question-runs.md) | `3d683e4` (`8b0ccb2..3d683e4`) | - | - | SHEG-5 remains open for Plan 2; Credential Manager encoding diagnosis and safe malformed-credential response included; full staged gate 219 tests; final review clean |
| 2 | Recover, resume, delete and inspect storage through the MCP | in progress | [Plan 2](02-resume-delete-storage.md) | - | - | - | SHEG-5; explicit same-run resume, transactional delete with optional dry run, Sheg-managed storage health and optimization |
| 3 | Execute authored journeys with durable respondent turn contexts | pending | Written after Plan 2 | - | - | - | SHEG-7 foundation; integrate finite journeys with the new run store |
| 4 | Query recorded evidence and compose reusable follow-ons | pending | Written after Plan 3 | - | - | - | Complete SHEG-7; preserve uncertainty/disagreement evidence |
| 5 | Ask independent typed question groups at new or recorded contexts | pending | Written after Plan 4 | - | - | - | SHEG-6; provider-aware batching/splitting without sibling leakage |
| 6 | Offer source-linked material choices and reuse their exact evidence | pending | Written after Plan 5 | - | - | - | SHEG-8; agent-authored candidate boundaries |
| 7 | Integrate the release workflow and packaged agent guidance | pending | Written after Plan 6 | - | - | - | Across active issues; release preparation only after acceptance and authorization |

Commit and PR columns record delivered implementation evidence, not this roadmap's
own commit. Ratings are intentionally not persisted: the handoff-gates skill
reports readiness in the conversation only. No row is executing or done merely
because its plan exists. SHEG-9 and SHEG-10 remain cancelled.

## Capability exits and JIT inputs

### 1. A complete durable one-question path

Inline authored respondent profiles, material and one Choice/Score/Noul question
can be inspected and accepted without study/cohort files. SQLite stores frozen
inputs and typed results. A detached local worker completes independently of its
originating MCP process. Another connection discovers the run, reads its status,
request and answers, or requests cancellation. Identified submission retries do
not duplicate work. Startup and reads never restart interrupted work.

This first user-value demonstration is delivered at `3d683e4`, reviewed against
`origin/develop`, and passed the full staged verification gate. The copied
distributable survived termination of its originating MCP; another MCP
connection retrieved the answer and an identical submission retry reused its
run ID. A killed worker was discovered as interrupted without relaunch. The
credential integration fix identifies malformed encodings and tells the agent
how to repair them without exposing or rewriting the credential. Full resume,
deletion and storage maintenance remain Plan 2 obligations under SHEG-5.

Next plan uses the actual database schema, worker ownership, failure states,
attempt records and cross-process evidence delivered here.

### 2. Orderly lifecycle and storage operations

Explicit resume processes only unfinished work under the remaining original
budget. Cancelled/completed work stays stopped. Unknown provider completion is
accounted conservatively. Deletion offers dry run, revalidates scope and settles
active work first. Queries expose partial evidence and storage usage. Sheg owns
integrity and optimisation. No migration layer or automatic startup recovery job.

Next plan uses these lifecycle rules and the actual persistence boundary rather
than introducing a second execution manager for journeys.

### 3. Authored journeys produce reusable recorded state

Finite authored exposure, evaluation and routing operate through the same durable
run/worker path as simple questions. Save exact pre-question state for each
respondent and turn occurrence, original typed answers, compiler fingerprints,
and route outcomes. Preserve conditional exposure and logical journey limits.
Ordinary agents do not handcraft manifests. Consolidated inspection exposes
authored branches and history choices. Account for matched-arm capabilities and
the CLI, and retire redundant file-run execution code where superseded.

This is necessary substrate for the section-three query, not an unrelated graph
rewrite. Old formats and tool names carry no compatibility obligation below v1.

### 4. Query, interpret and compose follow-ons

Focused paginated projections expose typed answers/distributions, available
confidence, reach/completion denominators, respondents, questions, material and
context/provenance. Agents supply explicit criteria and receive input-compatible
references. Exact-turn reuse, fresh material, continuation and deliberate context
changes have the spec's defaults. Keep selection rationale outside model input.

Inspection of progressing sources reports current matches and completeness;
acceptance freezes selection. Retained follow-ons remain usable when their source
run is deleted. Extend Plan 2 deletion to the cross-run dependency model here.
Use these results and references to design the independent-question contract JIT.

### 5. Independent questions and physical batching

Apply one or several typed questions to the same context, without sibling answers.
Sheg chooses supported physical batching or splitting and accounts every physical
attempt. Fit admission applies to actual packets. Do not trim input, change
providers or make local inference limitations universal. Resolve actual Jev route
capabilities from evidence; the existing native admission block is not silently
removed. Demonstrate reuse of recorded turns, mixed answers and recovery.

### 6. Exact offered material evidence

Agents choose candidate units and wording. Answers resolve to exact offered text
and stable material identities accepted by the next request. Validate exposure,
source identity and no-fit semantics. Selection, ordered Score position judgment
and staged threshold crossing remain distinct. Do not add editorial-cut advice
or a new scalar response primitive.

### 7. Combined release acceptance

Demonstrate the spec's full section-three investigation, including original-state
reuse and deliberate history removal, source-linked choices and another follow-on.
Canonical skills explain when evidence may matter, how to query it and how to
compose the next request. Verify the installed package, database/worker lifetime,
tool schemas, current-format integrity and generated assets together.

Prepare the versioned release only after those exits and the applicable release
authorization. Feature work targets develop; release preparation owns version
alignment, release/0.3.0, main promotion, tagging, ZIP publication and reconciliation.
Do not leave human-owned publication/merge approvals as unfinished implementation
checkboxes in a completed plan.

## Planning and evidence rules

- Write only the next executable plan. Every plan names its exclusions and the
  spec obligations assigned to later checkpoints; exclusions are not release cuts.
- Use a canonical isolated worktree from current origin/develop for implementation,
  read the full owning Linear issue and linked documents, and preserve existing dirt.
- Plans select concrete interfaces and files from current code. Record consequential
  choices through ADRs, superseding accepted decisions instead of rewriting them.
- Use meaningful behavior tests for genuine gaps. Provider properties are accepted
  contracts, not a model-validation workstream. Paid calls need explicit authorization.
- Stage intended source and generated outputs before a normal hooked commit.
  The tracked hook runs npm run verify against a clean staged snapshot; do not
  duplicate that full gate immediately around a successful hooked commit.
- Update delivery evidence and completion custody through the planning-artifact
  workflow. Keep this roadmap as a live look-ahead, not a permanent completed index.
- No backward compatibility is offered below v1. Breaking interfaces and storage
  formats are permitted; identify necessary reset/setup instructions without shims.

## Handoff notes

2026-10-01: The user approved the epic spec. SHEG-5 is deliberately split between
one complete execution/recall path and its broader recovery/storage lifecycle.
SHEG-7 is split between producing durable journey state and querying/reusing it.
The skill guidance develops with every plan. Later plans remain unwritten until
their prerequisites deliver working code and evidence. The sketch is preserved
as pre-existing local discussion material, not used as an alternative authority.
