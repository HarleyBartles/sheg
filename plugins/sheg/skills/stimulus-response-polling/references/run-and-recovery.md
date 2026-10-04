# Run and recover a poll

## Connect a Jev key or defer

When installing Sheg or choosing Jev without a saved key, offer **Connect TypeSafe**, **Connect OpenRouter**, or **Skip for now**. The user may connect both by repeating setup. Skipping permits keyless request design and local Laya; it cannot authenticate a Jev run.

Resolve the installed plugin root from this skill's location. Give the user this PowerShell command with the actual absolute helper path, or open a visible interactive terminal, run the command there, and let the user type only the key into its hidden prompt:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\path\to\installed\sheg\dist\credentials\windows-credential.ps1" -Operation Setup -TargetName Sheg/Jev/TypeSafe
```

Use `Sheg/Jev/OpenRouter` for OpenRouter. `Status` reports safe availability, `Setup` replaces the entry, and `Remove` deletes it. The helper writes directly to Windows Credential Manager. If secure storage fails, stop setup and explain the limitation. Never use chat, MCP parameters, environment variables, command arguments, or files to carry the key. macOS and Linux are not supported yet. Setup itself makes no paid request. Offer it again when a skipped route is needed; never fall back to the other route's credential.

Credential Manager stores generic values as bytes. Sheg can read UTF-8 tokens, including odd-length values, as well as the UTF-16LE format written by its setup helper. If an entry is present but uses another unreadable encoding, `run_start` returns `provider_credential_malformed` with a safe explanation and a setup instruction. The key itself is never included. This is distinct from a missing key or an unavailable credential store.

## Start and inspect a run

Build the simplest request that matches the user's goal: exact inline material, one or more distinct respondent profiles, one typed Choice, Score, or Noul question (or a finite sequence/response-routed graph when multiple stages are needed), one provider, and an adequate `maxCalls` limit. A direct poll or follow-on request may contain multiple independent questions over the same frozen respondent state. Choose material units, questions and response options from the user's question. Do not invent stages or add questions that do not help answer the requested question.

Use `run_inspect` with the exact request when a fit preview would help. It validates the shape and measures fit without inference or creating a run. `run_start` performs admission validation itself. Resolve invalid input, context overflow, and unavailable fit before starting. Do not trim user material, switch providers, or weaken a question without explaining the proposed change and checking that it preserves the user's intent.

For a hosted Jev run, obtain explicit user authorization for the study and its maximum physical call count. Sheg does not set a spend limit or account for provider billing. Jev reads the selected route's key from Windows Credential Manager; never request a key in chat or store it in a request. Laya requires a checkpoint-matched context fit measurer and a running local service. If fit cannot be verified, the adapter rejects the request before inference.

Call `run_start` with a fresh UUID `submissionId` and the inspected request. It returns a durable `runId` after persistence and worker launch. Preserve both identifiers. If the tool response is lost, retry the identical request with the same submission ID; that returns the existing run and does not dispatch a second worker. A changed request needs a new submission ID.

## Discover and interpret results

Use `run_query` to select recorded evidence from a source run. Criteria combine optional respondent ID, evaluation status, question ID, encountered material ID, typed Choice/Score/Noul answer, and journey route outcome. The tool returns exact `evaluationId` and `contextId` handles, answer distributions, safe per-answer failure details, provenance, and match count. `coverage` describes the whole source run; `matchedCoverage` describes only rows matching these criteria, with matched evaluation statuses, represented respondent count, and mapped selected-material count. A failed unrelated question can make the run partial while every answer to the selected question is present. Do not substitute the whole-run denominator for the filtered denominator. `sourceComplete` is true only when the source run reached `completed`; it does not tell you whether this query has all its intended answers. Use `lifecycle` for execution and recovery state. Use `run_get` with `view: "context"`, the run ID and one returned handle pair to retrieve that exact frozen packet and respondent-visible state; the response contains one evaluation rather than every context in the run. When the source is still progressing, describe the matches as current results and say more may match after completion. Query again after completion if the user needs the final cohort. A route outcome and a typed answer are separate facts; for example, `left-lost-interest` does not prove the respondent selected a typed “lost interest” answer.

For a Choice question that explicitly maps option IDs to exact material IDs with `materialOptions`, a matching answer also includes `selectedMaterial`: `materialId`, exact `text`, author-supplied `sourceId` and `sourceSha256`, and Sheg-computed `textSha256`. Unmapped options, including no-fit, have no material reference. The agent authors candidate boundaries and labels. Use the returned `materialId` in a follow-on request's `context.materialIds`, with the returned evaluation/context handles, to ask about the selected candidate in that respondent's chosen context.

Build a follow-on request yourself from the user's intended question and the evidence you selected. Sheg does not decide which result is relevant or what unit counts as a section, paragraph, or “bit.” Selection can repeat the query criteria for a live result set or pass exact `{evaluationId, contextId}` pairs returned by `run_query`. A user with a clear question can supply it directly; when their expectation is broader, decide which answers would satisfy them, then select the evidence and typed question that can answer it. Use `run_inspect` on that exact follow-on when a fit preview would help; `run_start` performs admission validation itself.

### Reuse each respondent's selected material

When a user wants to follow up on material respondents selected, query the source Choice question and pass the resulting source question selection to one follow-on request with `context.includeSelectedMaterial: true` and an isolation mode (`fresh-material` or `omit-history`). Sheg resolves each answered mapped Choice response to its exact saved material and uses that as the same respondent's next stimulus. Add shared framing, such as a pull quote, through the follow-on's explicit shared material fields. Ask the follow-up question about the selected material in that shared frame.

For example, if respondents selected among seven paragraphs for a pull quote, include the paragraph each respondent selected and the shared pull quote, then ask whether that paragraph expresses the pull quote. Each respondent sees their own selected paragraph with the shared quote in isolation. Sheg does not extract a paragraph from an answer or infer a material mapping. Unmapped choices, including no-fit, remain visible in selection coverage and do not receive a follow-on group. Read `selectionCoverage` and `selectionExclusions` to report which source answers produced groups and why others were excluded. Do not split this into one follow-on run per paragraph.

When a binary Noul question needs explicit meaning, put it in `criteria.true` and `criteria.false` on the question, for example `{"type":"noul","id":"quote-fit","instructions":"Does this paragraph express the pull quote?","criteria":{"true":"The paragraph expresses the pull quote.","false":"The paragraph does not express the pull quote."}}`. These keys define the proposition; do not use separate `trueCriterion` or `falseCriterion` fields.

The request shape is one follow-on, with the source question selected without an answer filter. `includeSelectedMaterial` tells Sheg to resolve each eligible answer's exact saved Choice-to-material mapping. Put shared framing in `material`; do not list the respondents' different selected paragraphs there or in `context.materialIds`.

```json
{
  "kind": "follow-on",
  "sourceRunId": "00000000-0000-4000-8000-000000000017",
  "selection": { "criteria": { "questionId": "q-pull-quote" } },
  "context": { "mode": "fresh-material", "includeSelectedMaterial": true },
  "material": [
    { "id": "pull-quote", "text": "A city is a promise people keep making to each other." }
  ],
  "questions": [
    { "type": "noul", "id": "quote-fit", "instructions": "Does this paragraph express the pull quote?" }
  ],
  "provider": { "kind": "jev", "route": "openrouter", "model": "typesafe/jev-1.13" },
  "maxCalls": 2
}
```

The ID above is illustrative; use the source run ID returned by Sheg. Choose the provider and call allowance for the user's actual setup and eligible response groups. Run `run_inspect` on the complete request before execution when a fit preview helps. A source-question criterion includes mapped and unmapped answers so Sheg can report coverage and exclusions; do not filter the follow-on to mapped Choice IDs.

Design for substantive input variation. The main dimensions are respondent profile, stimulus, question or response, and state, including prior-turn visibility. The respondent cohort supplies profile variation; choose profiles and cohort size to represent the differences the user needs to understand rather than defaulting to the smallest cohort. Each respondent's selected paragraph varies the stimulus in an isolated follow-up while the shared framing and question remain interpretable. Inputs matching on all four dimensions are duplicates for study-design purposes: another run may show ordinary model variability, but it does not add substantive coverage. Vary the input deliberately when the user wants richer evidence.

Choose a follow-on context explicitly:

- `recorded` changes only the question. It preserves the selected turn's exact respondent perspective, material, and trajectory.
- `fresh-material` uses the saved perspective with explicitly supplied or selected material and an empty trajectory.
- `omit-history` uses explicitly selected material with the saved perspective and an empty trajectory. Pass `context.materialIds` to select exact material from that turn; this removes earlier exposure IDs and order from the model input.
- `continue` retains the selected turn and adds its completed typed answer to the trajectory before asking the next question. Optional explicit material is added for the next question. A pending turn has no answer to continue.

Each accepted follow-on is its own durable run with its own ID, frozen packets, answers, and source lineage. The source material is copied into those packets, so a follow-on remains readable if its source run is deleted. `run_get` with `view: "request"` reports whether the source record is still live or historical. `run_delete` dry-run lists dependent follow-on run IDs that would be retained.

Use `run_get` with `view: "status"` to inspect progress, `view: "request"` to recall frozen inputs and respondent packets, `view: "answers"` to retrieve typed answers and failures, or `view: "journey"` to retrieve respondent-local turns, exposures, response history, routes, and terminal states. Answer pagination uses the returned cursor and a limit from 1 to 200. Use `view: "attempts"` to inspect physical calls, their linked evaluation IDs, settlement status, and any provider failure. Attempt history also paginates with the returned cursor and a limit from 1 to 200. `run_query` also paginates with a returned cursor. `run_list` supports status, label, time, and referenced-material filters when the run ID is not at hand. Discovery and query never start or resume work.

Report completed, failed, pending, and total evaluation counts together with the run status. A completed run has an answer for each respondent; a partial run may include both answers and respondent-local failures. A run-wide provider failure stops further dispatch. If cancellation is requested during an active provider call, let that call settle and preserve its answer; Sheg does not send the next respondent.

Independent questions in one request share the exact frozen respondent state and are answered separately. Siblings do not see each other's answers. Jev may serve several questions in one physical request when its measured batch fits; Sheg can split a group while preserving each question and its shared context. Local Laya currently sends one question per physical request. `maxCalls` counts physical provider attempts, including uncertain attempts and retries, not question count. A confirmed failure before dispatch does not consume an allowance; fix its cause and explicitly resume the failed run. `run_inspect` reports the minimum physical calls after provider measurement; actual calls may be higher when a group is split or retried. Query by `questionId` to select one answer. A dependent question must be a follow-on that explicitly selects completed evaluation/context handles; do not place a question that depends on a sibling answer in the same group.

Provider attempts are not new responses. An uncertain in-flight call consumes its reserved physical-call allowance because the provider may have received it. Expired workers appear as interrupted, and a read will not retry them. A stopped run never resumes because of a read. Call `run_resume` only when the user explicitly wants the existing run to continue and its returned lifecycle says `resume.eligible: true`. `lifecycle.state` is `active`, `stopped`, or `complete`; the detailed run `status` explains which specific state applies. When `resume.eligible` is false, its `reason` explains the refusal, such as `call_allowance_exhausted`, `cancellation_requested`, `partial_journey`, or `no_unfinished_work`. Here `partial_journey` means Sheg cannot match every failed evaluation to one known failed respondent turn. Prepared runs are already active; running, completed, and cancelled runs cannot be resumed. Failed runs with a retryable run-scoped failure and partial poll runs with failed evaluations can resume when the original call allowance permits. A safe typed-answer detail identifies the observed validation rule, for example `unknown_option`, `probability_keys`, or `score_out_of_range`; it does not establish why the provider produced that answer. The same evaluation failure remains in its attempt history after explicit resume clears it from the current pending answer.

### Resume an eligible partial journey

When a journey is partial, inspect `run_get` status, journey, and attempts before proposing recovery. Explain which respondents completed, which respondent stopped at a failed reached turn, what earlier answers and route that respondent already recorded, and whether an attempt is unresolved. Failed, pending, and unreached work is not a negative answer. Do not describe the run as complete because one respondent or earlier turn succeeded.

If the lifecycle says `resume.eligible: true` and the user explicitly asks to continue, call `run_resume` with that run ID. Sheg keeps the same run ID, original request, failed evaluation and frozen packet, completed respondents and turns, respondent exposure and response history, route, attempt history, and original `maxCalls`. It retries only the known failed turn for each failed respondent; it never replays completed work or increases the allowance. A newly valid answer may choose the next branch, which is reached only after that retry succeeds. A failed retry remains partial and visible in attempts; the user can ask to resume again only while lifecycle eligibility remains true. If eligibility is false, report its exact reason and do not retry or substitute a new run without the user's direction.

## Delete selected runs

Deletion is explicit and accepts 1 to 200 unique run IDs. Use `run_delete` with `dryRun: true` when a preview would help. The preview lists each selected run's status, evaluation and attempt counts, and whether active work blocks deletion. A preview does not remove data. The delete operation validates the whole selection itself, so the preview is not a reservation. If any run is missing or active, deletion is all-or-none. Cancel active work, poll until it is terminal, then submit the explicit selection again. Deletion removes the run and its associated evaluation and attempt records. The result distinguishes committed deletion from optimization maintenance: `maintenance.optimization` is `completed` or `failed`, and a failure includes `failureCode`. A maintenance failure does not undo the reported deletion; inspect or retry with `run_storage`. Never manipulate SQLite files or sidecars directly.

## Inspect and optimize storage

Call `run_storage` with `operation: "inspect"` for SQLite and foreign-key integrity status, database byte size, and run, evaluation, attempt, and active-run counts. The report contains no host path or SQL. Call `run_storage` with `operation: "optimize"` to ask Sheg to run SQLite optimization. Sheg refuses to optimize when its integrity check fails. Inspection reconciles expired worker leases before counting active runs, but never launches or resumes work. Successful deletion also triggers Sheg-managed optimization. Do not run maintenance at harness startup or manually alter datastore files.

Provider-reported cost or a published-rate estimate may appear per decision when available. Cost evidence is optional and may differ by the user's API account. Sheg does not total it, treat it as an accounting record, or require billing reconciliation. Users can consult their provider dashboard for exact account usage.
