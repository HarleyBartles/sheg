# Standalone System One Polling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` (recommended) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an ambient Codex plugin whose manifest-only polling harness runs reproducible simulated-reader studies against explicitly selected Jev or local Laya.

**Architecture:** Port the Portfolio manifest, cohort, prompt, and journey behavior into a provider-neutral Python package, then add two bounded decision adapters, durable job control, a CLI, and an MCP wrapper over the same core. Keep editorial judgment in the skill, deterministic limits and evidence in the harness, and model transport in adapters.

**Tech Stack:** Python 3.12+, `openrouter==1.2.21` and its `httpx` transport for Jev, `httpx` for Laya, an MCP Python SDK pinned at implementation time after checking its current public API, `pytest` for behavior tests, Codex plugin manifest and `mcp.json`.

**Spec:** `.agents/specs/2026-09-26-system-one-polling-design.md`

**Execution Strategy:** `executing-plans`. The tasks are tightly coupled: manifest validation feeds the prompt renderer, route semantics feed budget and checkpoints, and both providers must satisfy one decision contract. One inline integration context is the better fit, with focused RED/GREEN checks per task and one fresh whole-branch review. The current worktree is the sole implementation workspace. A bounded specialist subagent can help with an independently checkable question, such as verifying the Laya wire schema, without handing off ownership of a plan task.

## Global Constraints

- Portfolio source is `Z:\portfolio` main at `9d0864d0f4d3da4e451168cfd14ec080636ad25c`, under `.agents/skills/simulated-reader-polling/`. Port from that revision; do not edit Portfolio or install over its skill.
- The versioned `0.0.5` experiment manifest is the sole study input. Do not port flat `--article`, the Portfolio extractor, or implicit workspace discovery.
- Resolve manifest-relative source references from the manifest directory. Verify source hashes before any decision call. Require explicit cohort and output directory for runs.
- Preserve `article_route`, `scan_entry`, optional-read visibility and terminal-offer origins, ordered history, future-blind prompts, condition/archetype denominators, and complete-journey resume.
- Provider selection never changes during a run; no automatic Jev/Laya fallback or local GPU/model startup. No silent input trimming.
- Jev requires call and monetary caps; Laya requires a call cap. No paid test calls in routine CI. Local spend is not billed by the provider or is unknown, never zero hardware cost.
- A poll is correlated simulation, not readership measurement or an automatic editorial score. Keep study charter and hypothesis out of reader-facing requests and reports.
- Keep a stimulus fingerprint separate from the provider-specific execution fingerprint. Never persist credentials or source text in checkpoints or reports.
- The plugin installs at the Codex user level from this repo's root. Do not add it to `agent-asset-marketplace` or require each consuming repo to install it.
- Before implementation, read this plan and its spec, the live source paths below, and the repository's guidance. Work only in `Z:\_agent-worktrees\system-one-polling\port-simulated-reader-polling` after confirming branch and clean baseline. Use behavioral RED/GREEN tests, not change-detector tests.

## File map and shared contracts

The executor may adjust private helpers but must preserve these public seams across tasks:

| File | Responsibility / exported seam |
| --- | --- |
| `src/system_one_polling/study.py` | `load_study(manifest_path: Path, cohort_path: Path) -> Study`; `Study` holds validated manifest, ordered `ReaderProfile` tuple, source hashes, and manifest directory. |
| `src/system_one_polling/prompts.py` | `render_question(study: Study, profile: ReaderProfile, stage: str, visible_text: str, criteria: dict[str,str], history: tuple[dict,...]) -> DecisionRequest`; `prompt_contract_hash() -> str`. The rendered state is identical for both providers. |
| `src/system_one_polling/decisions.py` | Immutable `DecisionRequest` and `DecisionResult` types; `validate_result(request, result) -> DecisionResult`; `DecisionProvider` async protocol `decide(request, *, max_attempts: int) -> DecisionResult`. Result carries choice, complete distribution, attempts, identity, latency, optional token usage, and cost status/value. |
| `src/system_one_polling/routes.py` | `run_journey(study, profile, condition, ask) -> JourneyResult`, with an async `ask(request) -> DecisionResult` callback; canonical article/scan behavior and events. |
| `src/system_one_polling/identity.py` | `stimulus_fingerprint(study) -> str`; `execution_fingerprint(stimulus: str, provider: ProviderConfig) -> str`. |
| `src/system_one_polling/providers/jev.py` | `JevProvider(config)` implements `DecisionProvider` and retains billed cost / retry evidence. |
| `src/system_one_polling/providers/laya.py` | `LayaProvider(config)` implements `DecisionProvider`; `check_fit(request, config) -> FitResult`; no truncation. |
| `src/system_one_polling/jobs.py` | `check_study`, `trace_study`, `start_run`, `run_status`, `cancel_run`, `resume_run`, `get_report`; `RunConfig` has manifest, cohort, provider, limits, output path, concurrency. |
| `src/system_one_polling/report.py` | `build_report(checkpoint) -> dict`; `compare_reports(left, right) -> dict` with stimulus and matched-completed-journey guard. |
| `src/system_one_polling/cli.py` | `main(argv: list[str] | None = None) -> int` around the job API. |
| `src/system_one_polling/mcp_server.py` | MCP tools around the job API, with no second execution engine. |

