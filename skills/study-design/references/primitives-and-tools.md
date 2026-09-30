# Sheg study primitives and tools

Read this when composing a study or selecting a Sheg tool. The runtime schemas
and registered MCP operations define what the current harness accepts; this
guide explains how those pieces compose for study design.

## Study building blocks

| Primitive | Meaning in a study |
| --- | --- |
| Study | A title, purpose, and one or more arms. |
| Arm | One version of the study: source references, ordered stimulus items, tasks, and a presentation. Matched arms use the same frozen cohort. |
| Stimulus item | A bounded piece of authored text with a stable ID. A source reference records the source path and digest. |
| Task | One model decision: instructions and a typed response contract. A task may include or omit earlier response history independently of which respondents are eligible to reach it. `unanswerable` is an ordinary Choice option when useful. Answer keys are scoring metadata and are not sent to the model. |
| Typed response | Choice returns one stable option ID and its probabilities. Score returns an expected score on an ordered rubric, per-level probabilities, and rubric legend. Noul returns P(true) for the proposition. |
| Respondent profile | One concrete perspective, with five prose fields: intent, context, desired outcome, engagement cues, and friction cues. The profile is stimulus-specific and bounded by the shared field and aggregate limits. |
| Archetype | A reusable perspective pattern with invariants and optional variation dimensions. It is a way to propose profiles, not a respondent that the harness runs directly. |
| Cohort | An ordered, frozen collection of concrete respondent profiles, optionally with snapshots of the archetypes used to create them. |
| Presentation | A `sequence` or a finite `graph`. A sequence exposes the arm's items in order and asks its tasks in order. A graph uses `expose`, `ask`, and `terminal` nodes; Choice routes by option ID, Score/Noul routes by explicit exhaustive, exclusive intervals, and every path terminates. |
| Journey | One respondent's path through one arm. Its event history records stimulus exposures and typed responses. The cohort is held fixed across matched arms. |
| Decision packet | The input for one task. It contains the respondent perspective, stimulus text in scope, and current typed task. Prior response events are included by default and can be omitted per task; exposure context remains. |

History is derived from journey events, not separately authored state variables. For each task, response-history inclusion is independent of respondent eligibility: a task may receive only respondents routed onward with their own earlier answers, or address the full cohort without prior answers. Later tasks never see another respondent's history. Choice, Score, and Noul are typed outputs end to end; typed threshold routes must declare full-domain, non-overlapping intervals.

## MCP tools

Static product facts belong in this guide. The tools below validate, measure,
preview, execute, or report; there is no capability-list tool.

