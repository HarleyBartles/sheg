# Typed repositories and the v0.3.0 SQLite baseline

Status: Active design for the dev.15 work slice.

## Purpose and scope

Sheg needs a persistence boundary that callers can use without writing queries, knowing table layouts, or asserting that arbitrary database rows have a desired type. The v0.3.0 release must establish a sound local SQLite schema and a safe forward-upgrade contract. Named repositories keep query ownership and row decoding in infrastructure, while CLI and MCP use the same application services.

The compatibility baseline begins with the schema actually shipped in v0.3.0. Pre-release database layouts are unsupported and require explicit recovery; stable release publication is a separate step.

## Approach

Use Drizzle ORM with the existing synchronous `node:sqlite` driver behind Sheg-owned repositories. Pin `drizzle-orm` and development-only `drizzle-kit` to the tested `1.0.0-rc.4` versions. Schema declarations, inferred SQL row types, predicates, projections, and ordinary writes come from Drizzle. Sheg owns named repository operations, runtime decoding, transaction coordination, migration admission, backups, and recovery.

A custom query builder would make Sheg responsible for maintaining column/type inference and SQL composition. Adopting Drizzle without repositories would still let callers duplicate queries and interpret rows inconsistently. Combining the ORM with declared repository interfaces addresses both concerns.

## Repository boundaries

Declare `RunReadRepository` and `RunCommandRepository` in the application layer. Their method arguments and results use application/domain contracts. The runtime opens one persistence owner that supplies both repositories and closes their shared connection. Drizzle objects and SQLite handles remain inside infrastructure.

The read repository supplies named results for submission lookup, run status and discovery, accepted request recall, full journey recall, the reserved worker turn, evidence pages, context recall, follow-on source resolution, answers, attempts, deletion preview, and storage inspection. Each public method owns its complete projection and returns a validated declared shape. Ordinary callers do not supply predicates, arbitrary selections, or ORM expressions.

The command repository owns acceptance, worker claim and heartbeat, attempt reservation and settlement, journey advancement, finish/failure handling, cancellation, resume, reconciliation, deletion, and optimization. Commands return declared acknowledgements or state results appropriate to the operation. Validation of a command's live preconditions and its writes occurs within the same transaction.

Application services explicitly reconcile the relevant run or expired active work before asking for a current status, discovery, evidence, or deletion preview. Read repositories do not reconcile or mutate. Reconciliation has a batch operation so discovery and storage inspection do not introduce per-run transactions. Reconciliation failure is reported; it is not hidden by a later read. A writer can change the store after reconciliation, but each ensuing read snapshot contains one coherent observed state.

Keep infrastructure modules cohesive around run discovery/identity, journey reads, evidence/context reads, attempt reads, acceptance, worker mutations, and lifecycle mutations. Reuse typed internal projections and codecs where they represent the same contract. Commands may use those internal helpers with their transaction handle; they do not open a separate read transaction or round-trip through an application service.

## Schema ownership and release baseline

Drizzle SQLite table declarations under `src/infrastructure/sqlite/` are the authored relational schema. Infer storage row and insert types from those declarations. Generate and review SQL migrations and snapshots outside `src/`, in a canonical migrations directory. A developer schema change is complete only when its migration chain builds the declared target schema and its affected behavior is verified. Do not maintain a second handwritten latest-schema creation script or required-column inventory.

Use schema 9 for the new baseline so an existing schema-8 database cannot be mistaken for the redesigned store. Opening an older development schema reports its unsupported status through the existing maintenance surface. Reset remains explicit and preserves the original through the existing backup/quarantine policy. Datastore identity, root resolution, and credential custody do not change. Add a superseding ADR for ADR-0027's baseline number; retain its released-data preservation and bounded recovery requirements.

Keep the existing durable entities: runs, question groups, evaluations, journey respondent checkpoints, physical attempts, attempt/evaluation membership, winning answer/attempt links, and the migration ledger. Strengthen their contracts rather than inventing a generic persistence framework:

