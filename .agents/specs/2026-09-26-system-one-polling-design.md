# System One Polling plugin and harness

## Purpose and source

`system-one-polling` is the canonical source for an ambient Codex plugin that helps an agent design, run, and interpret structured polls of simulated readers. The same harness can run against hosted Jev or a locally served Laya checkpoint. A poll describes the choices made by specified simulated profiles under specified exposures. It does not measure real readership, population prevalence, article quality, or publication readiness.

The port starts from `HarleyBartles/portfolio` main commit `9d0864d0f4d3da4e451168cfd14ec080636ad25c`, at `.agents/skills/simulated-reader-polling/`. That source supplies the current skill, archetypes, manifest `0.0.5`, article and scan routes, optional-read semantics, prompt renderer, execution controls, reporting, and tests. This repo may reorganize those parts. It must preserve the study behavior called out below, rather than the old directory layout or OpenRouter-specific transport.

## Distribution and ownership

The repository root is one installable Codex plugin package. It owns the plugin manifest, `skills/simulated-reader-polling/`, a bundled MCP server, the standalone Python harness, and their tests. The plugin is installed at the Codex user level and is available across repositories. It does not require installation into each consuming repo or publication through `agent-asset-marketplace`. Any small personal catalog entry needed for Codex discovery points to this repo's plugin; it is installation metadata, not another editable copy.

The skill owns editorial judgment: form the study question, audit and freeze the cohort, inspect rendered requests, interpret results, and decide whether a paid run has authorization. The harness owns deterministic study execution and evidence. The decision adapters own model transport and response normalization. The MCP server exposes bounded harness operations to Codex; it does not make an agent turn for each reader decision.

The installed plugin must resolve its packaged files from its installed location. It must not rely on a live `Z:` checkout, a Portfolio path, or a specific consuming repository's `.agents` tree. The local Laya model and its weights remain in the user's separate local service. This plugin connects to that service; it does not bundle or silently start GPU weights.

## Study inputs and reader semantics

The versioned experiment manifest is the sole study input in the first release. The legacy flat `--article` path and Portfolio's Markdown/React extractor are outside this port. A manifest names its source files and hashes and authors the visible title, promise, route, conditions, and, when applicable, scan surface. The harness verifies source hashes before a run. It cannot certify that a human-authored manifest faithfully describes a rendered page, so the skill requires an editorial inspection of the actual stimulus.

Resolve relative source paths from the manifest's directory, and accept an absolute path only when the manifest explicitly supplies it. Do not discover or read other files from the invoking repository. A study may live outside its source repository, provided its source references and output directory are explicit.

Preserve the current `article_route` and `scan_entry` flows and the existing `0.0.5` manifest contract unless a deliberate version change is required by the provider-independent design. Preserve the distinct outcomes of attentive reading, skimming, stopping satisfied, and leaving after lost interest. Preserve optional-read visibility: an aside body is hidden until opened, deferred and previously unseen items have distinct end-offer origins, and core outcome is recorded before optional reading changes satisfaction. Preserve scan-entry visibility, choice history, and denominators. A prompt at any stage contains only text the simulated reader has encountered and prior choices in order. The study charter and hypothesis stay out of reader-facing state.

The durable archetype pool is bundled with the plugin. Article-specific profiles and their admission record are separate run inputs, frozen before outcomes are viewed. The harness validates their mechanical shape and fingerprints their exact ordered definitions; the skill owns semantic audit and cohort fairness.

## Decision contract and providers

The harness sends a provider-neutral decision request containing the reader state, one bounded typed question, and the offered criteria. The response contains the selected allowed label, the complete finite probability distribution over offered labels, attempted wire-call count, model and provider identity, latency, and any reported token and monetary usage. An absent local provider charge is represented as not billed by that provider, not invented OpenRouter usage or a claim that hardware has no cost. The harness rejects unknown labels, malformed probabilities, identity mismatches, missing required evidence, and provider errors before recording a choice.

The first release has two explicit adapters:

- **Jev:** use the existing hosted OpenRouter Decisions route and its SDK retry and billing evidence. A run declares the Jev model and requires a call cap and a monetary cap. Failed attempts with unknown charges retain the current reconciliation stop before resume.
- **Laya:** call a configured local `/v1/systemone` endpoint and name the intended checkpoint explicitly. Verify the endpoint and checkpoint identity as far as the service exposes them. Require a call cap; no hosted spend cap is needed for this local provider. Record the installed model/config identity and precision settings when observable, and mark unavailable metadata unknown rather than inventing it.

