# Jev provider routes and call limits

**Status:** approved for implementation by the user on 2026-09-30

## Intent

Let a Sheg user choose whether Jev runs through TypeSafe's native System One
API or OpenRouter, using the user's key for that route. Existing study
configurations continue to use OpenRouter unless the user explicitly selects
another route.

Assume Sheg has one installed user today. That user's current TypeSafe and
OpenRouter keys have already been copied into Windows Credential Manager.
There is no installed-consumer compatibility requirement for environment
variable credentials.

Every Jev configuration uses Windows Credential Manager for its selected
route's key. During installation or immediate onboarding, users can connect
either or both provider keys through an agent-guided PowerShell prompt, or skip
and connect later. The key-entry surface must be outside chat and MCP tool
arguments. Sheg must not read Jev credentials from environment variables.

Sheg limits runaway studies by limiting provider request attempts. It does not
act as an accounting product: it has no spend ceiling or cumulative billing
ledger. A run may display cost evidence attached to an individual provider
response, with its source clearly identified. The provider's dashboard remains
the place to check actual key usage and charges.

## Agreed design

### Route selection and configuration

Use the existing Jev provider kind with an explicit route:

```json
{
  "kind": "jev",
  "route": "typesafe",
  "model": "jev-latest",
  "endpoint": "https://api.typesafe.ai/v1/systemone",
  "timeoutMs": 30000
}
```

Supported routes are `openrouter` and `typesafe`. Route defaults select its
endpoint, model, and Windows Credential Manager target. Route selection is
independent of credential availability: never infer or fall back to the other
route. Read only the selected route's Windows Credential Manager entry
(`Sheg/Jev/TypeSafe` or `Sheg/Jev/OpenRouter`). If it is missing or cannot be
read, report a safe setup or secure-store error. Do not read `process.env` or
accept a key-source override in config, CLI, or MCP input.

For backward compatibility, a missing route means `openrouter`. Keep current
OpenRouter model and endpoint settings when explicitly set in old run
checkpoints; remove the obsolete `keyEnv` field during checkpoint migration.
Do not preserve environment-variable key lookup or `keyEnv` overrides. New
native configurations default to `jev-latest` and
`https://api.typesafe.ai/v1/systemone`. Existing OpenRouter defaults remain
unchanged. Endpoint overrides must use the selected route's HTTPS origin without URL
credentials. Saved paths on that origin remain supported; redirects are
rejected to preserve credential custody and physical-attempt counting.
Both routes use Sheg's fetch transport;
do not add the TypeSafe SDK. Sheg owns retries so each HTTP attempt is counted
once against the run's call limit. The current worker grants one attempt per
decision; any route retry policy that permits more attempts must reserve and
settle that full attempt count against `maxCalls`.

### Secure key onboarding

When a user installs Sheg with an agent, the agent offers `Connect TypeSafe`,
`Connect OpenRouter`, or `Skip for now` as part of installation onboarding.
The offer is optional; skipping does not block installation or local Laya. The
agent can show copyable PowerShell instructions, or open an interactive
terminal that prompts for the key without echo and writes it directly to
Windows Credential Manager for the current user. The key never passes through chat,
an MCP tool argument, shell command text, a manifest, checkpoint, or report.
Provide instructions to replace or remove either credential. Sheg's normal
interactive provider config selects a route and reads only that route's
credential from the secure store. Do not support environment-variable setup,
import, fallback, or automation.

The setup offer is optional and does not prevent installing Sheg or using local
Laya. If the user skips, explain that the selected Jev route needs its key
before a paid run and offer the secure setup surface again when relevant. Never
fall back to the other route because only one credential is configured.

Do not collect a key through standard MCP elicitation or an ordinary
model-callable tool parameter. Codex's plugin installer does not provide a
generic arbitrary-secret field for local stdio providers. The installation
agent therefore offers out-of-band PowerShell instructions or an interactive
local terminal prompt as part of onboarding; it must not ask the user to paste
the key into chat. Do not imply that a native installer key-entry dialog exists.
The setup path must write directly to Windows Credential Manager. If the
secure store is unavailable or rejects the write, explain the limitation and
stop guided key setup. Do not offer an environment-variable alternative.

