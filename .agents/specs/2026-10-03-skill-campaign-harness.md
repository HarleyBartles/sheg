# Sheg skill campaign harness

Status: approved direction from the 2026-10-03 web spike and instruction to insert Plan 3a before the paused Plan 4. This scope authorizes planning; implementation resumes only when requested. Tool isolation belongs to the ambient Agent Capability Pack concern and is outside this harness.

## Outcome

A contributor can run, interrupt, resume, grade, and compare a versioned skill campaign without assembling trial records manually. The report explains observed behavior changes, exposes disagreements and missing evidence, and retains raw outputs. It never treats a saved passing campaign or five successful trials as proof of general reliability.

## Required behavior

- Freeze scenario inputs, criteria, old/new skill snapshots and references, execution configuration, and their hashes before dispatch. Compare old/new guidance under matching settings. No-guidance is a separate attribution control; it is not a substitute for the old skill baseline.
- Use stable campaign/trial IDs, fresh actor contexts, separate evaluator contexts, bounded concurrency, append-only attempt records, and resumable execution. Preserve invalid actor outputs unchanged. Distinguish runtime, actor-output-contract, deterministic behavior, semantic, and evaluator failures. Retrying infrastructure errors retains completed trials and links the retry to its previous attempt; retrying a behavioral failure produces an additional trial, never replaces the failure.
- Keep backend execution behind an explicit adapter. The first adapter invokes the installed Codex CLI non-interactively using argument arrays and stdin, captures its JSON event stream and final output, and records requested and observed settings separately. Never infer unavailable runtime facts. A fake adapter supports deterministic CI; live model campaigns require an explicit command and are absent from ordinary verification.
- Grade structured proposals using real Sheg request schemas and offline inspection/resolution fixtures where the scenario supplies complete inputs. Incomplete conversational proposals are evaluated for appropriate clarification instead of being fabricated into executable requests. Semantic evaluators judge study fit, interaction quality, and evidence interpretation with criterion-level pass/fail/uncertain and cited evidence.
- Calibrate semantic rubrics on retained known-good, known-bad, and borderline traces. Include articulate invalid requests and plausible unsupported claims. Blind qualitative old/new comparisons, randomize labels reproducibly, and repeat comparisons with the order reversed. Retain judge disagreement and human adjudication separately from raw grades.
- Separate skill discovery, focused behavior, and multi-turn workflow suites. Discovery presents the available skill descriptions rather than injecting the selected skill body, tests near-misses, and records the selected skill. This is a controlled discovery experiment, not proof of installed-host triggering. Scripted multi-turn tests provide fixed user turns and mock evidence, preserving the actor conversation within a trial and keeping trials separate.
- Distinguish capability cases from regression cases. Cases carry owner, relevant guidance paths, and suite tags; contributors can select affected cases plus shared safeguards. Reports show raw counts, criterion changes, all-pass trial counts, uncertainty and sample size, and measured cost/timing when available. Do not manufacture an aggregate skill quality score or statistical significance from a small sample.
- Keep tests and calibration fixtures under owning skills, shared harness behavior tests under `test/`, implementation under `scripts/skill-testing/`, and generated campaign output in off-repo scratch. Retain deliberate reviewed campaign evidence in skill-owned test trees. Customer packages exclude all skill tests and campaign output.

## Initial acceptance suite

Exercise the existing six scenario families without rewriting their historical evidence. Add discovery near-misses for the two Sheg skills and one scripted design-to-partial-results conversation with a changed follow-up. A controlled old/new mutation must cause a contract-aware failure and recovery in a focused case; use a held-out wording variant to check the result is not tied to one prompt. Calibration must expose a deliberately weak rubric or judge disagreement. The report must make each of these results inspectable.

## Research basis

- [Anthropic skill creator](https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md): separate old-skill and no-skill baselines, snapshots, triggering cases, qualitative review.
- [Anthropic grader](https://github.com/anthropics/skills/blob/main/skills/skill-creator/agents/grader.md) and [blind comparator](https://github.com/anthropics/skills/blob/main/skills/skill-creator/agents/comparator.md): evidence-backed judgments, critique of weak assertions, blinded comparisons.
- [Agent evaluation patterns](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents): mixed graders, workflow outcomes, capability versus regression cases.
- [Inspect logs and retries](https://inspect.aisi.org.uk/eval-logs.html): stable sample identities, retained logs, resumable interrupted experiments.
- [OpenAI evaluation guidance](https://developers.openai.com/api/docs/guides/evaluation-best-practices): judge calibration and position/verbosity bias.

These patterns inform a small repository-owned TypeScript harness. Adding Promptfoo, Inspect, a simulated-user generator, automatic skill optimization, a model leaderboard, tool isolation enforcement, paid Sheg inference, or stable release publication is outside this plan.

The available ambient `temporary-tool-auditing` skill can supply bounded tool-use observations for verified session-family capture. Use its installation, positive-control, assessment, teardown and purge procedure for fresh subagent proof. The harness may retain a sanitized assessment receipt and limitations, but does not own hooks or claim universal isolation. Existing unaudited traces remain `not-captured`; absence of observed attempts is claimed only for the verified subject/window. CLI actors are separate sessions, so parent-family coverage cannot be assumed to include them.
