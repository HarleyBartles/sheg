# Sheg releases

Sheg distributes a Codex plugin through Git marketplaces and versioned GitHub Release ZIPs. A reviewed `v<version>` tag identifies stable release source. Both distribution routes use the generated `plugins/sheg/` package. The repository is private to npm and is not published as an npm package.

## Version policy

Root `package.json` is the only authored product-version value. Change it for the assigned development checkpoint or release, then run `npm run build` to regenerate the lockfile root fields, plugin manifests, bundled MCP identity, and `plugins/sheg/` package. Inspect generated diffs and validate the package; do not hand-edit generated version copies. See [ADR-0023](../decisions/0023-identify-development-and-candidate-builds.md).

Use `MAJOR.MINOR.PATCH-dev.N` for deliberate development checkpoints and `MAJOR.MINOR.PATCH-rc.N` for prepared release candidates. The active plan assigns the checkpoint identity; commits within a PR do not increment it. These versions and local archives do not create tags or publish releases. Stable publication accepts only `vMAJOR.MINOR.PATCH` tags with matching stable manifests.

Before `1.0.0`, increment the patch for compatible fixes and the minor version for a coherent functionality bundle. Document breaking changes and their recovery path. Use `1.0.0` when the public compatibility contract is explicitly declared for a stable, usable product, including supported harnesses, runtime, entrypoints, study contracts, provider settings, and persisted data. An elapsed period or release bundle alone does not establish that contract.

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
- Reconcile release fixes and version metadata into `develop`. Preserve active or mixed-scope planning artifacts from its pre-reconciliation tree; completed or retired artifacts stay retired. Close the release branch afterward.
- For an urgent production fix, start `hotfix/<version>` from `main`, merge its reviewed fix and version update into `main`, tag the verified merge, and reconcile it into `develop`.

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