### Platform secure-store contract

For this slice, store credentials in Windows Credential Manager, scoped to the
current user and separated by provider. The PowerShell setup prompt is only the
secret-entry surface; it must pass the hidden input directly to the Windows
credential API, not through command arguments, shell history, environment
variables, temporary files, or logs. Test save/read/replace/remove and
unavailable or rejected-write behavior on Windows without exposing fixture
secrets. See [Microsoft CredWrite](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credwritea).

A Windows mini-spike on 2026-09-30 transferred the existing process values for
`TYPESAFE_API_KEY` and `OPENROUTER_API_KEY` to generic credentials named
`Sheg/Jev/TypeSafe` and `Sheg/Jev/OpenRouter` using `CredWriteW`, without
printing either value. Both native writes succeeded and `cmdkey /list` showed
both target names. The environment variables were left unchanged. This proves
the local write path and target visibility only; it does not yet prove Sheg's
credential read integration.

Use the same credential-store lookup in Jev request execution, preflight,
packet sizing, and startup checks. Preflight reports whether the selected
route's vault entry is available, without exposing its value. Jev request
execution must never inspect an environment variable, even when one is set.

Migration path for this machine: the mini-spike has already created both
target entries. After the Sheg implementation lands, verify preflight reports
each vault entry available and make a Jev request successfully while the
environment variables are still present. This proves Sheg uses the vault
without depending on the variables. The user can then remove the variables;
Sheg must continue to run from Credential Manager. Sheg does not manage or
delete the user's environment variables.

macOS Keychain Services and Linux Secret Service over session D-Bus are future
iterations. Do not claim support or include unverified backend behavior in
this change. Linux implementations will need to handle unavailable or locked
Secret Service instances without plaintext fallback.

The store abstraction must not log or return secret values except to the
provider authentication path. Tests should assert save/read/replace/remove
behavior and unavailable/locked-backend errors without printing fixture
secrets.

### Requests and provider evidence

Both routes send the typed Jev request with the configured model, state, and
questions. Parse and validate each route's response shape at its adapter
boundary, then return the same domain decision and token-usage shape. A missing
cost field does not invalidate an otherwise valid decision.

Keep context-fit admission route- and model-specific. Use only a limit
documented for the selected native model or OpenRouter model. If the configured
model has no verified limit, preflight must mark fit unavailable and the run
must not make a paid inference request; do not apply OpenRouter's current
32,768-token assumption to native TypeSafe by analogy.

Cost is optional per-decision evidence, represented with an amount and a basis:

* `provider-reported`: the selected route returned a cost amount, such as
  OpenRouter's `usage.cost`.
* `published-rate-estimate`: Sheg derived an estimate from response token
  counts and a published rate applicable to the selected model.

Only show an estimate when the required token counts and a documented rate are
available. Keep rate values and their source/date explicit in maintained
provider metadata. If the model, token usage, or rate is unknown, omit the
estimate. Do not infer the user's final invoice from a public rate: actual
charges can depend on the provider account and settings. Do not add a
user-defined formula in this change. Reports may show per-decision cost
evidence, but must not sum it into a run spend total or label it as Sheg's
accounting of actual charges.

### Runaway-study control

Keep `maxCalls` as the run-wide ceiling on physical Jev request attempts,
including retries. This is distinct from `maxDecisions`, which bounds a
respondent's journey in the study graph. Continue reporting the reachable
minimum and maximum logical decision calls in preflight and whether the
configured attempt limit can cover the maximum. Do not add a spend ceiling.

