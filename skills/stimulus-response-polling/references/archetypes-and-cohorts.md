# Author archetypes and prepare respondent cohorts

Use this workflow when the user wants to create reusable respondent archetypes, expand archetypes into a study-specific respondent cohort, combine bundled and custom archetypes, or supply profiles directly.

## The three artifacts

- A **respondent archetype** is a reusable pattern of motivation and perspective. It defines what remains true across its respondents and the dimensions that may vary.
- A **respondent profile** is one modeled respondent's starting perspective on the study subject. It is shaped by the chosen archetype, when used, and the study question.
- A **frozen cohort** is the ordered set of concrete profiles used in a poll. The harness polls these profiles, never archetypes directly.

Use the skill's [respondent archetype](../assets/respondent-archetype.schema.json), [respondent archetype library](../assets/respondent-archetype-library.schema.json), [respondent profile](../assets/respondent-profile.schema.json), and [frozen cohort](../assets/respondent-cohort.schema.json) JSON Schemas for normative shapes and validation constraints. The schemas list cross-record rules that also receive runtime enforcement. The bundled archetypes are organized into semantic groups under `dist/data/respondent-archetypes/`; the catalog treats groups as navigation, not restrictions, so users can mix groups with custom archetypes. These bundled files are the installed source of archetype data.

The plugin ships archetypes, not respondent profiles. A user can choose shipped archetypes, provide custom contract-compliant archetypes, mix both, or bypass archetypes and provide concrete profiles directly.

## Write or adapt archetypes

Keep an archetype reusable across studies and stimulus types. Its perspective should describe a meaningful respondent purpose for the task, not a presumed reaction to a particular stimulus. State the traits every expansion must preserve, then choose variation dimensions that create distinct behavior, knowledge, motivation, or attention. Avoid demographic shorthand and stereotypes.

Use the contract schema to check the artifact shape and the bundled library as examples of useful lenses. Give custom or adapted archetypes new IDs; do not silently redefine a shipped archetype under its existing ID. If an archetype is used in a poll, include its exact definition in that cohort's snapshot.

## Expand archetypes for one poll

1. Inspect the actual stimulus and task. Choose the user-approved bundled and/or custom archetypes that probe useful respondent perspectives. Do not assume every library entry belongs in every cohort.
2. Ask for or derive an explicit number of profiles per selected archetype. Choose a balanced set of variation values that produce distinct starting perspectives while preserving every archetype invariant.
3. Write each concrete profile against the specific study subject. Describe the respondent before they encounter the stimulus. Do not preload the profile with the stimulus's claims, people, events, ending, or expected reaction unless that is credible prior knowledge independent of the stimulus.
4. Put exact snapshots of all used archetypes in the cohort. For each archetype-derived respondent, select a declared value for every axis and make the concrete perspective consistent with those choices.
5. Inspect the cohort as a whole for meaningful differences, preserved invariants, and fit with the study question. Freeze it before polling.

The cohort snapshot makes expansion auditable and independent of later library edits. The runner sends only the concrete respondent perspective fields to the model. It does not send archetype definitions, variation metadata, study purpose, or stimulus content that the respondent's path has not exposed. Each of the five prose fields is capped at 500 characters and the five together at 1,500 characters. Treat those caps as safeguards: write only perspective details that could affect a response, rather than filling the available space.

## Supply profiles directly

A user may skip archetypes and author a cohort of concrete respondent profiles directly. Follow the [respondent profile](../assets/respondent-profile.schema.json) and [frozen cohort](../assets/respondent-cohort.schema.json) contracts. Leave `archetypeId` and `variation` out of direct profiles and omit the cohort's top-level `archetypes` array when it is not needed. Keep profiles poll-specific, distinct, and frozen before outcomes are viewed.

For the file-backed CLI, validate against the [study manifest schema](../assets/study-manifest.schema.json) and run `node dist/cli.js check --config <file>` with the exact manifest, cohort, provider, and call allowance. For MCP, include the authored profiles directly and use `run_inspect` when a fit preview helps. Fix validation errors without silently rewriting the user's cohort.
