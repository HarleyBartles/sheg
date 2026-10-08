# Sheg releases

Sheg distributes a Codex plugin through Git marketplaces and versioned GitHub Release ZIPs. A reviewed `v<version>` tag identifies stable release source. Both distribution routes use the generated `plugins/sheg/` package. The repository is private to npm and is not published as an npm package.

## Version policy

Root `package.json` is the only authored product-version value. Change it for the assigned development checkpoint or release, then run `npm run build` to regenerate the lockfile root fields, plugin manifests, bundled MCP identity, and `plugins/sheg/` package. Inspect generated diffs and validate the package; do not hand-edit generated version copies. See [ADR-0023](../decisions/0023-identify-development-and-candidate-builds.md).

Every ordinary merge into `develop`, including documentation and tooling work, establishes one unique `MAJOR.MINOR.PATCH-dev.N` identity. Select the intended release core from compatibility impact and release scope; the first merge on a new line uses `dev.1`, and subsequent merges on that line advance N monotonically. Changing the intended release core starts its sequence at `dev.1`. Commits within an unmerged PR share its proposed version. A squash merge is one integration checkpoint. See [ADR-0037](../decisions/0037-adopt-gitflow-and-semver-cadence.md).

The PR author proposes the next identity in root `package.json` and rebuilds derived copies. Before merge, the author and reviewer refresh the current remote `develop` head and confirm the proposal is the next unique checkpoint on the intended line. If another PR merged first, refresh the branch, reallocate its number, rebuild, and rerun verification. Version identity does not imply dogfood qualification. Use the source revision or archive digest for exact provenance.

Use `MAJOR.MINOR.PATCH-rc.1` for the first qualified release candidate. Advance `rc.N` only when candidate source changes and is rebuilt and requalified; rerunning verification on identical source keeps its identity. Promote a verified candidate by removing the suffix and rebuilding from the exact stable release source. Development versions, candidate versions, and local archives do not create tags or publish releases. Stable publication accepts only `vMAJOR.MINOR.PATCH` tags with matching stable manifests.

During `0.y.z` development, increment the patch for compatible fixes and the minor version for a coherent functionality bundle. Document breaking changes and their recovery path. Adoption does not require declaring future `1.0.0` guarantees.

Compatibility decisions cover the supported Codex plugin and Node.js runtime, CLI commands and MCP tool request/result contracts, typed study inputs and response meanings, provider configuration and credential behavior, and supported persisted evidence and recovery guarantees. Removing a supported entrypoint, rejecting previously supported input, changing result meaning, or losing supported evidence is incompatible. An additive optional capability preserving those behaviors is compatible. Schema and payload contract versions remain independent of the product version. Under `0.y.z`, SemVer makes no general API stability promise; Sheg still preserves its stated datastore guarantees and documents incompatible changes. From `1.0.0`, incompatible public contract changes increment MAJOR, compatible additions or deprecations increment MINOR, and compatible fixes increment PATCH, resetting lower components when a higher component increments. Maintainers decide compatibility and intended release scope during review.

Product identities use SemVer 2.0.0 syntax and precedence: stable core integers have no leading zeroes, prereleases precede the matching stable version, and numeric prerelease components compare numerically. Sheg uses stable, positive `dev.N`, and positive `rc.N` identities without build metadata. Build metadata would not affect SemVer precedence, but is outside Sheg's accepted publication identities.

## Datastore compatibility

Schema 9 is the first supported released datastore baseline, in v0.3.0. Earlier development databases have no compatibility promise. Later schema-changing releases must include sequential, tested forward migrations from every supported released schema, preserving frozen inputs, answers, lineage, and physical-attempt accounting. Payload contract changes must introduce explicit versions and upcasters independently of the SQLite schema version. See [ADR-0031](../decisions/0031-set-schema-nine-as-release-baseline.md) for the baseline and [ADR-0027](../decisions/0027-migrate-supported-datastore-schemas.md) for migration, backup, and recovery guarantees.

If startup cannot open or migrate a database, MCP recovery inspection remains available while study operations are blocked. Reset requires explicit confirmation and preserves a verified SQLite backup or, for unreadable databases, quarantined original files. Upgrades never reset data automatically.