The attempt ledger tracks `maxCalls`, used attempts, in-flight reservations,
and remaining attempts. It must atomically reserve enough capacity before
starting concurrent requests so they cannot collectively exceed `maxCalls`.
A physical attempt consumes the call allowance whether or not the provider's
billing outcome is known. If a process stops with an in-flight reservation,
recovery conservatively counts that reserved attempt as used because the
request may have reached the provider; it clears the reservation and continues
without a billing block. Remove USD reservation, charge-status, cumulative
billed amount, overspend, blocked-on-unknown-charge, and reconciliation
behavior. A failed or interrupted call is represented by its failure and
attempt evidence. It does not require the user to inspect a provider bill
before resuming; resumption remains subject to available call allowance and
the normal checkpoint/source identity checks.

### Identity, checkpoints, and recovery

Include route, model, and effective endpoint in Jev execution identity, so a
resume cannot silently change routes or destinations. Do not include secret
values, environment variable values or names, or credential source. A user's
selected key may be rotated or migrated from environment to Credential Manager
without changing the study's execution identity or blocking resume.

Bump the durable checkpoint format and provide a migration reader for existing
format-version-2 checkpoints. Normalize a missing Jev route to OpenRouter,
preserve its saved model and endpoint, discard obsolete USD ledger fields, and
retain used/reserved call counts. Recompute the new execution identity from
the checkpoint's normalized provider settings and current study inputs rather
than rejecting the checkpoint because its old fingerprint used the previous
identity formula. Persist the migrated checkpoint before further mutation.
Convert a legacy result with `chargeStatus: billed` and `chargeUsd` into
per-decision `provider-reported` cost evidence; remove legacy `chargeStatus`
values with no amount. Do not restore a run-level USD total. Convert any legacy
in-flight reserved calls into used calls, clear those reservations, and
discard obsolete money fields. Legacy `blocked` status caused solely by
unknown charges must not prevent resume. Checkpoint migration must not reset or
increase the remaining call allowance.

Remove `poll_reconcile` and the CLI `reconcile` command, their schemas,
references, and resume instructions. Resume does not require a user-provided
USD amount. Do not migrate old cumulative amounts into new reports as if they
were current accounting.

## User-visible behavior

* Config examples and documentation show both routes, route-specific defaults,
  secure key setup, optional deferral, and how to make a deliberate selection.
* Preflight reports whether the selected route's Windows Credential Manager
  entry is available, without exposing key material. Environment variables do
  not affect this status or provider authentication.
* Preflight continues to explain the logical call range and configured
  run-wide attempt ceiling. No projected USD spend ceiling is shown.
* Status and reports expose call use and remaining call allowance. Per-decision
  cost can be shown with its reported or estimated basis. There is no cumulative
  USD total, overspend state, or reconciliation action.
* Errors identify the selected route and safe failure category without
  including credentials, request bodies, or untrusted response bodies.

## Repository surfaces

Keep route configuration and behavior aligned across:

* `src/providers/jev.ts` and provider construction
* run config, preflight, packet sizing, and MCP schemas
* execution fingerprinting and checkpoint read/write/migration
* call-attempt reservation and settlement in the worker
* Windows Credential Manager lookup and availability reporting shared across
  provider execution and preflight
* decision result validation and per-decision report output
* CLI and MCP command registration/help
* README, `docs/providers/jev.md`, study-design packet budgeting, and polling
  skill setup/recovery guidance
* behavior tests for routes, vault-only credential resolution, rejection when
  only an environment variable exists, response parsing, retry attempt
  counting, call exhaustion, reporting, legacy migration, and resume identity

Add one ADR describing explicit Jev route selection, legacy OpenRouter
compatibility, and Sheg's boundary between call limiting and provider billing;
update `docs/decisions/README.md` in the same change.

## Branch, version, and publication workflow

The human approved this repo-resident spec on 2026-09-30. Implementation must
stay within its scope, guardrails, and branch/publication workflow.

After approval, feature work starts from the latest `origin/develop` and its
feature PR targets `develop`. The feature PR may be squash merged. Keep the
aligned package, lockfile, and plugin versions at their current value,
`0.1.0`, throughout feature work. Do not tag or publish a release as part of
SHEG-3. Once implementation is approved, run `npm run verify`, regenerate
derived outputs as required, and open the feature PR against `develop`.

