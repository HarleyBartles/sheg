# Self-contained marketplace package implementation plan

**Goal:** Make the Git marketplace and release ZIP install the same reproducible, self-contained Sheg plugin package while keeping canonical source authoritative and durable runs accessible.

**Base:** `develop` after Plan 7 PR #19, commit `8f2ad5fd133367a872c99cf46ec92b7c7eea5327`.

**Execution Strategy:** `executing-plans` with native inline execution. The package generator, marketplace resolver, release archive, and copied-runtime proof form one dependency chain; one implementation context keeps the version and package-tree contract consistent, followed by one fresh whole-branch review.

**Spec:** `.agents/specs/2026-10-02-v0.3.0-dogfood-improvements.md`, section 9, with data-continuity and distribution boundaries in this plan.

**Feature target:** `develop`, product version `0.3.0-dev.10` authored only in root `package.json`; regenerate lockfile metadata, root plugin manifest, and package output through supported build tools.

**Scope:** Build tracked `plugins/sheg/` from canonical manifests, `dist/`, skills/references, license, and runtime assets. Change the existing local marketplace source path to `./plugins/sheg`. Rework ZIP packaging to archive this package root without a second allowlist. Keep marketplace/plugin identifiers and policies. Exclude repository source, tests, build scripts, plans, development guidance, dependency trees and other non-runtime content.

**Data continuity:** Codex resolves the marketplace `source.path` from the marketplace root and installs the local plugin from that declared path. `PLUGIN_ROOT` identifies the installed package; Sheg stores runs under explicit `SHEG_DATA_DIR`, Codex's writable `PLUGIN_DATA`, or the existing OS application-data fallback. Preserve marketplace name and plugin name `sheg`; prove `PLUGIN_DATA` precedence and fallback paths are unchanged. The package source path must never be used as a run-data root.

**Tasks:**

1. Add `test/plugin-package-build.test.ts` coverage for a minimal ESM package manifest generated from the root version, shipped runtime/skill inputs, excluded tests/development files, repeated byte-identical output, unsafe destination refusal, and marketplace identity plus repository-root path resolution. Start by witnessing failure because the package generator does not exist. Expected command: `node --import tsx --test test/plugin-package-build.test.ts`.
2. Implement `scripts/generate-plugin-package.ts` to copy only approved inputs into `plugins/sheg/`, safely replace stale output, emit `{ name, version, type }` package metadata from root `package.json`, and reject missing, symlinked or escaping inputs. Make the normal build regenerate the package; extend `scripts/check-generated.ts` to compare the committed package against that build. Expected commands: `npm run build` and `node --import tsx --test test/plugin-package-build.test.ts`.
3. Set `.agents/plugins/marketplace.json` source path to `./plugins/sheg` and verify the real Codex local marketplace install when the Codex CLI is available. Assert that marketplace identity and plugin identity remain `sheg` and that the installed cache contains only the package. Expected command: `node --import tsx --test test/plugin-package-build.test.ts`; retain the isolated live install as development verification, not as a repository artifact.
4. Make `scripts/package-plugin.py` archive files from `plugins/sheg/` only. Keep stable tag validation tied to root and generated package versions, and assert archive paths and bytes exactly equal the package tree. Update release workflow only as needed so the existing build regenerates the package before ZIP creation. Expected command: `node --import tsx --test test/release-package.test.ts`.
5. Update `test/package.test.ts` to copy the generated directory, set the installed package root/data paths explicitly, and run from outside the checkout with no dependencies or build scripts. Verify MCP initialization, skill/reference/schema/archetype access, credential helper resolution, worker launch and resume, and recall from a second package root sharing `PLUGIN_DATA`. Expected command: `node --import tsx --test test/package.test.ts`.
6. Regenerate and inspect `plugins/sheg/`; verify no tests, plans, repository guidance, build scripts, implementation source or dependency tree are present. Confirm root `package.json` is the only authored product-version source and package/ZIP paths and bytes match. Run `npm run verify`, then repeat focused commands only if verification exposed a new issue. Do not retain receipts, live run outputs or temporary Codex installation data in the repository.

**Key files:** `scripts/package-plugin.py`, `scripts/build.ts`, `scripts/generate-plugin-manifest.ts`, `.agents/plugins/marketplace.json`, generated `plugins/sheg/`, package/build tests, copied-MCP tests, and release workflow if necessary.

**Non-goals:** Publish or tag a release; modify Sheg's plugin or marketplace identities; relocate or migrate run data; add package dependencies; ship implementation source, tests or development plans; maintain a second ZIP-only file list.

**Review Focus:** Verify source-path resolution is repository-root-relative; the tracked package is generated only from canonical inputs and excludes development files; ZIP entries and bytes equal that package; a copied MCP and worker run without checkout or dependencies; generated version identity has one authored source; and `PLUGIN_DATA` plus OS fallback preserve durable-run access.
