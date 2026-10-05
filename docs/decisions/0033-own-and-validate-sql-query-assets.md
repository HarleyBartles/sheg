# ADR-0033: Own and validate SQLite query assets

- Status: Accepted
- Date: 2026-10-05
- Supersedes: None

## Context

Several SQLite repositories contain complex SQL projections whose behavior must remain available in both source execution and the generated standalone plugin. Keeping long statements inline obscures query ownership and makes installed-package behavior depend on the bundled code retaining every query definition.

## Options considered

- Keep complex statements inline and rely on bundled source code, which avoids runtime assets but weakens query-level ownership and raw projection validation.
- Store named SQL files beside the SQLite query library, resolve them from the module location, and copy the files into each generated runtime package, which adds a build asset contract but works independently of the caller's working directory.

## Decision

Complex SQLite statements may be stored as named `.sql` assets under `src/infrastructure/sqlite/queries/`. Query definitions bind validated parameters, decode raw rows at runtime, and return application-facing data. The build copies the assets beside bundled entrypoints under `dist/queries/`, and plugin generation includes them through the existing `dist/` package boundary. Dynamic values remain bound parameters; query structure and numeric operators remain explicit code-owned vocabulary.

## Consequences

Source tests and installed runtimes resolve assets relative to the module rather than the process working directory. Build and package checks must preserve query files, and malformed query projections fail at the storage boundary. Historical migrations remain immutable; their schema constraints continue to be checked against current domain vocabularies.