After SHEG-3 merges, release preparation is a separate follow-on: prepare
`release/0.2.0`, promote it to `main`, and publish the first GitHub Release
separately after release verification. Version changes, release tags, and
release publication belong to that release preparation, outside SHEG-3.

## Out of scope

* Automatically choosing or switching routes from detected credentials.
* Any Jev authentication path that reads environment variables.
* macOS Keychain and Linux Secret Service credential backends; defer both to a
  future cross-platform credential-storage iteration.
* Adding the TypeSafe SDK or delegating retries outside Sheg's counted
  transport.
* Spend caps, spend projections presented as ceilings, cumulative USD
  accounting, or charge reconciliation.
* User-configured price formulas, account-specific rate discovery, and
  provider-dashboard integration.
* Changing study graph semantics or the per-respondent `maxDecisions` limit.
* Claiming native TypeSafe context limits that are not verified by provider
  documentation.
* Universal OpenAI Plugin Directory distribution of key-collection behavior
  without confirming policy compatibility. The current public plugin
  guidelines classify API keys as restricted credentials that plugins must
  not collect or process; this spec assumes local/repo-marketplace use.

## Acceptance criteria

1. Installation onboarding offers secure TypeSafe/OpenRouter key setup or
   deferral. The agent can show PowerShell instructions or open an interactive
   no-echo prompt that writes directly to the current user's Windows Credential
   Manager. Keys stay out of chat, MCP arguments, shell command text, and study
   files. Ordinary interactive use requires no environment-variable setup.
   macOS and Linux secure-store backends are explicitly deferred.
2. A new config can select either route explicitly and uses the route's
   endpoint/model defaults plus its secure-store credential. Missing route
   remains OpenRouter for old configs; credential availability never changes
   route. The Jev configuration schema does not accept `keyEnv` or another
   credential-source setting.
3. Preflight, packet sizing, startup validation, and Jev request execution use
   the same Windows Credential Manager lookup. Missing or unreadable entries
   fail safely. Environment variables are never read as Jev credentials.
4. A Windows integration test writes a fake credential, verifies preflight and
   the provider adapter use it, then verifies that a set environment variable
   cannot satisfy missing-vault authentication. This proves the vault-only
   contract without using real keys.
5. Both routes complete a valid choice response through fetch with normalized
   token usage. TypeSafe success does not require `usage.cost`; OpenRouter
   reported cost remains optional evidence.
6. Provider-reported cost and published-rate estimate are distinguishable in
   per-decision output. Unknown rates or missing token counts produce no
   estimate. No run-level USD total or spend gate is emitted.
7. Each physical attempt, including each retry, consumes the call allowance;
   hitting `maxCalls` prevents an additional attempt. Preflight still describes
   logical minimum/maximum decisions and call-limit sufficiency.
8. Route or endpoint changes fail the resume identity check. A v2 checkpoint
   with a Jev config missing route migrates to OpenRouter, preserves its call
   history, drops obsolete money fields, and resumes without charge
   reconciliation when call allowance permits.
9. CLI, MCP tools, docs, examples, and polling guidance no longer require spend
   caps or describe charge reconciliation. A decision record and index update
   capture the durable architecture boundary.
10. Repository validation passes with `npm run verify` before publication.

## References

* [TypeSafe API docs](https://api.typesafe.ai/docs)
* [TypeSafe JavaScript SDK guide](https://docs.typesafe.ai/sdk/javascript)
* [TypeSafe JavaScript SDK v0.6.0 source](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/client.ts)
* [TypeSafe OpenAPI](https://api.typesafe.ai/openapi.json)
* [TypeSafe pricing announcement](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
* [TypeSafe customer agreement](https://typesafe.ai/legal/mca)
* [OpenRouter Decisions API](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request)
* [Microsoft CredWrite](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credwritea)
* [SHEG-3](https://linear.app/harleys-workspace/issue/SHEG-3/support-native-typesafe-and-openrouter-jev-routes)
