# Development Version and Candidate Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The next develop-bound checkpoint identifies itself consistently as `0.3.0-dev.2`, can produce a self-contained local candidate ZIP without a release tag, and retains stable release publication protections.

**Architecture:** Read product version from `package.json` through a small runtime identity module that the bundler embeds, replacing the MCP's independent literal. Separate manifest-version validation, which accepts supported development/candidate forms, from stable tag validation, which continues accepting only `vMAJOR.MINOR.PATCH`. Keep versions synchronized explicitly at intentional checkpoints and document the policy in a new ADR.

**Tech Stack:** Node.js 24, TypeScript/tsx, esbuild, Node test runner, Python 3, MCP server/client, Gitflow and staged-snapshot verification.

**Spec:** [Agreed dogfood improvement scope](../../specs/2026-10-02-v0.3.0-dogfood-improvements.md), section 5 development versions and global boundaries. [Parent roadmap](roadmap.md). Read both before execution.

**Execution Strategy:** `executing-plans`, sequentially. Manifest validation, the bundled runtime and release tests share one product identity and must reach a passing checkpoint together. Preserve inline implementation context; fresh review follows the executable slice when authorized.

## Global constraints

- Use the existing canonical `codex/v0.3.0-dogfood-improvements` worktree at base `ad1f20bbe324f6858574c4c54be989faf77a3f4d`; refresh source assumptions before execution.
- Set product identity to exactly `0.3.0-dev.2`. The conceptual existing dev.1 remains historical context, with no retrospective tag or rewritten manifest.
- `package.json`, `package-lock.json.version`, `package-lock.json.packages[''].version`, `plugin.json` and MCP initialization agree. Keep `private: true` and npm publication disabled.
- Source edits precede generated build changes. Do not hand-edit `dist/` or generated schema assets.
- This slice changes version policy and packaging only. Journey defaults, selected material reuse, failure diagnostics, lifecycle fields and skill interpretation changes belong to later roadmap plans.
- Do not touch Portfolio articles, pilot evidence, saved study databases, credentials or the shared repository's staged snapshot.
- Paid inference is not authorized. The user has explicitly authorized a feature PR into `develop` and merge after a fresh clean review and required checks pass. This plan does not authorize a release branch, stable tag or GitHub Release.
- No emoji, em-dashes, arbitrary Markdown wrapping, tautological tests or wording change-detector tests.
- Record consequential policy changes in one new ADR and the ADR index; preserve accepted historical records.

## Review focus

- Prerelease manifests package locally, but neither a stable tag with prerelease manifests nor a prerelease tag enters stable publication. Task 1 owns the validator proof.
- Manifest mismatch at either lockfile root fails before archive creation. Task 1 retains and extends fixture coverage.
- A copied candidate MCP initializes with its package version without accessing the source checkout, Git or `node_modules`. Task 2 owns the protocol-level proof.
- Regenerated output is deterministic in a staged snapshot with no `.git`; product identity must not depend on HEAD or build time. Task 2 owns build/copy proof and Task 3 uses the hook.
- Stable fixture tests retain tag-commit mismatch and archive reproducibility proof even when the repository itself is prerelease. Task 1 isolates those tests from the current candidate version.

## Task 1: Distinguish candidate manifest validation from stable release tags

**Files:**
- Modify: `scripts/package-plugin.py`.
- Modify: `test/release-package.test.ts`.
- Modify: `package.json`, `package-lock.json`, `plugin.json` as one aligned transition, coordinated with Task 2 before committing.
- Reference: `scripts/package-plugin.mjs`, `.github/workflows/release.yml`.

**Interfaces:**
- Consumes: existing `validate_manifests()`, `release_version(tag)`, `validate_tag(tag, triggering_commit)` and wrapper invocation.
- Produces: `validate_manifests()` accepts matching stable or `<target>-(dev|rc).<positive integer>` identity; `release_version()` stays stable-only; no-tag `plugin:package` writes the candidate archive.

**Behavior and test cases:**

| Fixture identity or action | Expected result |
| --- | --- |
| All four manifest fields `0.3.0-dev.2`, no tag | Validation and candidate packaging succeed |
| All four `0.3.0-rc.1`, no tag | Validation succeeds |
| Stable fixture `0.3.0`, tag `v0.3.0` | Existing stable validation succeeds |
| Dev fixture, stable tag `v0.3.0` | Fail manifest/tag mismatch before packaging |
| Tag `v0.3.0-dev.2` | Fail stable release-tag validation |
| Version `0.03.0`, `0.3.0-dev.02` or `0.3.0-dev.0` | Fail supported identity validation |
| Plugin or either lockfile field differs | Fail before archive creation |
| Stable tag points away from triggering commit | Existing retargeting refusal remains |

