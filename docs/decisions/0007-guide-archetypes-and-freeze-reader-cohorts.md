# ADR-0007: Guide archetype authoring and freeze study-specific reader profiles

- Status: Accepted
- Date: 2026-09-27
- Supersedes: None

## Context

The first cohort contract required every reader to reference an ID in the
bundled archetype catalogue, then passed a free-form profile string to the
polling model. This made the shipped catalogue an allowlist without ensuring
its descriptions shaped the reader, and it left no supported route for custom
archetypes or profiles authored directly for a study.

Archetypes are reusable patterns. A reader profile is a concrete starting
perspective tailored to the particular article, chapter, page, or other study
subject. The poll must run against a frozen list of those concrete profiles.

## Options considered

- Ship fixed reader profiles alongside archetypes. This makes cohorts easy to
  start but encourages reuse of profiles that are not tailored to the study.
- Add a hidden generator to the polling harness. This couples cohort creation
  to runtime execution and obscures the reasoning and provenance behind each
  profile.
- Teach the ambient reasoning agent how to author archetypes and expand them
  into profiles, while keeping the harness responsible for contract checks
  and frozen poll inputs.

## Decision

Ship a reusable archetype library, not ready-made reader profiles. The skill
teaches agents to author archetypes and expand selected bundled and/or custom
archetypes against the specific study subject. The machine-readable contract
assets define the normative fields and constraints.

Use cohort contract version `2.0`. A cohort may snapshot any used archetypes
and include concrete reader profiles with one declared value selected for each
axis. It may instead contain direct reader profiles without archetypes. Both
routes freeze ordered profiles before polling. Contract validation checks
fields, unique IDs, snapshot references, and exact variation selections; the
skill owns the judgment of whether the archetype and cohort are substantively
strong.

The polling prompt receives only each reader's five concrete perspective
fields. It does not receive archetype definitions, variation metadata, study
purpose, or unexposed stimulus. The exact ordered cohort snapshot, concrete
profiles, and prompt contract contribute to the stimulus fingerprint.

The canonical archetype library lives under `src/domain/readers/` and the
clean build copies it to `dist/data/` for the installed plugin skill to read.
The harness does not require the bundled library to validate or run a cohort;
user-authored archetypes and direct profiles remain first-class inputs.

Publish archetype, reader profile, frozen cohort, and study manifest shapes as
machine-readable JSON Schema assets directly under the skill's `assets/`
directory, so each consumer receives the contracts alongside the skill that
uses them. Skill references teach authoring and expansion workflows and link
to those assets; they do not own or duplicate the normative contract. Runtime
Zod schemas generate the JSON Schema assets, while cross-record rules remain
explicitly listed and enforced by the runtime validators.

## Consequences

- The skill must teach both archetype authoring and study-specific profile
  expansion, including how to preserve invariants and create useful variation.
- Bundled and custom archetypes can be mixed, while custom archetypes use the
  same strict contract and unique IDs.
- Reader profiles are never silently generated during polling. Agents present
  and freeze them as a cohort input, and the harness validates its mechanics.
- Cohort `1.0` inputs require explicit conversion to the `2.0` profile shape.
- Updating the shipped archetype library does not mutate frozen cohort
  snapshots or change profiles already used by a run.
