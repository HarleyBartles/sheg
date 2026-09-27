# ADR-0004: Organize source by responsibility and keep tests separate

- Status: Accepted
- Date: 2026-09-27
- Supersedes: None

## Context

The initial prototype placed several mixed responsibilities in files directly
under `src/`. The project is expected to grow across study validation, reader
profiles, decision contracts, providers, journey execution, durable jobs,
entrypoints, and plugin packaging. Large mixed files make ownership and change
impact harder to see.

The maintainer prefers cohesive modules, types beside the behavior that owns
them, and a separate test tree for this backend-oriented Node.js project.

## Options considered

- Keep a small flat `src/` tree and split files only when they become large.
  This minimizes initial structure but makes mixed ownership easier to grow.
- Split every concern into files and use a dedicated types file for each.
  This makes types easy to locate but can separate contracts from the code
  that uses and owns them.
- Group modules by responsibility, co-locate local types with their owning
  implementation, extract genuinely shared contracts, and put tests in a
  separate `test/` tree.

## Decision

Use responsibility-oriented directories under `src/` (domain, application,
providers, infrastructure, and entrypoints as they are needed). Keep a module
cohesive and small enough to understand; split it when it accumulates distinct
responsibilities. Define local types beside the behavior that owns them, and
extract shared contracts when multiple modules genuinely depend on the same
contract. Keep tests under a separate root `test/` tree, grouped by the
responsibility they exercise.

## Consequences

Related behavior and its local types remain discoverable together, and shared
contracts have one owner. The separate test tree distinguishes production
modules from test support and suits the project's backend build and Node test
runner. The project must resist both monolithic files and speculative
type-only-file proliferation; directory structure should follow real ownership
boundaries as the implementation grows.

## References

- [Node.js test runner](https://nodejs.org/api/test.html)
- [TypeScript project references](https://www.typescriptlang.org/docs/handbook/project-references.html)
- [Fastify testing guide](https://github.com/fastify/fastify/blob/main/docs/Guides/Testing.md)
