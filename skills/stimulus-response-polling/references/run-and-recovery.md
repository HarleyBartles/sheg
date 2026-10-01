# Run and recover a poll

## Connect a Jev key or defer

When installing Sheg or choosing Jev without a saved key, offer **Connect
TypeSafe**, **Connect OpenRouter**, or **Skip for now**. The user may connect
both by repeating setup. Skipping permits keyless request design and local
Laya; it cannot authenticate a Jev run.

Resolve the installed plugin root from this skill's location. Give the user
this PowerShell command with the actual absolute helper path, or open a visible
interactive terminal, run the command there, and let the user type only the key
into its hidden prompt:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\path\to\installed\sheg\dist\credentials\windows-credential.ps1" -Operation Setup -TargetName Sheg/Jev/TypeSafe
```

Use `Sheg/Jev/OpenRouter` for OpenRouter. `Status` reports safe availability,
`Setup` replaces the entry, and `Remove` deletes it. The helper writes directly
to Windows Credential Manager. If secure storage fails, stop setup and explain
the limitation. Never use chat, MCP parameters, environment variables, command
arguments, or files to carry the key. macOS and Linux are not supported yet.
Setup itself makes no paid request. Offer it again when a skipped route is
needed; never fall back to the other route's credential.

Credential Manager stores generic values as bytes. Sheg can read UTF-8 tokens,
including odd-length values, as well as the UTF-16LE format written by its
setup helper. If an entry is present but uses another unreadable encoding,
`run_start` returns `provider_credential_malformed` with a safe explanation
and a setup instruction. The key itself is never included. This is distinct
from a missing key or an unavailable credential store.

## Start and inspect a run

Build the simplest request that matches the user's goal: exact inline material,
one or more distinct respondent profiles, one typed Choice, Score, or Noul
question (or a finite sequence/response-routed graph when multiple stages are
needed), one provider, and an adequate `maxCalls` limit. Choose material units,
questions and response options from the user's question. Do not invent stages
or add questions that do not help answer the requested question.

Call `run_inspect` with the exact request. It validates the shape and measures
fit without inference or persistence. Resolve invalid input, context overflow,
and unavailable fit before calling `run_start`. Do not trim user material,
switch providers, or weaken a question without explaining the proposed change
and checking that it preserves the user's intent.

For a hosted Jev run, obtain explicit user authorization for the study and its
maximum physical call count. Sheg does not set a spend limit or account for
provider billing. Jev reads the selected route's key from Windows Credential
Manager; never request a key in chat or store it in a request. Laya requires a
checkpoint-matched context fit measurer and a running local service. If fit
cannot be verified, the adapter rejects the request before inference.

Call `run_start` with a fresh UUID `submissionId` and the inspected request. It
returns a durable `runId` after persistence and worker launch. Preserve both
identifiers. If the tool response is lost, retry the identical request with
the same submission ID; that returns the existing run and does not dispatch a
second worker. A changed request needs a new submission ID.

## Discover and interpret results

Use `run_get` with `view: "status"` to inspect progress, `view: "request"` to
recall frozen inputs and respondent packets, `view: "answers"` to retrieve
typed answers and failures, or `view: "journey"` to retrieve respondent-local
turns, exposures, response history, routes, and terminal states. Answer
pagination uses the returned cursor and a limit from 1 to 200. `run_list`
supports status and label filters when the run ID is not at hand. These reads
never start or resume work.

Report completed, failed, pending, and total evaluation counts together with
the run status. A completed run has an answer for each respondent; a partial
run may include both answers and respondent-local failures. A run-wide provider
failure stops further dispatch. If cancellation is requested during an active
provider call, let that call settle and preserve its answer; Sheg does not send
the next respondent.

Provider attempts are not new responses. An uncertain in-flight call consumes
its reserved physical-call allowance because the provider may have received
it. Expired workers appear as interrupted, and a read will not retry them.
An interrupted run does not restart on its own. When the user wants it to
continue, call `run_resume` with its run ID. The same ID, frozen request,
completed answers, attempt history, and original `maxCalls` remain in force.
An uncertain in-flight call is charged once because the provider may have
received it. Only one concurrent resume request launches a worker. Prepared
runs are returned as-is; running and terminal runs are not resumable.

## Delete selected runs

Deletion is explicit and accepts 1 to 200 unique run IDs. First call
`run_delete` with `dryRun: true`. The preview lists each selected run's status,
evaluation and attempt counts, and whether active work blocks deletion. A
preview does not remove data. Sheg rechecks the whole selection at deletion
time, so the preview is not a reservation. If any run is missing or active,
the delete is all-or-none. Cancel active work, poll until it is terminal, then
submit the explicit selection again. Deletion removes the run and its
associated evaluation and attempt records. Never manipulate SQLite files or
sidecars directly.

## Inspect and optimize storage

Call `run_storage` with `operation: "inspect"` for SQLite and foreign-key
integrity status,
database byte size, and run, evaluation, attempt, and active-run counts. The
report contains no host path or SQL. Call `run_storage` with
`operation: "optimize"` to ask Sheg to run SQLite optimization. Sheg refuses
to optimize when its integrity check fails. Inspection reconciles expired
worker leases before counting active runs, but never launches or resumes work.
Successful deletion also triggers Sheg-managed optimization. Do not run
maintenance at harness startup or manually alter datastore files.

Provider-reported cost or a published-rate estimate may appear per decision
when available. Cost evidence is optional and may differ by the user's API
account. Sheg does not total it, treat it as an accounting record, or require
billing reconciliation. Users can consult their provider dashboard for exact
account usage.
