# Sheg releases

Sheg releases the Codex plugin from reviewed Git tags. The tag is the source
identity; GitHub Releases attach a reproducible plugin ZIP built from that tag.
The repository remains private to npm and is not published as an npm package.

## Version policy

Keep `package.json`, both root version fields in `package-lock.json`, and
`plugin.json` on the same version. Do not change them on ordinary feature
merges to `develop`.

The root `package.json` version is the product-version authority, and the MCP initialization version must agree with it. Deliberate dogfood checkpoints on `develop` may use `MAJOR.MINOR.PATCH-dev.N`; prepared release candidates may use `MAJOR.MINOR.PATCH-rc.N`. Increment only at intentional checkpoints, not every merge. The current dogfood roadmap assigns `0.3.0-dev.2` to its next develop merge. See [ADR-0023](../decisions/0023-identify-development-and-candidate-builds.md).

Before `1.0.0`:

- Increment the patch for compatible fixes.
- Increment the minor version for a coherent bundle of backward-compatible
  functionality.
- Document breaking changes clearly. Pre-1.0 does not make breakage invisible
  to users.

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

For local candidate inspection, omit the release tag and use an explicit candidate filename. This creates a local ZIP and does not publish it. Record the candidate version and SHA-256 digest with dogfood evidence. Stable publication accepts only `vMAJOR.MINOR.PATCH` tags with matching stable manifests; prerelease tags do not publish. Promote a candidate by removing its suffix on the release branch and aligning all version surfaces before tagging.

On Windows, the npm wrapper uses the Python launcher (`py -3`). By default the
ZIP is written to `release-artifacts/sheg-v<version>.zip`.

The archive has plugin-root paths and includes `plugin.json`, `package.json`,
`mcp.json`, `.agents/plugins/marketplace.json`, `skills/`, `dist/`, and the
license. It excludes source, tests, the dependency tree, and build tooling. The
bundled MCP entrypoint runs with Node.js 24 and does not need TypeScript or
`node_modules` at runtime.

## Install a GitHub Release ZIP

1. Download `sheg-v<version>.zip` from the matching GitHub Release.
2. Extract the archive into a stable directory. Keep the archive's paths intact.
3. Register the extracted directory as a local marketplace with
   `codex plugin marketplace add <extracted-directory>`.
4. Restart Codex, install or enable Sheg from the Plugins Directory, and
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
