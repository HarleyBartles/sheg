# ADR-0002: Use Node.js and TypeScript

- Status: Accepted
- Date: 2026-09-27
- Supersedes: None

## Context

The Portfolio trial grew into a substantial skill and harness, but this
repository is a new project with a much broader scope and a long expected life.
It will provide a reusable harness and Codex plugin, expose an MCP server, and
support both a hosted decision service and a local model. Reproducing the
trial's implementation exactly would preserve its language and routing choices
without showing that they are right for this project.

Python is portable and was a reasonable initial default. The maintainer also
wants to build experience with Node.js and prefers TypeScript's familiar syntax
and explicit contracts. This is a suitable opportunity to make that investment
before the trial implementation becomes a larger migration burden.

## Options considered

- Continue in Python. This reuses the trial's language and its existing
  implementation knowledge, but does not meet the maintainer's preference to
  work in TypeScript and would carry forward more trial-shaped code.
- Use JavaScript on Node.js. This offers a direct plugin and MCP runtime but
  leaves important manifest, provider, and persisted-run contracts less
  explicit at compile time.
- Use TypeScript on Node.js. This supports the plugin and MCP runtime while
  making shared contracts explicit and giving the maintainer a language they
  enjoy reading and want to learn through project work.

## Decision

Use Node.js with TypeScript for the harness, CLI, and MCP server. Treat this as
a fresh implementation informed by the Portfolio trial, not a line-by-line port.
Keep runtime validation at external and persisted-data boundaries; TypeScript
types alone do not validate JSON or provider responses.

## Consequences

The project can share typed contracts across its CLI, MCP server, providers,
and graph runner. The maintainer can review the code more directly and build
Node.js experience. The project takes on TypeScript build and dependency
management and must verify runtime inputs independently. Python-only trial
artifacts are reference material, not production modules to retain.
