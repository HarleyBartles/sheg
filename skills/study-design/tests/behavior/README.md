# Skill behavior scenarios

These fixtures pressure-test user-facing Sheg guidance with controlled cases. The deterministic harness renders prompts only; it never calls a model, Sheg tool, inference provider, or external service.

Each scenario is public actor input. Its paired `evaluators.json` record is private evaluator input and must never be supplied to the actor. A scenario version changes when its user request or controlled evidence changes. Evaluator criteria use stable IDs and observable behavior, not required phrases.

## Manual campaign

1. Run `npm run skill:scenario -- --list` and render each actor prompt with `npm run skill:scenario -- --actor-prompt <scenario-id>`.
2. Start a fresh Codex context for each actor. Supply only that prompt. Use `gpt-6-sol` at medium reasoning, require the JSON trace contract, and prohibit actual tool calls. Save proposed actions as mock actions only.
3. If a guided actor makes an unsupported claim or misses an essential behavior, run one fresh no-guidance actor against the same request and evidence before attributing the result to guidance.
4. In a separate fresh context, provide the evaluator prompt generated from the actor trace. Require an evidence citation for every criterion. Manually inspect every failed, disputed, or flagged result.
5. Store trace records under the owning skill's `tests/behavior/traces/baseline/` directory. Include scenario/version, trial ID, mode, model/reasoning, hashes of supplied skill/reference files, actor/evaluator JSON, and `simulationOnly: true`.
6. Summarize observed strengths, misses, matched controls, and limitations in the plan evidence report. A single baseline is evidence about these cases, not proof of general behavior.

After behavior-shaping guidance changes, rerun at least five fresh-context trials for affected scenarios and manually inspect every flagged result. Keep campaign execution explicit; it is not part of CI.
