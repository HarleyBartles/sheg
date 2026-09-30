# Run and recover a poll

## Connect a Jev key or defer

When installing Sheg or choosing Jev without a saved key, offer **Connect
TypeSafe**, **Connect OpenRouter**, or **Skip for now**. The user may connect
both by repeating setup. Skipping permits keyless study preparation and local
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

## Run and recover

For a new run, first read [prepare and trace](prepare-and-trace.md) and call
`poll_check` with the exact manifest, frozen cohort, provider, and call limit.
Resolve validation errors before considering `poll_start`. `poll_check` is
keyless and makes no inference call.

Before `poll_start`, report the provider, arm count, distinct respondent
count, respondent-arm cell count, output directory, and maximum calls. For
hosted Jev, obtain explicit user authorization for the study and maximum call
count. Sheg does not set a spend limit or account for provider billing.

- Keep one provider route for a run. Jev reads the selected route's key from
  Windows Credential Manager. Never request a key in chat or store it in a
  manifest. `poll_start` and `poll_resume` reject a missing secure credential;
  `poll_check` remains keyless.
- `maxCalls` bounds physical provider attempts, including retries. Failed and
  interrupted requests consume calls because the provider may have received
  them. A zero-attempt cancellation releases its reservation.
- Laya requires a checkpoint-matched context fit measurer. If fit cannot be
  verified, the adapter must return unsupported input without dispatching. Do
  not trim content, change providers, or claim the inference ran.

`poll_start` returns a run ID. Use `poll_status` to inspect progress. Call
`poll_cancel` when cancellation is requested. Use `poll_resume` for a partial
or failed run after checking the stored call allowance and unchanged study and
provider settings.

Provider-reported cost or a published-rate estimate may appear per decision
when available. Cost evidence is optional and may differ by the user's API
account. Sheg does not total it, treat it as an accounting record, or require
billing reconciliation. Users can consult their provider dashboard for exact
account usage.

Recovered interruptions are recorded with consumed attempts and candidate active
cells at run level. Candidate cells do not establish which request reached the
provider. Observed provider failures retain per-cell failed-attempt counts.
