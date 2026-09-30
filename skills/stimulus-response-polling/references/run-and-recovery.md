# Run and recover a poll

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
