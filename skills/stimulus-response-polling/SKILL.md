---
name: stimulus-response-polling
description: Use when designing a bounded text stimulus and typed-question study, building distinct respondent profiles, validating or tracing an arm, running matched A/B arms with Jev or a configured local System One model, or interpreting per-task response evidence.
---

For a new request that starts with material and a question, first use the [study-design skill](../study-design/SKILL.md). It guides the conversation about what to ask and whose perspective matters before the agent constructs a direct request. An agent may choose the response unit, such as page sections, and the typed question. Sheg validates and runs that request; the agent interprets the machine-readable evidence for the user.

An agent can submit either one typed Choice, Score, or Noul question or a finite authored sequence/graph over exact material and distinct respondent profiles. Each accepted request becomes a durable run with an ID. The run stores its frozen request, reached per-respondent contexts and turn IDs, exposures, typed answers, routes, failures, and attempt accounting. Repeating the same respondent, text, and question is not a larger or more independent sample.

| User goal | Read before acting | Tools |
| --- | --- | --- |
| Turn material and a user question into the simplest supported request or journey | [Study design](../study-design/SKILL.md), then inspect the request | `run_inspect` |
| Connect a Jev key during installation or after deferring setup | [Secure setup in run and recovery](references/run-and-recovery.md) | Local interactive PowerShell helper, no key-bearing MCP tool |
| Start, discover, inspect, cancel, resume, or delete a durable run | [Run and recovery](references/run-and-recovery.md) | `run_start`, `run_list`, `run_get`, `run_cancel`, `run_resume`, `run_delete` |
| Inspect or optimize Sheg-managed storage | [Run and recovery](references/run-and-recovery.md) | `run_storage` |

Before using a tool, establish the question the user wants answered and what decision the result should inform. If they already know the question, preserve it and build the simplest respondent and material request that answers it. If intent is incomplete, help them choose a useful question, a response unit, and respondent perspectives. Use stable option IDs for Choice; use Score or Noul when those semantics better match the desired evidence. Include `unanswerable` when a respondent may lack enough information. Keep authored text exact and include only the context the user intends respondents to receive.

Call `run_inspect` on the exact proposed request before starting it. Inspection checks the request and context fit; it does not persist a run or call inference. If it reports invalid or unavailable fit, explain the concrete issue and revise only with the user's intent preserved. Hosted Jev inference requires the user's authorization and a `maxCalls` bound. Laya uses its configured local service and tokenizer checks.

Call `run_start` with a fresh UUID `submissionId` and the exact inspected request. Retain the returned `runId`. If a response is lost, retry with the same submission ID and unchanged request; never invent a new ID for a retry. Call `run_get` status while work is active. Use request and answer views for the frozen input and typed outcomes; use the journey view for respondent-local exposure/response history, reached turn and context IDs, route, and terminal or failure state. Check counts and status before describing completeness. Reads do not start or resume execution. Use `run_resume` only when the user wants eligible interrupted work to continue; it retains the original request, ID, and physical-call ceiling, including uncertain calls.

The meaningful response unit is a distinct respondent profile at a reached typed question and exact recorded context. Provider attempts are not additional respondents. A later request may use stored turn/context identifiers only through a selector/composition tool when that tool is available; journey detail itself is a read of what ran. Describe recorded outcomes and denominators, including failed, pending, and unreached evaluations; do not turn simulated responses into claims about human behavior. The agent is responsible for explaining what the evidence supports and any limitation that matters to the user's decision.
