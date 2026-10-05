# dev.16: source quality and durable prevention

## Purpose and scope

Prepare Sheg's source for the v0.3.0 release by completing the persistence decomposition, removing duplicated contracts and behavior, strengthening runtime boundaries, and preventing demonstrated agent mistakes from recurring. Make the root README useful to a human discovering Sheg. Deliver the slice through one feature PR into `develop`, advertising `0.3.0-dev.16` from the single authored version.

This spec covers the agreed source audit, SQL library, README redesign, and adoption of `unslop`, `playbook-composition`, and `runbook-composition`. It is a design for implementation, not an audit receipt. The execution plan will identify concrete edits and verification. Tests change where these changes require meaningful behavioral proof; a separate exhaustive test-suite cleanup is outside this slice.

Sheg's first compatibility promise begins with v0.3.0. Pre-release file-backed CLI checkpoints and their read-only report and comparison commands are not part of that promise and are removed. The files themselves are not modified or deleted. Keep manifest-based `trace` and `preflight` diagnostics and the separately governed SQLite schema and payload compatibility policies.

## Persistence architecture

Retain Drizzle and the application-facing read and command repository separation. Complete the implementation behind those interfaces. `src/infrastructure/run-store.ts` becomes a composition boundary that opens the connection and constructs repositories, rather than owning validation, reconstruction, lifecycle calculation, routing, settlement, recovery, and deletion in one class. Extract by responsibility and transaction ownership, with no arbitrary file-size target or generic repository framework.

Read repositories return declared application data shapes. Command repositories own acceptance, reservation, settlement, reconciliation, recovery, and deletion. Share focused internal persistence helpers where needed. Services coordinate reconciliation and operations; CLI and MCP translate inputs and outputs through the same application services. Domain code owns study and journey rules, including route matching and material consistency. Infrastructure invokes those rules instead of independently implementing them.

Preserve atomic settlement across attempts, winning answers, failures, call accounting, respondent checkpoints, and next-turn creation. Extracted command implementations share one transaction context; moving code must not split a mutation into separately committed steps. Provider I/O stays outside transactions. Multi-query reads use deferred snapshot transactions; writes use immediate transactions. Deletion preview is a read.

## Controlled SQL library

Keep complex SQL in named, concern-owned query assets adjacent to the persistence implementation, with declared parameter contracts and runtime-decoded result shapes. Repositories invoke these queries; application callers never construct their own SQL. Ordinary typed Drizzle operations remain appropriate. Raw SQL is an explicit controlled boundary, not inline prose scattered through orchestration functions.

Version query assets through Git alongside the schema and migrations. Do not introduce a separate query-version registry or duplicate historical query inventory without a requirement for coexistence. Keep parameter binding explicit and values out of interpolated SQL. Shared evidence criteria have one translation implementation used by evidence discovery and follow-on selection.

Query assets must resolve in the built, self-contained installed plugin and CLI runtime. Git marketplace and ZIP distributions remain equivalent. Generated output follows canonical source; no installed runtime dependency on repository source, build scripts, dependency installation, or the working directory is introduced.

## Canonical contracts and decoding

Own reusable vocabularies in their relevant domain modules, using constant objects or tuples and schema-derived unions. Reuse named aliases rather than repeating expanded type constructions. Avoid a global constants dumping ground and avoid replacing every local literal with a ceremonial constant. Share definitions where independent repetition creates typo or drift risk, including lifecycle states, provider kinds, response kinds, persisted payload kinds, and typed failure rules. Align database constraints with the owned vocabulary without mutating released migration history.

Separate permissive input compatibility from normalized internal output. Parsed tasks have their discriminator present; consumers use that contract rather than repeatedly inferring it from property presence. Derive configuration and evidence types from their runtime schemas where those schemas are authoritative. Use exhaustive dispatch for application operations and variant handling where a missing case must fail compilation.

JSON parsing returns unknown data. Owned codecs validate the shape and version before producing typed payloads, including journey histories, routes, and model-visible state. An assertion, ORM generic, or array-container check cannot substitute for validation of consumed fields. Decode result and execution evidence once per recalled record and reuse the decoded values. Preserve immutable evidence, fingerprints, public recall semantics, migration guarantees, and historical stored bytes unless a separately justified migration is necessary.

## Provider and lifecycle correctness

Validate batch execution evidence independently of individual answers, including configured provider/model identity and allowed physical attempts. Empty, missing, duplicate, invalid, or explicitly failed answers must not bypass execution validation. Preserve valid sibling answers when the shared execution contract is valid.

Share Jev authentication, retry, HTTP transport, envelope handling, and execution accounting between single and batch inference. Keep answer decoding specific to its wire shape. Both paths retain bounded, accurate failure categories and typed validation details without exposing credentials or raw sensitive diagnostics. Review optional batch capabilities as one coherent contract so admission and execution cannot disagree about support.

Inspection messages must reflect the actual measured result. In particular, initial-fit failure cannot coexist with a claim that initial packets passed. Unexpected worker and recovery failures retain useful safe diagnostics, and recovery reporting distinguishes retained backups from successful restoration of the active datastore.

