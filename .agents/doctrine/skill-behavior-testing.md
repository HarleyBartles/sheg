# Skill behavior testing

Sheg skills are behavior-shaping source. Scenarios, evaluators, calibration examples, and behavior tests belong under the owning skill's `tests/behavior/` tree. Shared campaign machinery belongs in `scripts/skill-testing/`, with deterministic tests in `test/skill-testing/`. Customer plugin packages contain guidance and references, not tests.

Live campaign outputs, actor and judge records, reports, and run databases are transient development artifacts. Keep them outside the repository, inspect them, then discard them. Ship tests, not results.

## Verification lanes

`npm run verify` tests implementation and harness behavior with deterministic fixtures and fake adapters. It does not dispatch skill actors or judges. Never run live skill scenarios or campaigns in CI or pre-commit hooks. Adding a scenario to the catalog does not prove the guidance works.

Before changing guidance, select affected capability cases and shared safeguards. Test old and candidate guidance against the same frozen requests, evidence, criteria, and execution settings. Include relevant discovery near-misses, changed follow-up workflows, and held-out wording where available. Choose repetitions according to risk; use a no-guidance arm separately when testing whether guidance caused the behavior.

## Campaign workflow

Use `npm run skill:campaign -- select` to find scenarios by owner, tag, or guidance path; `--include-shared` adds shared safeguards. `prepare --config <file> --output <off-repository-directory>` freezes the request, evidence, rubric, guidance, and execution settings. Use `run` or `resume` with explicit `--backend codex`, then `grade` and `report`. The CLI's usage output describes the complete command syntax.

The harness supports focused response tests, skill-discovery tests, and ordered user workflows. Actors receive selected guidance and user inputs, not private evaluation criteria or future workflow turns. Workflow actors retain a session across turns and call Sheg MCP tools when the scenario requires them. Their Sheg datastore is isolated per attempt. Judges run separately against the frozen rubric and captured output.

Campaign inputs and captured results are checked before reuse. A captured trial is not dispatched again; runtime failures and interrupted attempts remain visible. Resume can recover completed capture without rerunning it. A deliberate behavior rerun has a new trial identity. After review, `discard --campaign <dir>` removes campaign output and its associated scratch data.

## Reading the evidence

Deterministic checks validate actor contracts, executable Sheg request shapes, selected-material references, and workflow tool checkpoints. Tool checkpoints require observed CLI events; an actor's claim or a judge's semantic verdict cannot satisfy them. Semantic judgments report criterion-level pass, fail, or uncertain with supporting evidence. Judge failures remain uncertain rather than becoming behavior failures.

`compare` requires matching frozen comparison inputs and actor/judge runtime identities, then compares the explicitly selected arms. It pairs repetitions and obtains separate blind judgments in both display orders. Reports retain disagreements and a pending human-adjudication field. Inspect failures, uncertainty, missing model metadata, and disagreements before drawing conclusions. Small samples do not establish statistical significance or general reliability.

Calibration fixtures include good, bad, and borderline examples, including articulate invalid requests and unsupported claims. The agreement helper identifies disputed criteria; it does not enforce a calibration threshold or itself run a live calibration campaign. Judges should cite observed evidence rather than match phrases.

Tool isolation and universal auditing belong to the ambient runtime. Captured Codex events establish activity observed in that stream, not the absence of tools elsewhere. Sheg's harness isolates study data and grades observed workflow calls; it does not provide universal tool isolation.