For Laya, require the response's routing checkpoint to match the configured checkpoint even when its top-level model name is generic. A model revision or weight hash is recorded only when independently observable; a declared checkpoint name alone is not proof of a weight revision. Unknown revision remains visible in run evidence and comparison output.

Provider selection is fixed at run start. An unavailable local service cannot fall back to hosted Jev. A credential or remote-service failure cannot fall back to local Laya. Prompt rendering is shared across adapters, so a same-stimulus comparison changes the provider and its model, not the reader-facing question.

Laya's usable context may be shorter than a reader state plus visible passage and history. Measure the full rendered request against the configured checkpoint before dispatch. If fit cannot be established or the request exceeds the limit, stop that journey with an explicit unsupported-input result. Do not silently truncate, summarize, or omit already visible material. Large scan choice sets also require an explicit fit check. Laya's reported confidence has different semantics from Jev's, and its shipped `choice:11+` temperature is clamped. Do not transfer Jev confidence thresholds or interpret either provider's choice probability as a fraction of human readers.

## Execution and run evidence

The same core supports a CLI and MCP tools. `check` validates manifest, cohort, source hashes, route, provider configuration, and upper bounds without model calls. `trace` renders complete scripted journeys through the live prompt builder without network calls. A run can begin only with a frozen cohort, explicit provider, output location, call cap, and, for hosted Jev, spend cap. Independent reader-condition journeys may run concurrently; each journey remains sequential. The harness reserves attempts and estimated spend before dispatch, reconciles returned usage, and stops rather than exceeding the declared ceilings.

Long runs have durable states: prepared, running, completed, partial, failed, and cancelled. Atomic checkpoints record completed journeys and budget state. Use two related fingerprints: a **stimulus fingerprint** for manifest, source hashes, frozen cohort, and rendered prompt contract; and an **execution fingerprint** that adds provider, model identity, and settings that change the decision distribution. Resume requires the execution fingerprint. Cross-provider comparison requires the stimulus fingerprint. Credentials are never stored in a checkpoint. An old Portfolio checkpoint is a historical record, not a resumable input to the new format.

After an app or worker restart, status is reconstructed from the checkpoint. An interrupted running job becomes partial; it does not silently restart. Explicit resume skips completed journeys and restarts an incomplete in-flight journey under the same execution fingerprint. Cancellation stops new dispatch, preserves completed results and budget evidence, and records the outcome of any already in-flight requests before closing the checkpoint.

The MCP surface offers study validation, scripted trace, bounded run start, status, cancellation, resume, and report retrieval. A run is a durable job rather than a single agent turn held open for hundreds of decisions. The CLI offers the same operations for scripting and recovery. Applying a hosted poll requires explicit authorization in the calling workflow. The server enforces the declared limits regardless of the agent's phrasing. An output directory is explicit for a run so the plugin does not write evidence into whichever repository happened to invoke it. Reports and checkpoints live there; source content and credentials do not appear in the report. A local check reports calls and input fit without inventing a dollar estimate; a hosted check may estimate spend but does not present that estimate as billed cost.

Reports retain provider and model provenance, prompt and input fingerprints, attempts, actual or unknown provider charges, latency, individual exposure and choice events, journey outcomes, and condition/archetype denominators. A comparison of Jev and Laya runs may align only matched completed journeys with identical stimulus and cohort fingerprints. It reports agreement, divergences, and provider-specific failure or unsupported-input counts. Agreement with Jev is not evidence of correctness or calibration against real readers.

## Validation and handoff boundaries

Port the meaningful behavioral coverage of the current harness: future-blind prompts, optional-read and scan routes, frozen cohorts, source drift, completed-journey resume, concurrent reservations, retry accounting, and report denominators. Replace provider-specific assumptions in those tests with focused adapter and contract tests. Add a local Laya API integration check against the configured service without requiring GPU weights in routine CI. Hosted calls are not part of routine tests or design validation. Validate the installed plugin from a fresh Codex chat, including skill discovery and MCP tool startup, after implementation.

The first release does not train or calibrate Laya, run a paid polling study automatically, infer actual audience percentages, replace Portfolio's installed skill, or change Portfolio's article content. An evaluation study of Laya versus Jev follows the port and uses a frozen manifest and cohort with separately stated limits on what the comparison establishes.

The implementation plan should choose file and package boundaries, migration sequence, dependency pinning, MCP launch mechanics, and focused test order within these contracts. It must not reopen the manifest-only decision, provider-selection rule, future-blind stimulus, run custody, or reporting limits without a new design decision.