- Identity columns reject null values in the actual generated database. Ordinals, revisions, counts, timestamps, call limits, and statuses have appropriate nullability and constraints.
- Composite foreign keys bind related records to the same run and, where required, the same group/respondent/context. Attempt membership and winning-answer links cannot join evidence from different runs or unrelated groups. A follow-on's historical source identifiers are deliberately not cascading dependencies on the source run.
- An answered evaluation has a typed answer, a winning linked attempt, and compatible question/packet evidence. Failed, pending, and unreached evaluations do not retain a winning answer. Some cross-table consistency belongs to atomic command validation rather than row-level checks.
- Preserve the physical-attempt ledger, including a per-attempt charged-call count for answered, failed-before-dispatch, failed-after-dispatch, and uncertain outcomes. Update any run-level accounting projection in the same settlement/reconciliation transaction. The ledger must be sufficient to verify the projection and original call allowance.
- Ownership and lease constraints distinguish prepared launch windows from live worker ownership. Terminal states clear ownership. A journey checkpoint's current-turn fields match its active/terminal state; optimistic revisions prevent stale transitions.
- Retain uniqueness needed for run-local order, turn identity, node occurrence, submission idempotency, and winning answers. Add indexes justified by pending-turn reservation, respondent/node counts, evidence criteria, attempt paging, and expired-work discovery. Avoid redundant indexes already supplied by unique constraints.

Accepted requests, frozen packets, follow-on lineage, and model-visible history remain immutable evidence snapshots. Their intentional duplication protects recall and source-independent follow-ons. Use one versioned stored representation per payload kind, with shared codecs that parse unknown JSON into domain contracts. Persist evaluation answers consistently as `DecisionValue`; provider execution evidence belongs to the linked physical attempt and is composed into public results on read. Polls and journeys use the same representation. Unknown payload versions fail safely; future supported upcasters operate in memory without changing stored bytes or silently changing compiler semantics.

Query-oriented metadata is relational or projected from the canonical stored representation, with one definition owned by the relevant repository. Do not create independently maintained copies of frozen text or answer meaning just to obtain types. Profile/request parsing and retained checkpoint growth are measured as part of the actual journey workloads; packet deduplication is not assumed to be semantically free.

## Read safety and cost

Use explicit projections and inferred Drizzle types for ordinary reads. Runtime codecs still validate enums, safe integer/count ranges, payload versions, question contracts, fingerprints, and provider evidence. ORM inference does not validate an externally altered database. Do not replace a broad row cast with an unchecked `sql<T>` or JSON `$type<T>` assertion.

Complex named reads may use parameterized Drizzle SQL fragments with table/column references. Their unknown raw result is parsed against a declared projection schema before it leaves infrastructure. This is a controlled escape hatch within the repository, not a second general query language.

The worker reads the frozen journey identity once, then obtains only the reserved evaluation, its respondent checkpoint/profile, and the ordinal/occurrence facts needed for advancement. It validates current-turn ownership and compiler/packet identity without rehydrating every earlier packet or every respondent on each turn. Full public recall validates every record it actually recalls.

An evidence page establishes one deferred read snapshot for source state, lifecycle, cursor checks, denominators, matched coverage, and rows. Build a lightweight materialized matching set in SQLite containing the identifiers and derived scalar fields needed for coverage and page selection. Reuse that set, and join full packet/result/execution payloads only for the bounded page. Preserve coverage when the page is empty, mapped/no-fit distinctions, selected-material provenance, and stale/forged cursor rejection. Validate the fields consumed by coverage and fail safely when they are malformed.

Run discovery shapes statuses in a bounded batch. Attempt paging obtains linked evaluation identities and failures in a bounded batch, without delimiter-based row packing. Follow-on acceptance checks its source-version facts and selected handles together, rather than issuing one source lookup per selection. Use prepared statements for hot repeated queries when measurements justify them. Inspect real query plans and measure increasing run counts, evaluation counts, checkpoint lengths, and packet sizes; do not assert wall-clock limits in CI.

## Transactions, migration, and opening

Use synchronous deferred transactions for multi-query read snapshots and synchronous immediate transactions for mutations. Atomic settlement includes the attempt, its answers/failures, winning links, accounting, respondent advancement, and any next turn. Provider I/O occurs outside the transaction. Transaction callbacks cannot be asynchronous.

Apply reviewed generated migration SQL through Sheg's migration runner, not through an unattended schema push or an unwrapped ORM migrator. The runner owns the sequential version/checksum ledger and advances schema identity only on successful commit. Fresh initialization and upgrades use the same canonical migration chain. Released migration SQL is immutable; later schema changes append a migration.

