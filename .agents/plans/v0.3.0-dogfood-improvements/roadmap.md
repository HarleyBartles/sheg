# Sheg v0.3.0 release roadmap

## Outcome

An author can ask an agent to stage a reading journey, select respondents' material and reuse it in isolation, explicitly resume eligible respondent-local failures without losing completed answers or reached paths, understand failures and stopped partial runs, and compare evidence without losing its framing. Native TypeSafe inference uses an evidence-backed admission policy, installed packages are self-contained and reproducible across Git and ZIP, and datastore upgrades preserve user data after the v0.3.0 baseline.

## Study-input variation

Rich results come from deliberate variation in the study inputs: respondent profile, stimulus, question or response, and state such as prior-turn visibility. Inputs matching across all four dimensions are duplicates for study-design purposes; rerunning them can sample ordinary model variability, but does not add substantive coverage. Do not advise agents to repeat the same input in search of a different result or to choose the smallest cohort by default. The cohort supplies respondent-profile variation, so size and compose it for the differences the author needs to understand.

## Current implementation

The active dev.15 plan is [typed SQLite repositories and read costs](../dev15-sqlite-quality.md). It establishes schema 9 as the v0.3.0 datastore baseline, uses typed read and command repositories over one SQLite owner, verifies forward migration safety, and measures bounded read and open costs.

Write detailed plans just in time against the delivered code of their predecessors. Keep execution plans and specifications in `develop` through the PR that completes them, then retire eligible artifacts in a substantive successor slice. Planning artifacts do not enter `main`.

## Validation

Use the repository implementation and release runbooks for execution, verification, review, and promotion. Follow [skill behavior testing policy](../../doctrine/skill-behavior-testing.md) for scenario campaigns and result custody.
