# Run and recover a poll

## Connect a Jev key or defer

When installing Sheg or choosing Jev without a saved key, offer **Connect TypeSafe**, **Connect OpenRouter**, or **Skip for now**. The user may connect both by repeating setup. Skipping permits keyless request design and local Laya; it cannot authenticate a Jev run.

Resolve the installed plugin root from this skill's location. Give the user this PowerShell command with the actual absolute helper path, or open a visible interactive terminal, run the command there, and let the user type only the key into its hidden prompt:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\path\to\installed\sheg\dist\credentials\windows-credential.ps1" -Operation Setup -TargetName Sheg/Jev/TypeSafe
```

Use `Sheg/Jev/OpenRouter` for OpenRouter. `Status` reports safe availability, `Setup` replaces the entry, and `Remove` deletes it. The helper writes directly to Windows Credential Manager. If secure storage fails, stop setup and explain the limitation. Never use chat, MCP parameters, environment variables, command arguments, or files to carry the key. Jev credential backends for macOS and Linux are not implemented. Setup makes no inference request and does not authorize a study; never fall back to the other route's credential.

Sheg reads UTF-8 tokens and the helper's UTF-16LE values. An unreadable entry produces `provider_credential_malformed` with a safe setup instruction, distinct from a missing credential or unavailable store.

## Start and inspect a run

Build the simplest request that matches the user's goal: exact inline material, one or more distinct respondent profiles, one typed Choice, Score, or Noul question (or a finite sequence/response-routed graph when multiple stages are needed), one provider, and an adequate `maxCalls` limit. A direct poll or follow-on request may contain multiple independent questions over the same frozen respondent state. Choose material units, questions and response options from the user's question. Do not invent stages or add questions that do not help answer the requested question.

Use `run_inspect` with the exact request when a fit preview would help. It validates the shape and measures fit without inference or creating a run. `run_start` performs admission validation itself. Resolve invalid input, context overflow, and unavailable fit before starting. Do not trim user material, switch providers, or weaken a question without explaining the proposed change and checking that it preserves the user's intent.

For a hosted Jev run, obtain explicit user authorization for the study and its maximum physical call count. Sheg does not set a spend limit or account for provider billing. Jev reads the selected route's key from Windows Credential Manager; never request a key in chat or store it in a request. Laya requires a checkpoint-matched context fit measurer and a running local service. If fit cannot be verified, the adapter rejects the request before inference.

Call `run_start` with a fresh UUID `submissionId` and the exact request. It persists the run before attempting worker launch and returns its durable `runId`; launch failure returns a queryable failed run. Preserve both identifiers. If the response is lost, retry the identical request with the same submission ID to recall it without dispatching a second worker. A changed request needs a new submission ID.

## Discover and interpret results

Use `run_query` to select recorded evidence from a source run. Criteria combine optional respondent ID, evaluation status, question ID, encountered material ID, typed Choice/Score/Noul answer, and journey route outcome. The tool returns exact `evaluationId` and `contextId` handles, answer distributions, safe per-answer failure details, provenance, and match count. `coverage` describes the whole source run; `matchedCoverage` describes only rows matching these criteria, with matched evaluation statuses, represented respondent count, and mapped selected-material count. A failed unrelated question can make the run partial while every answer to the selected question is present. Do not substitute the whole-run denominator for the filtered denominator. `sourceComplete` is true only when the source run reached `completed`; it does not tell you whether this query has all its intended answers. Use `lifecycle` for execution and recovery state. Use `run_get` with `view: "context"`, the run ID and one returned handle pair to retrieve that exact frozen packet and respondent-visible state; the response contains one evaluation rather than every context in the run. When the source is still progressing, describe the matches as current results and say more may match after completion. Query again after completion if the user needs the final cohort. A route outcome and a typed answer are separate facts; for example, `left-lost-interest` does not prove the respondent selected a typed “lost interest” answer.

For a Choice question that explicitly maps option IDs to exact material IDs with `materialOptions`, a matching answer also includes `selectedMaterial`: `materialId`, exact `text`, author-supplied `sourceId` and `sourceSha256`, and Sheg-computed `textSha256`. Unmapped options, including no-fit, have no material reference. The agent authors candidate boundaries and labels. Use the returned `materialId` in a follow-on request's `context.materialIds`, with the returned evaluation/context handles, to ask about the selected candidate in that respondent's chosen context.

Build a follow-on request yourself from the user's intended question and the evidence you selected. Sheg does not decide which result is relevant or what unit counts as a section, paragraph, or “bit.” Selection can repeat the query criteria for a live result set or pass exact `{evaluationId, contextId}` pairs returned by `run_query`. A user with a clear question can supply it directly; when their expectation is broader, decide which answers would satisfy them, then select the evidence and typed question that can answer it. Use `run_inspect` on that exact follow-on when a fit preview would help; `run_start` performs admission validation itself.

### Reuse each respondent's selected material

When a user wants to follow up on material respondents selected, query the source Choice question and pass the resulting source question selection to one follow-on request with `context.includeSelectedMaterial: true` and an isolation mode (`fresh-material` or `omit-history`). Sheg resolves each answered mapped Choice response to its exact saved material and uses that as the same respondent's next stimulus. Add shared framing, such as a pull quote, through the follow-on's explicit shared material fields. Ask the follow-up question about the selected material in that shared frame.

For example, if respondents selected among seven paragraphs for a pull quote, include the paragraph each respondent selected and the shared pull quote, then ask whether that paragraph expresses the pull quote. Each respondent sees their own selected paragraph with the shared quote in isolation. Sheg does not extract a paragraph from an answer or infer a material mapping. Unmapped choices, including no-fit, remain visible in selection coverage and do not receive a follow-on group. Read `selectionCoverage` and `selectionExclusions` to report which source answers produced groups and why others were excluded. Do not split this into one follow-on run per paragraph.

When a Noul proposition needs explicit true/false meanings, supply `criteria.true` and `criteria.false` on the question. Use the [run request schema](../assets/run-request.schema.json) for field names and constraints.

For the whole source question, select by question ID without an answer filter. `includeSelectedMaterial` resolves each eligible answer's saved Choice-to-material mapping. Put shared framing in `material`; the selected paragraphs are resolved per respondent rather than listed as shared material.

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

The ID and call allowance above are illustrative. Use the actual source run ID and choose allowance for the eligible groups and provider. The source-question selection includes mapped and unmapped answers so coverage explains exclusions. With `includeSelectedMaterial`, criteria must identify a question and cannot contain an answer filter. For a user-requested subgroup, first use `run_query` with the desired answer filter, then pass its exact `{evaluationId, contextId}` pairs as `selection.references`. Query the full source question separately when reporting the subgroup's share of the original cohort; follow-on selection coverage describes only the selected references.

Choose a follow-on context explicitly:

- `recorded` changes only the question. It preserves the selected turn's exact respondent perspective, material, and trajectory.
- `fresh-material` uses the saved perspective with explicitly supplied or selected material and an empty trajectory.
- `omit-history` uses explicitly selected material with the saved perspective and an empty trajectory. Pass `context.materialIds` to select exact material from that turn; this removes earlier exposure IDs and order from the model input.
- `continue` retains the selected turn and adds its completed typed answer to the trajectory before asking the next question. Optional explicit material is added for the next question. A pending turn has no answer to continue.

Each accepted follow-on is its own durable run with its own ID, frozen packets, answers, and source lineage. The source material is copied into those packets, so a follow-on remains readable if its source run is deleted. `run_get` with `view: "request"` reports whether the source record is still live or historical. `run_delete` dry-run lists dependent follow-on run IDs that would be retained.

Use `run_get` with `view: "status"` to inspect progress, `view: "request"` to recall frozen inputs and respondent packets, `view: "answers"` to retrieve typed answers and failures, or `view: "journey"` to retrieve respondent-local turns, exposures, response history, routes, and terminal states. Answer pagination uses the returned cursor and a limit from 1 to 200. Use `view: "attempts"` to inspect physical calls, their linked evaluation IDs, settlement status, and any provider failure. Attempt history also paginates with the returned cursor and a limit from 1 to 200. `run_query` also paginates with a returned cursor. `run_list` supports status, label, time, and referenced-material filters when the run ID is not at hand. Discovery and query never start or resume work.

Report completed, failed, pending, unreached, and total evaluation counts with run status. A completed journey has answered its reached questions; unvisited branch questions have no evaluation rows. A partial run retains valid answers alongside failures. Run-wide provider failure stops further dispatch. Cancellation allows an in-flight call to settle and preserves its answer, then prevents the next call.

Independent questions share frozen state without seeing sibling answers. Jev may batch or split them while local Laya sends singletons. `run_inspect` reports the minimum physical calls after that planning; retries can increase actual use. `maxCalls` counts physical attempts, including uncertain dispatches, rather than answer count. Confirmed pre-dispatch failures consume none. Query by `questionId` to select one answer. A question dependent on a sibling answer belongs in a follow-on selecting its completed context, or in a later journey task with explicit answer history.

An uncertain in-flight call consumes its reserved allowance because the provider may have received it. Reads reconcile expired workers as interrupted and never retry them. `lifecycle.state` is `active`, `stopped`, or `complete`; detailed `status` describes the outcome. Resume only on the user's direction and `lifecycle.resume.eligible: true`, keeping the original allowance. If ineligible, report its exact `reason`. `partial_journey` means failed evaluations cannot all be matched safely to known failed respondent turns. Completed and cancelled runs cannot resume; active runs already have an execution owner. Safe typed-answer details identify observed validation rules, not guessed causes. Failure evidence remains in attempt history after retry reopens an evaluation.

### Resume an eligible partial journey

When a journey is partial, inspect `run_get` status, journey, and attempts before proposing recovery. Explain which respondents completed, which respondent stopped at a failed reached turn, what earlier answers and route that respondent already recorded, and whether an attempt is unresolved. Failed, pending, and unreached work is not a negative answer. Do not describe the run as complete because one respondent or earlier turn succeeded.

If the lifecycle says `resume.eligible: true` and the user explicitly asks to continue, call `run_resume` with that run ID. Sheg keeps the same run ID, original request, failed evaluation and frozen packet, completed respondents and turns, respondent exposure and response history, route, attempt history, and original `maxCalls`. It retries only the known failed turn for each failed respondent; it never replays completed work or increases the allowance. A newly valid answer may choose the next branch, which is reached only after that retry succeeds. A failed retry remains partial and visible in attempts; the user can ask to resume again only while lifecycle eligibility remains true. If eligibility is false, report its exact reason and do not retry or substitute a new run without the user's direction.

## Delete selected runs

Deletion is explicit and accepts 1 to 200 unique run IDs. Use `run_delete` with `dryRun: true` when a preview would help. The preview lists each selected run's status, evaluation and attempt counts, and whether active work blocks deletion. A preview does not remove data. The delete operation validates the whole selection itself, so the preview is not a reservation. If any run is missing or active, deletion is all-or-none. Cancel active work, poll until it is terminal, then submit the explicit selection again. Deletion removes the run and its associated evaluation and attempt records. The result distinguishes committed deletion from optimization maintenance: `maintenance.optimization` is `completed` or `failed`, and a failure includes `failureCode`. A maintenance failure does not undo the reported deletion; inspect or retry with `run_storage`. Never manipulate SQLite files or sidecars directly.

## Inspect and optimize storage

Call `run_storage` with `operation: "inspect"` for SQLite and foreign-key integrity status, database byte size, and run, evaluation, attempt, and active-run counts. The report contains no host path or SQL. Call `run_storage` with `operation: "optimize"` to ask Sheg to run SQLite optimization. Sheg refuses to optimize when its integrity check fails. Inspection reconciles expired worker leases before counting active runs, but never launches or resumes work. Successful deletion also triggers Sheg-managed optimization. Do not run maintenance at harness startup or manually alter datastore files.

If startup cannot open or migrate the datastore, `run_storage` remains available while study operations are blocked. Inspect compatibility and backup availability. Reset is a separate destructive recovery action requiring the user's direction and `{"operation":"reset","confirmation":"RESET SHEG DATASTORE"}`. Sheg preserves a verified SQLite backup when readable, or quarantines original files when unreadable, then creates a fresh active store. Reset does not make historical runs available in that fresh store.

Provider-reported cost or a published-rate estimate may appear per decision when available. Cost evidence is optional and may differ by the user's API account. Sheg does not total it, treat it as an accounting record, or require billing reconciliation. Users can consult their provider dashboard for exact account usage.