Keep committed fixture manifests, source text, and frozen cohorts in `tests/fixtures/`. Test output goes to temporary directories. Source references in tests must be explicit. Build package metadata in `pyproject.toml`; put portable plugin files at root `plugin.json`, `mcp.json`, and `skills/simulated-reader-polling/`. The current [OpenAI packaging guide](https://developers.openai.com/plugins/build/plugins) specifies this root layout; use `.codex-plugin/plugin.json` only if a proven Codex compatibility need remains.

## Review Focus

1. A source changes after `check` but before `start`: re-read hashes at dispatch and refuse calls (Tasks 1 and 7).
2. A Laya response names the generic model at top level but a different routing checkpoint: reject it, even if the choice is valid (Task 5).
3. One asynchronous request is in flight during cancellation: record its result and usage before marking the job cancelled, then dispatch nothing new (Task 7).
4. A process dies while a checkpoint says `running`: reconstruct `partial` from disk, require explicit resume, and do not rerun completed journeys (Task 7).
5. Two reports share a manifest but differ in cohort ordering or prompt contract: refuse cross-provider comparison (Task 8).

---

### Task 1: Manifest and frozen cohort package

**Files:** Create `pyproject.toml`, `src/system_one_polling/__init__.py`, `src/system_one_polling/study.py`, `src/system_one_polling/profiles.py`, `tests/test_study.py`, `tests/fixtures/article-v005.json`, `tests/fixtures/scan-v005.json`, `tests/fixtures/cohort.json`, and the fixture source files. Port `reader-archetypes.json` to `skills/simulated-reader-polling/assets/reader-archetypes.json`.

**Interfaces:** Consumes Portfolio `reader_panel_experiment.py` validation, compilation, and `load_experiment`; `reader_panel_source.py` `ReaderProfile`, `load_profiles`, and `validate_cohort`. Produces `Study`, `ReaderProfile`, `load_study`, `validate_manifest`, and normalized source records for Task 2 onward. `Study` is immutable at the API boundary; validated route records may remain dicts internally.

- [ ] **Step 1: Write focused failing tests.** Build one article and one scan fixture at version `0.0.5` using the source's existing fixture shapes. Assert both load, and assert changed source bytes, wrong SHA, duplicate profile ID, unknown archetype, omitted cohort, malformed scan target, and a relative source resolved against the manifest's directory all fail before a provider is created. Use a temporary copy for source-drift testing.
- [ ] **Step 2: Run RED.** `python -m pytest tests/test_study.py -q`; expect missing package or failing contract assertions. Install local development dependencies with `python -m pip install -e ".[dev]"` once `pyproject.toml` exists, then repeat the specific failing assertion before implementation.
- [ ] **Step 3: Implement.** Copy the source manifest validation and compile behavior before reorganizing it. Retain caps on manifest and visible bytes. Move generic profile parsing and archetype validation into `profiles.py`; omit `_structured_article`, `parse_article`, the Node extractor, and Portfolio paths. The manifest remains source of authored title/promise/route, while source records are independently hashed. Add package metadata with pinned runtime deps and a `dev` optional dependency group; Task 9 adds console scripts after their modules exist.
- [ ] **Step 4: Run GREEN and source checks.** `python -m pytest tests/test_study.py -q`; inspect the ported source against Portfolio's `validate_experiment`, `_validate_scan_surface`, `compile_experiment`, and `load_experiment` for lost conditions. Run `rg -n 'portfolio|extract-article|--article|workspace.py' src tests` and explain any fixture-only matches.
- [ ] **Step 5: Commit.** `git add pyproject.toml src tests skills && git commit -m "Port manifest and cohort contracts"`.

### Task 2: Provider-neutral decision and prompt contract

**Files:** Create `src/system_one_polling/decisions.py`, `src/system_one_polling/prompts.py`, `tests/test_decisions.py`, `tests/test_prompts.py`.

**Interfaces:** Consumes `Study` and `ReaderProfile` from Task 1. Produces `DecisionRequest` with `state`, one named choice question, ordered criteria, and offered labels; `DecisionResult` with `choice`, `probabilities`, `attempts`, `provider`, `model`, `checkpoint`, `latency_seconds`, `input_tokens`, `cost_status` (`billed` / `not_billed` / `unknown`) and `cost_usd: float | None`; `render_question`, `prompt_contract_hash`, and `validate_result`. Provider model identity stays outside the rendered reader state.

- [ ] **Step 1: Write RED tests.** For a two-choice question, accept only an exact complete set of finite probabilities with each value in `[0,1]` and a sum within a documented numeric tolerance, with selected label among offered labels, attempts from `1..max_attempts`, and valid cost-status/value combinations. Assert that future beat text, unopened aside body, charter/hypothesis, provider key, and provider name never appear in rendered `state`. Assert prior choices appear in order and deferred versus first-unseen terminal prompts differ. Assert the same `render_question` output is passed to both fake providers.
- [ ] **Step 2: Run RED.** `python -m pytest tests/test_decisions.py tests/test_prompts.py -q`.
- [ ] **Step 3: Implement.** Move `EXPERIMENT_CHOICE_LABELS`, criteria wording, and `render_experiment_request` logic from Portfolio `reader_panel_decisions.py` to provider-neutral `prompts.py`. Replace its hardcoded `model` with transport metadata set by adapters. Hash explicit versioned prompt contract content and renderer bytes; do not hash provider identity. Put generic result validation and `DecisionError` in `decisions.py`; preserve attempt count on errors.
- [ ] **Step 4: Run GREEN.** `python -m pytest tests/test_decisions.py tests/test_prompts.py -q` and compare rendered stages to Portfolio tests for scan, optional reads, and post-read effects.
- [ ] **Step 5: Commit.** `git add src tests && git commit -m "Separate reader questions from model transport"`.

### Task 3: One canonical journey engine and scripted trace

**Files:** Create `src/system_one_polling/routes.py`, `src/system_one_polling/trace.py`, `tests/test_routes.py`, `tests/test_trace.py`. Extend the fixtures with a two-aside article and a scan surface with dynamic entry choices.

**Interfaces:** Consumes `Study`, `DecisionRequest`, `DecisionResult`, and `render_question`. Produces `JourneyResult` containing reader, condition, ordered exposures and choice events, core outcome, optional outcomes, terminal state, completion flag, and any explicit unsupported-input reason; `run_journey(study, profile, condition, ask)`; `trace_study(study, script: Mapping[journey_key, list[str]]) -> list[dict]`, which runs the same renderer and route code with scripted choices and no network.

- [ ] **Step 1: Write RED route tests.** Use scripted decisions to prove attentive/skim/lost/satisfied terminal distinction, optional body hidden before open, core outcome captured before optional satisfaction effect, `deferred_reoffer` distinct from `first_offer_unseen`, two asides at early exit, scan entry-to-content mapping, navigation to unread entries, and no future article text in a question. Assert an incomplete scripted journey is rejected, not guessed. Reuse or adapt the meaningful Portfolio `test_reader_panel_experiment.py` cases named `test_two_aside_route_offers_unseen_and_deferred_reads_after_core_exit`, `test_reader_who_leaves_before_aside_gets_an_unseen_end_offer`, and `test_scanner_route_links_visible_entries_to_beat_and_aside_then_backfills_article`.
- [ ] **Step 2: Run RED.** `python -m pytest tests/test_routes.py tests/test_trace.py -q`.
- [ ] **Step 3: Implement.** Port one canonical `article_route` and `scan_entry` state machine from Portfolio `reader_panel_experiment.py`. Extract per-journey route behavior from its sync and async engines, rather than retaining two divergent copies. The `ask` callback receives each fully rendered question in sequence. Trace supplies validated synthetic `DecisionResult`s through that callback. Preserve the source's event and denominator-relevant fields so Task 8 can summarize them.
- [ ] **Step 4: Run GREEN.** `python -m pytest tests/test_routes.py tests/test_trace.py -q`; inspect the first, middle, terminal, and scan question payloads against source tests to confirm no hidden content leaks.
- [ ] **Step 5: Commit.** `git add src tests && git commit -m "Port canonical reader journeys and scripted trace"`.

### Task 4: Jev adapter and billed-attempt evidence

**Files:** Create `src/system_one_polling/providers/__init__.py`, `src/system_one_polling/providers/jev.py`, `tests/test_jev.py`; update `pyproject.toml` dependencies.

**Interfaces:** Consumes `DecisionRequest`, `DecisionResult`, `DecisionProvider` from Task 2. Produces `JevConfig(model: str, api_key_env: str = 'OPENROUTER_API_KEY')` and `JevProvider(config)` implementing async `decide(request, *, max_attempts)`; Task 7 validates its configuration before dispatch. A `DecisionError` exposes attempted wire calls and whether provider charges remain unknown after failure.

- [ ] **Step 1: Write RED tests with mock transport.** Verify typed choice request shape, exact response model allowlist including dated Jev revision, complete probabilities, billed `usage.cost`, token usage when supplied, latency, SDK overload and connection retries counted per wire request, no retry for authentication error, cap at `max_attempts`, and unknown charge reconciliation on failed attempts. Assert no key appears in exception text or persisted request representation. Adapt the behavior of Portfolio `test_reader_panel_decisions.py` tests rather than copying obsolete hardcoded-model assumptions.
- [ ] **Step 2: Run RED.** `python -m pytest tests/test_jev.py -q`.
- [ ] **Step 3: Implement.** Port Portfolio's OpenRouter Decisions SDK transport and request-local `httpx` attempt hooks. Map neutral request to SDK envelope; normalize the SDK response through `validate_result`. Keep retries inside the allowed attempt reservation. Require `usage.cost` for successful Jev choices. Close sync and async clients on shutdown.
- [ ] **Step 4: Run GREEN.** `python -m pytest tests/test_jev.py -q`; run without a real API key or hosted request.
- [ ] **Step 5: Commit.** `git add src tests pyproject.toml && git commit -m "Add bounded Jev decision adapter"`.

### Task 5: Laya adapter, context fit, and checkpoint provenance

**Files:** Create `src/system_one_polling/providers/laya.py`, `tests/test_laya.py`, `docs/local-laya.md`; update `pyproject.toml` for `httpx` if needed.

**Interfaces:** Consumes Task 2's decision contract. Produces `LayaConfig(base_url: str, checkpoint: str, context_limit: int, precision: str | None, timeout_seconds: float)`, `FitResult(fits: bool, reason: str | None, measured_tokens: int | None)`, `check_fit(request, config)`, and `LayaProvider(config)` implementing `DecisionProvider`. A fit failure is an explicit unsupported-input result before dispatch, never a shortened prompt.

- [ ] **Step 1: Write RED tests with a fake `/v1/systemone` HTTP service.** Probe available endpoint/config identity; accept top-level generic model only when response routing checkpoint matches configured checkpoint; reject missing/different routing checkpoint, unknown label, incomplete probabilities, and malformed response. Verify an over-limit full rendered request fails without a network call, and an unmeasurable fit also fails. Verify local charge is `not_billed` or `unknown`, never fabricated `0.0` billed dollars. Verify an unavailable local service raises a local error and does not instantiate Jev. Capture checkpoint, precision, and independently observable revision or explicit `unknown`.
- [ ] **Step 2: Run RED.** `python -m pytest tests/test_laya.py -q`.
- [ ] **Step 3: Implement.** Use the documented Laya endpoint schema from the locally installed service or current upstream project before binding fields; record the verified schema and version in `docs/local-laya.md`. Serialize the complete reader question, count against the checkpoint's configured context using a tokenizer or an endpoint-provided fit method verified for that checkpoint, and fail closed if neither is available. Never use byte/4 estimation as proof of fit. Inspect response routing metadata, not only the generic top-level model. Keep the service URL explicit and do not start a GPU process.
- [ ] **Step 4: Run GREEN.** `python -m pytest tests/test_laya.py -q`. If a configured local service is running, perform one separate opt-in integration check with a synthetic two-choice request and save observed identity/fit evidence in the handoff; routine CI uses fakes only.
- [ ] **Step 5: Commit.** `git add src tests docs pyproject.toml && git commit -m "Add local Laya decision adapter"`.

### Task 6: Identity and shared budget ledger

**Files:** Create `src/system_one_polling/identity.py`, `src/system_one_polling/budget.py`, `tests/test_identity.py`, `tests/test_budget.py`.

**Interfaces:** Consumes Tasks 1-5. Produces `ProviderConfig = JevConfig | LayaConfig`, `stimulus_fingerprint(study) -> str`, `execution_fingerprint(stimulus: str, provider: ProviderConfig) -> str`, and `BudgetLedger(max_calls: int, max_usd: float | None)` with async `reserve(max_attempts, estimated_usd) -> Reservation`, `settle(reservation, result_or_error) -> None`, and `reconcile(unpriced_usd: float) -> None`. Both config types expose provider kind, model/checkpoint, endpoint identity, temperature/precision when set, and other decision-affecting settings; neither fingerprint includes credentials.

- [ ] **Step 1: Write RED tests.** Assert stimulus hash changes with ordered cohort, source SHA, manifest text, or prompt contract, but remains equal for Jev and Laya with identical stimulus. Assert execution hash changes with provider, checkpoint/model, precision, and other decision settings. Use concurrent fake reservations to prove the call cap and Jev estimated spend cap cannot be oversubscribed, and a failed possibly billed Jev attempt blocks further spending until an explicit nonnegative reconciliation. Assert Laya requires calls but no USD cap and never records fabricated billed cost.
- [ ] **Step 2: Run RED.** `python -m pytest tests/test_identity.py tests/test_budget.py -q`.
- [ ] **Step 3: Implement.** Canonicalize ordered manifest/cohort/source/prompt inputs for stimulus; hash provider config separately for execution. Reserve worst-case allowed wire attempts and estimated Jev spend under one async lock; settle actual usage and release unused reservations. Carry `unknown` billing evidence after a failed attempt and require explicit reconciliation on resume. Reject nonfinite/negative limits and usage.
- [ ] **Step 4: Run GREEN.** `python -m pytest tests/test_identity.py tests/test_budget.py -q` and inspect the concurrent reservation test for actual overlap, not merely sequential calls.
- [ ] **Step 5: Commit.** `git add src tests && git commit -m "Separate polling identity and budget ledger"`.

### Task 7: Durable job controller and recovery

**Files:** Create `src/system_one_polling/jobs.py`, `src/system_one_polling/checkpoints.py`, `tests/test_jobs.py`; modify `src/system_one_polling/routes.py` only if the per-decision callback needs cancellation visibility.

**Interfaces:** Consumes Tasks 1-6. Produces `RunConfig(manifest_path: Path, cohort_path: Path, provider: ProviderConfig, output_dir: Path | None, max_calls: int, max_usd: float | None, concurrency: int)`, `check_study(config) -> dict`, `trace_study(config, script: Mapping[journey_key, list[str]]) -> list[dict]` delegating to Task 3, `start_run(config) -> str`, `run_status(output_dir: Path, run_id: str) -> dict`, `cancel_run(output_dir, run_id) -> dict`, `resume_run(config, run_id, *, reconciled_unpriced_usd: float | None = None) -> str`, and `get_report(output_dir, run_id) -> dict` (raw checkpoint until Task 8 adds a report builder). `output_dir` may be `None` only for check/trace. A checkpoint format version plus stimulus and execution fingerprints protects resume. Run states are `prepared`, `running`, `completed`, `partial`, `failed`, and `cancelled`.

- [ ] **Step 1: Write RED tests with controlled async providers.** Assert `check` has no provider call, requires source hashes/cohort and limits, and rechecks hashes at start. Assert concurrent independent journeys overlap but each remains sequential. Assert status reconstructed after process restart marks stale `running` as `partial`. Assert resume skips completed journeys but restarts incomplete ones and rejects mismatched provider/model/settings, even with the same stimulus. Assert cancellation lets in-flight calls finish and record usage but begins no new journey. Assert checkpoints exclude credentials and raw source text.
- [ ] **Step 2: Run RED.** `python -m pytest tests/test_jobs.py -q`.
- [ ] **Step 3: Implement.** Use an explicit output directory, unique run ID, atomic replace for checkpoint JSON, and a lock/ownership scheme that prevents two processes from resuming the same run. Call Task 6's ledger before each provider dispatch. Keep condition/readers in stable order irrespective of completion order. Record incomplete journeys separately from completed ones. Do not accept old Portfolio checkpoint format for resume. `start_run` must return after durable job registration and run work in a managed process that can outlive the MCP request; no untracked daemon thread tied to a server turn.
- [ ] **Step 4: Run GREEN.** `python -m pytest tests/test_jobs.py -q`; terminate a controlled worker process mid-journey in the test to prove disk recovery rather than in-memory status. Inspect checkpoint fields manually for hashes, state, budget, identity, and credential absence.
- [ ] **Step 5: Commit.** `git add src tests && git commit -m "Add durable polling jobs and recovery"`.

### Task 8: Evidence reports and matched-run comparison

**Files:** Create `src/system_one_polling/report.py`, `tests/test_report.py`; extend `src/system_one_polling/jobs.py` report retrieval only to call this module.

**Interfaces:** Consumes Task 7 checkpoint plus `JourneyResult`. Produces `build_report(checkpoint) -> dict`, `compare_reports(left, right) -> dict`, both JSON-serializable. Comparison is defined only over common completed `(reader_id, condition_id)` keys under equal stimulus fingerprints.

- [ ] **Step 1: Write RED tests.** Assert per-choice exposure/history events, completed versus partial denominator, archetype and condition summaries, optional and scan breakdowns, attempts/latency/token/billing evidence, model/checkpoint and revision-unknown provenance. Assert a same-manifest report with reordered cohort or changed prompt contract is refused; a Jev/Laya pair with equal stimulus aligns only matched completed journeys and separately counts failed/unsupported ones. Assert agreement is described as agreement, not accuracy or reader prevalence. Port relevant Portfolio `test_optional_summary_breaks_down_completed_journeys_by_outcome_and_archetype` and report-denominator tests.
- [ ] **Step 2: Run RED.** `python -m pytest tests/test_report.py -q`.
- [ ] **Step 3: Implement.** Derive summaries from completed journey records and preserve intended cohort counts as distinct denominators. Keep unknown provider charges and unknown revisions explicit; include source hashes and fingerprints, not draft text. Reuse source `_optional_summaries`, `_scan_summaries`, and `_performance_summary` semantics where they apply, with provider-neutral usage fields.
- [ ] **Step 4: Run GREEN.** `python -m pytest tests/test_report.py -q`; review a rendered sample JSON report for custody and wording.
- [ ] **Step 5: Commit.** `git add src tests && git commit -m "Report polling evidence and matched comparisons"`.

### Task 9: CLI and MCP operations over the same core

**Files:** Create `src/system_one_polling/cli.py`, `src/system_one_polling/mcp_server.py`, `tests/test_cli.py`, `tests/test_mcp.py`; update `pyproject.toml` console scripts and dependency pins.

**Interfaces:** Consumes Task 7 job API and Task 8 reports. Produces CLI subcommands `check`, `trace`, `start`, `status`, `cancel`, `resume`, `report`, `compare`; MCP tools `poll_check`, `poll_trace`, `poll_start`, `poll_status`, `poll_cancel`, `poll_resume`, `poll_report` (and `poll_compare` for report parity). Every command/tool uses the same `RunConfig` parser and job functions.

- [ ] **Step 1: Write RED tests.** Assert manifest-only arguments, mandatory cohort/provider and provider-specific caps, plus mandatory output directory for `start`/`resume`; invalid provider is refused before a network call. Assert check/trace work without credentials, output directory, or output mutation; start returns a durable run ID quickly; status/cancel/resume/report work after a server restart; and no provider fallback occurs. Assert MCP tools expose structured error/status payloads without leaking keys, and CLI/MCP produce the same underlying report for a scripted fake provider.
- [ ] **Step 2: Run RED.** `python -m pytest tests/test_cli.py tests/test_mcp.py -q`.
- [ ] **Step 3: Implement.** Provide explicit provider options and local service URL/checkpoint/context settings, no implicit checkout-based defaults. `mcp_server.py` is a thin MCP SDK tool registration layer; pin SDK version after checking its current official API. Declare a `polling-mcp` console script as well as `polling`, and add `python -m system_one_polling.cli` for diagnosis. Both entry points must resolve from an installed package, not a `Z:` path.
- [ ] **Step 4: Run GREEN.** `python -m pytest tests/test_cli.py tests/test_mcp.py -q`; run `python -m system_one_polling.cli --help` and start the MCP server with stdio in an isolated smoke harness that lists tools and calls `poll_check` against a fixture. No hosted call.
- [ ] **Step 5: Commit.** `git add src tests pyproject.toml && git commit -m "Expose polling jobs through CLI and MCP"`.

### Task 10: Ambient plugin, skill, installation, and full handoff proof

**Files:** Create `plugin.json`, `mcp.json`, `skills/simulated-reader-polling/SKILL.md`, `skills/simulated-reader-polling/references/designing-poll-studies.md`, `skills/simulated-reader-polling/references/assembling-a-cohort.md`, `skills/simulated-reader-polling/references/experiment-manifest.md`, `skills/simulated-reader-polling/references/operating-the-harness.md`, `skills/simulated-reader-polling/references/interpreting-poll-results.md`, `skills/simulated-reader-polling/references/reader-archetype-catalogue.md`, `README.md`, `docs/install-codex.md`, `tests/test_plugin_package.py`. Modify copied references so all commands, provider claims, and links reflect the standalone implementation.

**Interfaces:** Consumes all public CLI/MCP seams. Produces one installable plugin root and user-level installation instructions. Root plugin manifest describes bundled skill and MCP launch. Any local catalog entry references this repo; no duplicate editable plugin source.

- [ ] **Step 1: Write RED packaging tests.** Validate plugin and MCP JSON files parse, skill references exist, every documented CLI subcommand appears in `--help`, no `Z:`/Portfolio/extractor dependencies remain in installed paths, and a copy of the plugin in a temporary directory launches its MCP command without the source checkout. Assert the skill says simulated results are not audience measurements, requires cohort freeze and rendered-stimulus inspection, and never promises automatic paid runs.
- [ ] **Step 2: Run RED.** `python -m pytest tests/test_plugin_package.py -q`.
- [ ] **Step 3: Implement.** Port the six editorial references and archetype catalogue, updating Portfolio-specific language and commands. Document installing from this repo at Codex user level, MCP process startup, environment variable for Jev, configured local Laya service, and version/update steps. Use the portable root `plugin.json` and `mcp.json` schemas in the current [OpenAI packaging guide](https://developers.openai.com/plugins/build/plugins) and [Agent Plugins stdio specification](https://agent-plugins.org/specification). Prefer `mcp.json` with `type: "stdio"`, `command: "uvx"`, and separate `args: ["--from", "${PLUGIN_ROOT}", "polling-mcp"]`; confirm Windows Codex expands `PLUGIN_ROOT` in args and the copied plugin launches from `uv`'s cache without writing into the installed plugin. If that exact launch fails, choose and document a validated plugin-relative launcher rather than a path back to the checkout. A personal catalog can be created as install metadata inside this repo if Codex requires it; the plugin implementation remains one root. Do not alter a global Codex installation as part of routine tests.
- [ ] **Step 4: Run GREEN and acceptance checks.** `python -m pytest -q`; run the CLI and MCP smoke checks from Task 9 in the copied plugin; run `rg -n 'Z:|portfolio|extract-article|--article|TODO|TBD' plugin.json mcp.json skills src docs README.md` and review legitimate source provenance mentions. From a fresh Codex chat after the user-level install, verify skill discovery and MCP tool startup. If this runtime cannot launch a fresh chat or install the plugin safely, record that as a handoff limitation rather than claiming proof.
- [ ] **Step 5: Finish.** Review the complete branch against the spec, current live Portfolio source behavior, and the five Review Focus cases. Use `/verification-before-completion`, `/requesting-code-review`, and `/completing-planning-artifacts` as required. Commit the source and test work. Publish only under the execution-stage authorization and repo policy; a Draft PR is the reviewable handoff if requested. Keep old Portfolio checkpoints historical and plan a separate frozen Jev/Laya study after this release.

## Acceptance evidence

- `python -m pytest -q` passes with fake Jev/Laya transports and real route fixtures; no hosted call is required.
- `polling check` and `polling trace` operate on manifest and cohort without a key or network; an unchanged study produces the same stimulus fingerprint across provider selections.
- A bounded local run and a bounded mocked Jev run each yield checkpoints, reports, identity/usage evidence, and restart-safe status/resume/cancel behavior. The local GPU integration check is opt-in and records the actual checkpoint routing identity.
- An installed plugin copy runs without Portfolio or this `Z:` checkout; fresh-chat Codex discovery and MCP startup are verified or explicitly recorded as unavailable.
- No Portfolio files, marketplace canonical sources, article content, or currently installed skill are changed by this port.
