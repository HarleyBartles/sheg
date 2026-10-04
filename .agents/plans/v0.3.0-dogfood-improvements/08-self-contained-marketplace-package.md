# Self-contained marketplace package implementation plan

**Goal:** Make the Git marketplace and release ZIP install the same reproducible, self-contained Sheg plugin package while keeping canonical source authoritative and durable runs accessible.

**Base:** `develop` after Plan 7 PR #19, commit `8f2ad5fd133367a872c99cf46ec92b7c7eea5327`.

**Feature target:** `develop`, product version `0.3.0-dev.10` authored only in root `package.json`; regenerate lockfile metadata, root plugin manifest, and package output through supported build tools.

**Scope:** Build tracked `plugins/sheg/` from canonical manifests, `dist/`, skills/references, license, and runtime assets. Change the existing local marketplace source path to `./plugins/sheg`. Rework ZIP packaging to archive this package root without a second allowlist. Keep marketplace/plugin identifiers and policies. Exclude repository source, tests, build scripts, plans, development guidance, dependency trees and other non-runtime content.

**Data continuity:** Codex resolves the marketplace `source.path` from the marketplace root and installs the local plugin from that declared path. `PLUGIN_ROOT` identifies the installed package; Sheg stores runs under explicit `SHEG_DATA_DIR`, Codex's writable `PLUGIN_DATA`, or the existing OS application-data fallback. Preserve marketplace name and plugin name `sheg`; prove `PLUGIN_DATA` precedence and fallback paths are unchanged. The package source path must never be used as a run-data root.

**Tasks:**

1. Add focused tests for a minimal package manifest generated from the root package version, canonical build contents, forbidden files, deterministic output, safe path handling, and unchanged plugin/marketplace identity. Add a failing package-copy test for each runtime asset path that is not covered by existing copied-MCP integration tests.
2. Implement one package generator that builds/copies only the approved inputs into `plugins/sheg/`, removes stale generated package contents safely, emits a minimal ESM package manifest, and fails on missing, symlinked or escaping required inputs. Make `npm run build` or a dedicated deterministic packaging command generate it from canonical source.
3. Set `.agents/plugins/marketplace.json` source path to `./plugins/sheg`; assert Codex root-relative resolution and install contents. Where the host allows, use the local marketplace install path for an integration proof; otherwise exercise the same Codex resolver contract plus a copied plugin install.
4. Make `scripts/package-plugin.py` create the deterministic release archive from `plugins/sheg/` only. Keep tag validation tied to root version, and verify archive entries and bytes equal the generated package tree. Update release workflow only as needed so its build regenerates and validates the package before ZIP creation.
5. Validate the copied package after source, node_modules, tests and build tools are unavailable: start MCP, complete MCP initialization, load a skill, launch/resume a worker, resolve schema/archetype data and credential helper assets without exposing or using a real credential. Prove run storage uses unchanged plugin data/OS application-data paths.
6. Run focused package and copied-runtime tests, `npm run verify`, package regeneration, and package/ZIP equivalence checks. Inspect the generated tree and marketplace metadata. Confirm `package.json` is the only authored product-version source and do not retain test receipts or live run outputs.

**Key files:** `scripts/package-plugin.py`, `scripts/build.ts`, `scripts/generate-plugin-manifest.ts`, `.agents/plugins/marketplace.json`, generated `plugins/sheg/`, package/build tests, copied-MCP tests, and release workflow if necessary.

**Non-goals:** Publish or tag a release; modify Sheg's plugin or marketplace identities; relocate or migrate run data; add package dependencies; ship implementation source, tests or development plans; maintain a second ZIP-only file list.