- [x] Extend the isolated packaging fixture so it can write all manifest fields for a supplied identity and invoke `--validate-only` with or without a tag. Keep temp paths contained and isolated Git environment handling intact.
- [x] Add the candidate/stable distinction cases above. Run `node --import tsx --test test/release-package.test.ts` and capture the actual failure caused by the stable-only manifest parser. Do not claim RED from an unrelated fixture failure.
- [x] Implement the minimal separation of patterns. Keep stable tag syntax unchanged; add a supported manifest suffix pattern, validate equality first, and reuse the accepted manifest version for the no-tag archive name. For example, the manifest grammar is `MAJOR.MINOR.PATCH` followed optionally by `-(dev|rc).[1-9][0-9]*`, with existing leading-zero restrictions on core components.
- [x] Refactor tests that derive `releaseTag` and increment a patch from the repository version. Stable-tag tests use stable fixture versions, not a string split that turns `0-dev.2` into `NaN`. Repository archive tests invoke the no-tag path and still verify reproducibility, closure and executable CLI.
- [x] Set all four authoritative manifest fields to `0.3.0-dev.2` without running `npm version`, creating a tag or changing dependency versions. Preserve the lockfile dependency graph.
- [x] Run the focused release-package tests again. Resolve all failures before Task 2. Do not commit an intermediate tree whose manifests and MCP identity disagree.

## Task 2: Derive MCP product identity and prove the copied candidate

**Files:**
- Create: `src/infrastructure/product-identity.ts`.
- Modify: `src/entrypoints/mcp.ts`, `tsconfig.json` if JSON module resolution requires it.
- Modify: `test/mcp.test.ts`, `test/package.test.ts`.
- Reference: `scripts/build.ts`, `test/build.test.ts`, `scripts/check-generated.ts`.
- Regenerate: `dist/cli.js`, `dist/mcp.js`, `dist/worker.js` only as produced by the existing builder.

**Interfaces:**
- Consumes: Task 1's authoritative `package.json.version` and supported manifest identity.
- Produces: `productVersion: string` exported by `src/infrastructure/product-identity.ts`; `createPollingServer()` uses it for MCP initialization.

The intended source shape is small and bundleable:

```typescript
import packageManifest from '../../package.json' with { type: 'json' };

export const productVersion: string = packageManifest.version;
```

Enable `resolveJsonModule` if needed for TypeScript NodeNext. esbuild must embed the JSON value; the extracted runtime must not resolve a source-relative JSON path at startup. Do not add a general configuration service or runtime Git lookup.

- [x] Extend the existing MCP initialization test to compare `f.client.getServerVersion()?.version` with the authoritative package version. Extend the copied-plugin initialization assertion to compare `client.getServerVersion()?.version` against the copied package manifest. The installed MCP SDK exposes this method. Capture the existing literal `0.3.0` mismatch under candidate manifests.
- [x] Implement `productVersion` and replace the MCP literal. Run `npm run typecheck` and `node --import tsx --test test/mcp.test.ts`.
- [x] Run `npm run build` before copied-package tests so they exercise the changed generated runtime, not the old committed bundle.
- [x] Run `node --import tsx --test test/build.test.ts test/package.test.ts test/release-package.test.ts`. The copied package must operate with no Git checkout and no dependency tree. Preserve existing worker, follow-on and deletion proofs.
- [x] Run `npm run plugin:package -- --validate-only`, then `npm run plugin:package -- --output Z:/_agent-scratch/sheg/codex-v0.3.0-dogfood-improvements/sheg-v0.3.0-dev.2.zip`. Inspect archive names with `py -3 scripts/package-plugin.py --list Z:/_agent-scratch/sheg/codex-v0.3.0-dogfood-improvements/sheg-v0.3.0-dev.2.zip`. Record its SHA-256 with `Get-FileHash`.
- [x] Confirm stable validation `npm run plugin:package -- --tag v0.3.0 --validate-only` fails against dev manifests, as a local validator check. This command does not create a Git tag.

