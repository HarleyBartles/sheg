# ADR-0019: Own accepted run execution in detached workers

- Status: Accepted
- Date: 2026-10-01
- Supersedes: None

## Context

An agent submits a request through an MCP connection that may end before provider
work completes. Harness startup and later result reads must not silently launch
or resume work. A durable run therefore needs an execution owner independent of
the request-handling process, while duplicate launch attempts and worker death
must not produce duplicate answers or hide uncertain provider calls.

## Decision

The MCP service persists a fully validated and fit-admitted request before
launching one detached Node worker with only the absolute Sheg data root and run
ID as arguments. Workers claim runs with a fenced owner token and renewable
lease, reserve each physical call before dispatch, and settle or conservatively
reconcile it afterward. The worker handles one respondent at a time. Reads only
reconcile expired ownership; they never launch a worker. Resume is an explicit
later operation rather than an implicit side effect.

Authentication and shared provider-access failures are run-wide. A malformed or
failed answer is local to its respondent. Cancellation prevents the next call
while preserving an answer whose request was already in flight.

## Consequences

- Closing the MCP connection does not stop an accepted worker, subject to the
  installed harness allowing detached child processes to outlive their parent.
- A request may be accepted durably but return a failed run if worker launch
  fails; the returned run identity remains queryable.
- Expired in-flight work is reported as uncertain and consumes its reserved
  attempt rather than being retried or represented as an answer.
- Process-level packaging tests must verify the actual worker bundle and local
  provider boundary before claiming cross-connection completion.
- The implementation owns per-user SQLite files and worker lifecycle; it does
  not require a user-managed daemon.

## Alternatives considered

- Run work inside the MCP process: rejected because connection/process lifetime
  would own the operation.
- Start/resume work during reads or harness startup: rejected because discovery
  would have an unexpected execution side effect.
- Use an always-on service: rejected because users should not need to manage a
  background service merely to run a study.