## Read efficiency and remaining source cleanup

Settlement returns affected evaluation outcomes so the worker need not reload every evaluation status after each physical call. Narrow identity/existence reads do not compute full lifecycle aggregates. Reuse status and decoded data already obtained within an operation. Discover and reconcile eligible expired work in bounded queries rather than repeatedly projecting every active run. Preserve snapshot-consistent coverage, pagination, and source-version checks.

Consolidate duplicated material merging, routing, evidence filtering, and execution extraction at their proper owner. Remove obsolete executable accounting, unsupported pre-release file-backed report reading and comparison code, and production fixture helpers after checking callers. Retain only types and compatibility functionality required by the v0.3.0 release policy. Simplify dead parameters, unnecessary assertions, dense multi-statement code, and misleading abstractions encountered in the audited scope. Preserve vendored provenance and avoid cosmetic rewrites of upstream code.

Choose changes for correctness, clarity, or demonstrated redundant work. Do not claim performance improvements from unmeasured elapsed time or introduce fragile timing assertions. Existing synchronous SQLite use is intentional; this slice does not introduce an asynchronous persistence model.

## Human-facing README

Explain what Sheg does and why a person would use it in plain language. Show a concrete study, such as selecting the paragraph that best represents a pull quote and following up with each selected paragraph in isolation. Give a supported installation path and a first-use prompt, then link to deeper provider, operation, CLI, and contribution documentation.

State simulation limits and the role of input variation accurately without letting caveats or agent operating instructions dominate the introduction. Respondent profile, stimulus, question/response, and prior-visible state are the substantive variation levers; repeated identical inputs do not add meaningful coverage. Keep repository setup and agent contribution routing in their existing owned documents rather than duplicating them in README.

## Standards and prevention

Adopt immutable pinned subscriptions to `unslop`, `playbook-composition`, and `runbook-composition`, with repository-owned implementation and maintained certification. Assess existing guides for truthful applicability, useful composition, reference integrity, and effective routing. Reuse and improve the existing inventory; do not import placeholder starter documents. Root `AGENTS.md` remains a small router to subscriptions, certification, and contribution stages.

Maintain concise evidence-backed unslop profiles under `.agents/unslop/`. Start from demonstrated duplication, false validation guarantees, misplaced domain rules, redundant materialization, and drifting execution paths. Guards state recognition cues, corrective behavior, applicability, and false-positive boundaries. Write their corrections against the implemented architecture, not speculative rules.

Routing is part of the implementation: lifecycle runbooks direct agents to applicable concern playbooks; those playbooks direct agents to relevant profiles at implementation and review decision points. Agents read and apply applicable guards and maintain them when distinct evidence warrants revision, consolidation, or retirement. Avoid mandatory all-to-all links and repeated guidance with competing owners.

Record only concise distinct occurrence evidence needed to assess recurrence, discoverability, and effectiveness, using durable references. Unknown reach or effect stays unknown. Do not store audit logs, test results, execution receipts, or narratives proving development happened. Mechanical checks support reference integrity and detectable code constraints; human review assesses guidance usefulness and actual routing.

## Acceptance and verification

- Read and command implementations have focused responsibilities, with `run-store.ts` serving composition and existing atomicity preserved.
- Named complex queries have declared inputs and decoded outputs, shared criteria translation, and installed-package asset resolution.
- Domain vocabulary and normalized contracts have clear owners; consumed persisted shapes are validated rather than asserted.
- Behavioral coverage proves execution rejection for wrong identity or excessive attempts even when all batch answers are missing or failed, accurate admission messages, and preservation of valid sibling answers under valid execution.
- Persistence coverage exercises affected settlement, recovery, read snapshots, evidence pagination, and historical recall. Query-count or workload probes demonstrate removal of identified redundant reads without elapsed-time gates.
- CLI and MCP continue using the same system; the copied generated package starts and resolves required assets independently of the repository.
- The CLI exposes no reader or comparison commands for pre-release file-backed run archives; SQLite schema and payload compatibility remain governed by their release decisions.
- README gives a human a truthful, concise route from discovery to first use. Standards subscriptions, certification, playbooks, runbooks, and unslop routes resolve and describe implemented behavior.
- Run the repository's `npm run verify` gate and generated-package parity checks before publishing. Skill behavior campaigns remain outside CI and pre-commit. Ship meaningful tests, not stored results or source-text change detectors.
- Update consequential architecture decisions with appropriate ADRs and index links. Keep this spec and its execution plan on `develop` under planning residency, and retire completed planning artifacts through the repository closeout policy after merge.

## Boundaries

No release tag, publication, new provider, paid inference campaign, ORM replacement, speculative framework, or broad product contract redesign is required. Preserve secure credential handling, physical-call accounting, respondent-local recovery, follow-on evidence custody, and release migration guarantees. Any necessary public behavior or schema change must be justified explicitly during planning rather than hidden inside refactoring.