Before a step, verify the source schema and migration history, check integrity/foreign keys, and create a verified SQLite-consistent backup. Recheck schema identity and backup freshness after acquiring the writer lock. Compare `PRAGMA data_version` only on the same connection, and reject/retry a stale backup rather than applying a step against unbacked changes. Bound retries and report contention through maintenance instead of looping indefinitely.

Defer migration while a prepared launch window or worker lease is live. Recheck that condition under the migration writer lock. Do not interrupt inference, discard a reservation, or spend allowance to upgrade. The maintenance response explains the blocker and permits a later retry. Repository transactions check their expected schema version before issuing version-dependent queries, so an older open process refuses work after another process upgrades the store.

For a table rebuild, set and verify the required foreign-key mode before starting the transaction. The runner coordinates these connection settings rather than relying on embedded PRAGMAs to change them inside a transaction. Validate all foreign keys and full integrity before commit, restore enforcement on every exit, and roll back the whole step on failure. Constraints and integrity checks alone do not prove evidence preservation; populated upgrade coverage must verify the linked records and payloads as well.

Normal opening checks schema version, migration identity/checksums, and structural metadata derived from the canonical schema. Full integrity and foreign-key scans remain mandatory for migration, verified backups, and explicit health inspection. Measure normal-open costs against populated stores and document which corruption is detected only when its records are read or health is inspected. Compatibility inspection must not claim a full health check merely because the schema is current.

## Distribution

Bundle Drizzle ORM into the existing CLI, MCP, and worker outputs for Node 24. Drizzle Kit, schema-generation commands, and snapshots stay development-only. Copy only migration SQL and the minimal runtime ledger manifest as required runtime assets into `dist/`; the plugin directory and ZIP inherit those same assets through their existing canonical packaging path. Runtime path resolution is relative to the installed bundle, never the working directory or repository checkout. Include the dependency's license/notices in the distributed package.

The installed package requires no repository files, dependency install, migration generation, or local build. Canonical source and the migration chain remain authoritative; package identities continue to derive from root `package.json`.

## Acceptance

- Compile-time probes reject nonexistent columns, wrong insert values, unsafe nullable assignments, and async transactions. Behavior coverage additionally rejects illegal identities, cross-run/group links, invalid statuses/payloads, stale ownership, and inconsistent settlement.
- Real SQLite coverage exercises atomic rollback, accounting for zero/one/uncertain physical calls, partial batch success, respondent-local recovery, cancellation, and earlier-answer preservation through the new repository ports.
- Mapped Choice/no-fit coverage is correct on every page and an empty page. Reads retain a consistent snapshot across a deterministic concurrent writer. Increasing page/cohort size does not introduce one query or transaction per result row or source selection.
- Populate the schema-9 baseline with polls, journeys, and independent follow-ons. Apply a representative next-schema table rebuild through the production runner and verify evidence, links, accounting, integrity, backup recoverability, failure rollback, concurrent migration, live-work deferral, and old-connection fencing. A test-only successor schema exercises the runner without pretending an unused product migration has shipped.
- Malformed/future/pre-release stores retain the bounded maintenance surface and safe failure reporting. Normal-open validation does not erase or silently repair evidence.
- A copied generated package performs fresh initialization, named reads/writes, worker execution with a mock provider, and migration from the released-baseline fixture with no source checkout or installed dependencies. Git and ZIP distributions contain equivalent required runtime assets and identity.
- Compare full Sheg workloads before and after; run focused behavior checks and `npm run verify`. Keep spike code, databases, measurements, and results outside the repository. The repository carries source, meaningful tests, migration artifacts, and the live design/plan only.

## Reference basis

Drizzle documents [schema declarations as the source for queries and generated migrations](https://orm.drizzle.team/docs/sql-schema-declaration), [native Node SQLite support](https://orm.drizzle.team/docs/sqlite/connect-node-sqlite), and [generated migrations applied by an application-owned runner](https://orm.drizzle.team/docs/migrations). SQLite documents [snapshot isolation in WAL mode](https://www.sqlite.org/isolation.html), the [safe table-rebuild procedure](https://www.sqlite.org/lang_altertable.html#making_other_kinds_of_table_schema_changes), and [connection-local data-version comparisons](https://www.sqlite.org/pragma.html#pragma_data_version).