## Task 3: Record the policy, regenerate and commit a passing checkpoint

**Files:**
- Create: `docs/decisions/0023-identify-development-and-candidate-builds.md`, unless a fresh base already uses 0023, in which case choose the next unused number and update all links.
- Modify: `docs/decisions/README.md`, `docs/guides/releases.md`, `.agents/playbooks/semver-version-alignment.md`, `.agents/playbooks/gitflow-branch-and-release.md` where its version wording conflicts.
- Modify: the current plan and roadmap only to record actual implementation evidence after execution.

**Interfaces:**
- Consumes: passing validator, runtime and copied-package proof from Tasks 1-2.
- Produces: one current versioning policy, a passing committed implementation checkpoint and evidence for roadmap Plan 2.

- [x] Write the version-policy ADR with status Accepted and partial supersession of ADR-0013's no-development-version-bump consequence. Retain Gitflow, stable tag identity, main ancestry and publication safeguards. Update the ADR index without rewriting the earlier decision text.
- [x] Update the release guide and playbooks: deliberate dev/rc checkpoints may update aligned identity on develop; no bump per arbitrary merge; the current checkpoint is `0.3.0-dev.2`; stable promotion removes the suffix on its release branch; no-tag local candidate packaging publishes nothing.
- [x] Document how dogfood evidence identifies the installed candidate using its package version and exact package digest or source evidence. Do not embed a guessed HEAD or timestamp in committed generated output. Skill-content provenance can use the archive digest until the later campaign work specifies its evidence format.
- [x] Inspect the intentional diff with `git diff --check` and `git diff --stat`. Stage source, docs, manifests and regenerated outputs explicitly. Commit Tasks 1-3 as one passing checkpoint through `.githooks/pre-commit`; its staged `npm run verify` must pass. Do not run the same full gate immediately before or after a successful hooked commit without a new concern.
- [x] Record focused commands, archive identity, hook result and commit SHA in this plan and update the roadmap's first row only after the system proves completion. A later evidence-only commit also goes through the hook.
- [x] Re-read the agreed scope and check that no runtime semantic work or publication was smuggled into this slice.

## Implementation evidence

- Product identity is `0.3.0-dev.2` in `package.json`, both root `package-lock.json` version fields, `plugin.json`, and the initialized MCP server. The copied packaged MCP reports the copied package version without its source checkout or dependency tree.
- Focused verification passed: `node --import tsx --test test/release-package.test.ts` (6 tests); `npm run typecheck`; `node --import tsx --test test/mcp.test.ts` (10 tests); `npm run build`; `node --import tsx --test test/build.test.ts test/package.test.ts test/release-package.test.ts` (13 tests); `npm run plugin:package -- --validate-only`; stable-tag validation against `v0.3.0` failed as required for candidate manifests.
- Local candidate archive: `Z:/_agent-scratch/sheg/codex-v0.3.0-dogfood-improvements/sheg-v0.3.0-dev.2.zip`, 27 files, SHA-256 `9DABA37AA2921E4DC1A65A4B02E0078A4EEDF362BAC918E68DD126B288795B17`.
- `npm run verify` passed with 326 tests, zero failures or skips. The tracked pre-commit staged-snapshot hook independently passed the same gate.
- Implementation checkpoint: `1b47095478ef`; `git diff --check` passed. No release tag, GitHub Release, npm publication or paid inference was used.

## Next plan handoff

After this PR is merged, create a fresh canonical worktree from current `develop`, record its merge evidence in the roadmap, then author Plan 2 for `0.3.0-dev.3`. Establish skill-owned baseline scenarios against current guidance before changing skills; retain fresh actor and evaluator traces and use no paid inference.

## Handoff evidence

Report exact base/head, worktree and status, the five matching product-identity surfaces, candidate packaging and copied-MCP results, stable-tag rejection, retained stable-fixture protections, focused checks and staged gate. The local ZIP is validation evidence, not a published release. Keep this worktree for the next approved slice; do not clean it or merge it automatically.

## Planning-turn evidence

This plan was authored on a clean linked worktree created with the installed `/using-git-worktrees` helper. The fetched develop base is `ad1f20bbe324f6858574c4c54be989faf77a3f4d`. Before planning edits, `npm test` passed 323 tests with zero failures or skips. All implementation checkboxes above remain unchecked. No application code, manifests, release policy or generated outputs were changed during planning.
