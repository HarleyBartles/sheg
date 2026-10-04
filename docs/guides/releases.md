# Sheg releases

Sheg releases the Codex plugin from reviewed Git tags. The tag is the source
identity; GitHub Releases attach a reproducible plugin ZIP built from that tag.
The repository remains private to npm and is not published as an npm package.

## Version policy

The root `package.json` `version` is the only authored product-version value. Change it to the version assigned to the planned develop merge or release, then run `npm run build` to regenerate the lockfile root fields, `plugin.json`, bundled MCP runtime, and `plugins/sheg/` metadata. Inspect generated diffs and run release validation; do not hand-edit generated version copies. The MCP initialization version must agree with the package identity.

Planned dogfood feature merges to `develop` use their assigned `MAJOR.MINOR.PATCH-dev.N`; commits within one pull request do not increment it. Prepared release candidates may use `MAJOR.MINOR.PATCH-rc.N`. The roadmap assigns each planned develop merge its candidate identity, and these manifests do not create a release tag. See [ADR-0023](../decisions/0023-identify-development-and-candidate-builds.md).

Before `1.0.0`:

- Increment the patch for compatible fixes.
- Increment the minor version for a coherent bundle of backward-compatible
  functionality.
- Document breaking changes clearly. Pre-1.0 does not make breakage invisible
  to users.

## Datastore compatibility

Schema 8 is the first supported datastore baseline in v0.3.0; older development
databases are disposable. Every later release that changes the SQLite schema
must include sequential, tested forward migrations from every supported
released schema. Preserve frozen request and packet payloads, answers, lineage,
and physical-attempt accounting. Before each migration, verify a recoverable
SQLite backup, apply the step transactionally, and check database integrity and
foreign keys before committing the new version.

Keep persisted JSON format versions separate from the SQLite schema version.
Add an explicit payload upcaster when a payload contract changes, and reject
unknown formats without rewriting stored evidence. If startup cannot open or
migrate the database, keep the MCP recovery inspection available and block
study operations until recovery succeeds. A confirmed reset keeps a verified
SQLite backup when readable, or quarantines the original database and sidecars
when SQLite cannot read them. Never reset data automatically or rewrite a
newer unsupported schema. See [ADR-0027](../decisions/0027-migrate-supported-datastore-schemas.md).

Use `1.0.0` when Sheg is a stable, usable product and the public compatibility
contract is explicitly declared. That contract must identify the supported
harness (currently Codex), runtime requirements, supported plugin entrypoints,
and the compatibility expectations for study manifests, provider settings,
and persisted run data. A release bundle or elapsed time alone does not satisfy
the v1 condition.

## Branches and promotion

- `develop` is the default integration branch. Start feature branches from its
  latest commit and target feature pull requests at `develop`.
- Cut `release/<version>` from `develop` when a coherent bundle is ready. Make
  only version, release-note, packaging, and stabilization fixes on that
  branch. The release pull request targets `main`.
- Feature pull requests may use squash merge. Release and hotfix pull requests
  use a merge commit, as does release/hotfix reconciliation into `develop`, so
  Gitflow ancestry stays explicit.
- Merge the reviewed release pull request to `main`, then create and push the
  matching `v<version>` tag at that merge commit.
- Only repository administrators can create or change `v*` tags; GitHub rules
  prevent other actors from creating, updating, or deleting version tags.
- The tag workflow validates the tag, all version fields, and ancestry on `main`
  before installing dependencies. It builds the ZIP in a read-only job; a
  separate publication job receives only that ZIP and the minimum release
  permission needed to create the GitHub Release with generated notes.
- After promotion, reconcile the release branch into `develop` so release
  fixes and version metadata remain in the integration line. Close the release
  branch after reconciliation.
- For an urgent production fix, start `hotfix/<version>` from `main`, make only
  the fix and version update, then open a reviewed pull request to `main`. Tag
  the verified merge and reconcile the hotfix into `develop`.

The release workflow only runs for `v*` tags. Ordinary pushes and merges to
`develop` do not publish a release or change the version. Re-running a workflow
for an existing release replaces the ZIP asset for the same tag; it does not
create a second release or change the tag.

## Build and package locally

Use Node.js 24 and Python 3:

```sh
npm ci
npm run verify
npm run build
npm run plugin:package -- --tag v0.1.0
```

The package command rejects a malformed tag, a mismatch among package,
plugin, and lockfile versions, or a tag that does not match those versions. To
verify an identity without creating an archive, use:

```sh
python3 scripts/package-plugin.py --tag v0.1.0 --validate-only
```

For local candidate inspection, omit the release tag and use an explicit candidate filename. This creates a local ZIP and does not publish it. Stable publication accepts only `vMAJOR.MINOR.PATCH` tags with matching stable manifests; prerelease tags do not publish. Promote a candidate by removing its suffix on the release branch, changing root `package.json`, and rebuilding before tagging.

On Windows, the npm wrapper uses the Python launcher (`py -3`). By default the
ZIP is written to `release-artifacts/sheg-v<version>.zip`.

The archive has plugin-root paths and contains every file in the generated
`plugins/sheg/` package. It excludes source, tests, the dependency tree, and
build tooling. The bundled MCP entrypoint runs with Node.js 24 and does not
need TypeScript or `node_modules` at runtime.

## Install a GitHub Release ZIP

1. Download `sheg-v<version>.zip` from the matching GitHub Release.
2. Create a local marketplace directory with a `plugins/sheg/` subdirectory,
   then extract the archive into `plugins/sheg/` and keep its paths intact.
3. Create `.agents/plugins/marketplace.json` at the marketplace root with the
   following catalog, using the existing Sheg identity and local package path:

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

4. Register the marketplace root with
   `codex plugin marketplace add <marketplace-root>`.
5. Restart Codex, install or enable Sheg from the Plugins Directory, and
   confirm its polling tools load.

Alternatively, continue to add the Git repository as a marketplace and install
from Git. The repository source remains available separately from the release
ZIP.

## Failure and retry behavior

If the tag format or any package, plugin, or lockfile version is invalid, the
workflow stops before creating or changing a GitHub Release. If verification,
build, or packaging fails, no release is published. Correct the source on the
release branch, merge the correction to `main`, and create a new version tag;
do not move an existing tag. If the release was created but asset upload
failed, rerun the same tag workflow to replace the asset. Investigate any other
publication failure before retrying.

Never force-move or reuse a published version tag. The repository state at the
tag remains the source of truth for the release.