## Branches and promotion

- `develop` is the default integration branch. Feature branches start from its latest commit and target it in their PRs.
- Cut `release/<version>` from `develop`. Limit it to version, release-note, packaging, and stabilization changes, then open its PR into `main`.
- Planning artifacts, including plans, specifications, and roadmaps, have temporary Git residency on `develop`. Before opening the release PR, promote durable decisions and operating rules to maintained documentation and remove all contents of `.agents/plans/` and `.agents/specs/`, plus any equivalent planning files elsewhere. The final `main` tree contains no planning artifacts.
- Feature PRs may use squash merge. Release and hotfix PRs, and their reconciliation into `develop`, use merge commits to retain Gitflow ancestry.
- After the reviewed release PR merges to `main`, create the matching `v<version>` tag at that merge commit. Only repository administrators can create or change `v*` tags; active GitHub rules protect tag creation, updates, and deletion.
- The tag workflow validates version identity and main ancestry, builds and verifies the ZIP in a read-only job, then publishes from a separate job with release-write permission.
- Reconcile release fixes and version metadata into `develop` and carry relevant fixes into every affected active release branch under that branch's candidate validation. Preserve active or mixed-scope planning artifacts from the pre-reconciliation `develop` tree; completed or retired artifacts stay retired. Close the release branch afterward.
- For an urgent production fix, start `hotfix/<version>` from `main`, merge its reviewed fix and version update into `main`, tag the verified merge, and reconcile it into `develop`.

For release or hotfix reconciliation, distinguish the released baseline from continuing development. If `develop` has no continuing next-release work and is left at the released product baseline, keep the stable release version; restoring active planning artifacts does not start a development line. The first subsequent ordinary development merge starts the intended next release at `dev.1`. If `develop` already contains next-release work, preserve that intended line and advance its checkpoint for the reconciliation change, for example `0.4.0-dev.4` to `0.4.0-dev.5` when reconciling `0.3.1`. Do not reset continuing development to an older stable identity. Rebuild and verify the reconciled result before claiming completion.

Ordinary pushes and merges do not publish releases. The release workflow runs only for `v*` tags. Re-running it for an existing release replaces the ZIP asset for that tag without changing its source identity.

## Build and package locally

Use Node.js 24 and Python 3. Replace `<version>` below with the stable version in root `package.json`:

```sh
npm ci
npm run verify
npm run build
npm run plugin:package -- --tag "v<version>" --validate-only
npm run plugin:package -- --tag "v<version>"
```

Packaging rejects malformed or mismatched versions and tags. To inspect a prerelease locally, omit `--tag` and supply an explicit output filename. This does not publish it. Promote a candidate by removing its suffix in root `package.json` on the release branch and rebuilding.

The npm wrapper uses `py -3` on Windows. The default archive path is `release-artifacts/sheg-v<version>.zip`. The archive has plugin-root paths and contains every file in `plugins/sheg/`, excluding implementation source, tests, dependencies, and build tooling. Its bundled server requires Node.js 24 and no dependency installation or local build.

## Install a GitHub Release ZIP

1. Download `sheg-v<version>.zip` from the matching GitHub Release.
2. Create a local marketplace directory with a `plugins/sheg/` subdirectory. Extract the archive there, preserving its paths.
3. Create `.agents/plugins/marketplace.json` at the marketplace root with the existing Sheg identity:

   ```json
   {
     "name": "sheg",
     "plugins": [
       {
         "name": "sheg",
         "source": { "source": "local", "path": "./plugins/sheg" },
         "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
         "category": "Productivity"
       }
     ]
   }
   ```

4. Register it with `codex plugin marketplace add <marketplace-root>`.
5. Restart Codex, install or enable Sheg, and confirm its tools load.

Git marketplace installation remains available; see the [installation guide](installing-codex-plugin.md).

## Failure and retry behavior

Invalid identity, verification, build, or packaging failures stop publication. Correct source through a reviewed PR into `main`, then create a new version tag. Never force-move or reuse a published tag. If release creation succeeded but asset upload failed, rerun the same tag workflow to replace its asset. Investigate other publication failures before retrying.