| Tool | Accepted input | Result | Provider behavior |
| --- | --- | --- | --- |
| `poll_preview` | `manifestPath` | Each arm's presentation and stable ordered nodes, including stimulus/task wording, Choice options or typed threshold routes, destinations, and shared continuations. Every question includes one `routeContexts` entry per route reaching it, with Choice options or typed response intervals, prior response meanings/exposure IDs, and stimulus IDs currently in scope. Shared questions remain one node with multiple route contexts. A stimulus ID resolves to the authored text on its stimulus node. Rejects more than 10,000 route contexts with no partial preview. | No cohort, provider, or inference call. |
| `poll_check` | `config`: manifest, cohort, output directory, call limits, and provider configuration. | Validation/fingerprints, respondent and arm counts, minimum/maximum reachable decision calls, call-cap sufficiency, and configured Jev spend ceiling. | No provider call. |
| `poll_preflight` | `manifestPath`, optional `cohortPath`, provider list, optional mode and packet cap. | Per-provider fit, worst packet, overflow/unavailable details, measurement method, and whether traversal completed. | Measures every reachable packet; no inference call. |
| `poll_trace` | Manifest/cohort paths, arm/respondent IDs, and exactly one of scripted `choices` or typed `responses`. | The deterministic route and outcome for those responses. | No provider call. |
| `poll_measure_packets` | Provider configs; `combination`; non-empty `respondents`, `stimuli`, `tasks`, and `trajectories` arrays of `{ id, value }` variants. | Every compiled case with stable case ID, source variant IDs, per-provider token estimate/measurement, fit, headroom, reason, and provider-specific largest case. | Calls provider `measure` only; no inference endpoint. Jev estimates offline; Laya uses its pinned local tokenizer. |
| `poll_start` | A complete run `config` with manifest/cohort, provider, output directory, and explicit caps. | A durable run ID and initial run status. | Starts respondent inference. |
| `poll_status` | `outputDirectory`, `runId` | Current durable status; it can recover an abandoned running state. | No new inference call. |
| `poll_cancel` | `outputDirectory`, `runId` | Cancellation request and settled run state. | Waits for already in-flight decisions to settle; does not start new ones. |
| `poll_reconcile` | `outputDirectory`, `runId`, user-verified `unpricedUsd` | Billing reconciliation result for uncertain Jev calls. | No provider inference call. |
| `poll_resume` | `outputDirectory`, `runId` | Resumed run state after frozen-input and execution-fingerprint validation. | Resumes respondent inference. |
| `poll_report` | `outputDirectory`, `runId` | JSON-safe respondent/task/run report. | No provider inference call. |
| `poll_compare` | `outputDirectory`, `runId`, `leftArmId`, `rightArmId` | Matched comparison of two arms in that run. | No provider inference call. |
| `poll_compare_runs` | Two report identities and one arm ID from each run. | Compares explicitly aligned typed responses from separate runs, requiring the exact same frozen respondent cohort and matching task meanings. Returns source, stimulus, task, provider, run-status, completion, and declared-profile subgroup differences. | No provider inference call. |

### Choosing the measurement operation

Use `poll_measure_packets` for quick, bounded checks while drafting. Each
dimension can vary independently:

- In `paired` mode, multi-valued dimensions are combined by the same index.
  Three profiles and three task drafts mean `(profile-1, task-1)`,
  `(profile-2, task-2)`, and `(profile-3, task-3)`. This does not compare the
  contents of variants.
- A singleton dimension broadcasts. One profile and 30 task variants produce
  30 packets; 30 profiles and one task also produce 30.
- If two or more dimensions have multiple values, those dimensions must have
  equal lengths. Three profiles and two tasks fail validation before
  measurement; no variant is silently dropped or repeated.
- In `cartesian` mode, every combination is explicit. Three profiles and two
  tasks produce six packets.

Every variant dimension needs stable unique IDs. The tool caps one call at
1,000 expanded cases and 16 MiB of serialized compiled packet inputs. It
returns a complete batch or an error, never a partial batch labelled complete.
Provider-specific `largestCase` values are based on that provider's measured
or estimated tokens, with deterministic case-ID tie breaking.

Use `poll_preflight` after the design and frozen cohort are settled. It walks
every respondent, every possible choice, and each resulting decision packet
through every route. A fit at one draft packet does not imply the complete
branching study fits.

## Study flow and approvals

1. Discuss material, question, and useful respondent perspective; inspect
   these documented capabilities before proposing unsupported response types.
2. Co-design and get the human's approval of the human-language study design.
3. Author and validate the manifest, then use `poll_preview` to show every
   route before building the cohort. Inspect route-specific prior choices and
   current stimulus scope at each question. These steps add no approval gate.
4. Propose and expand a cohort with the human, validate exact run settings with
   `poll_check`, then use incremental sizing and exhaustive preflight.
5. Report reachable calls and the configured spend ceiling; get approval to
   run, then call `poll_start`.
6. Report and interpret the typed outcomes against the original question and
   source material.

For a follow-up that changes a variable, create a new run. The same frozen
cohort can be reused and compared with `poll_compare_runs`; a paired comparison
does not require a two-arm execution. Keep task comparison keys stable only
when the question's meaning is still aligned. Comparisons describe simulated
responses.

Optimization of a study's shared trajectory/context policy is a future seam.
It is not an authoring prerequisite or a current tool.
