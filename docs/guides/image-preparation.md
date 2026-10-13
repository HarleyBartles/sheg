# Prepare and inspect images

Sheg can validate, store, scale, and export static image files for inspection. These operations run locally and do not call an inference provider. A saved image can be bound to a Clef visual question; see the [native Cloudflare Clef guide](../providers/clef.md) for request design and limits.

## Supported images and limits

Sheg accepts static PNG, JPEG, and WebP images up to 16 MiB and 16 megapixels. It rejects animated images, malformed files, and unsupported formats. A scale operation preserves the source format and full image, keeps proportions within one-pixel integer rounding per axis, and never enlarges it. It does not crop, tune image quality, or promise that small text and details remain legible.

`maxWidth` and `maxHeight` limit pixel dimensions. `maxBytes` limits only the encoded image file, not the complete model request or its context fit. Sheg may report `image_scale_target_unreachable` when the fixed encoder cannot meet the target without changing the image format or quality.

## Import, scale, and inspect

Import reads a file once, checks its supplied SHA-256 digest, validates its image content, and stores the exact bytes in the shared Sheg datastore. The resolved file path is reported by the CLI, but image identity and later operations use the digest-based asset ID. For a file source, include the lowercase 64-character digest. A saved asset reference uses the `assetId` returned by Sheg.

For visual follow-ons, query the source answer and use its `selectedVisualMaterial.materialId` as the exact saved image reference. Add that ID to `context.materialIds` and bind it to each question that needs pixels; inspect the child request to confirm only the intended images are included. An accepted follow-on retains its image asset independently of the source run, so source deletion does not remove pixels already pinned to the child. The agent supplies and preserves the description and caption; Sheg does not inspect the image to create them. See the [native Clef guide](../providers/clef.md) for image limits and [follow-on context projection](../../skills/stimulus-response-polling/references/run-and-recovery.md#choose-a-follow-on-context-explicitly) for text and answer-history controls.

On Windows, calculate the digest with PowerShell:

```powershell
(Get-FileHash -Algorithm SHA256 -LiteralPath .\approved-style.png).Hash.ToLowerInvariant()
```

Create an import request such as `import-image.json`:

```json
{
  "source": {
    "path": "./approved-style.png",
    "sha256": "<64 lowercase hexadecimal characters>"
  }
}
```

Run the CLI command from any directory. A relative file source resolves from the request file's directory:

```powershell
node dist/cli.js image-import --request .\import-image.json
```

Scale an imported image using a saved reference. Use one or more positive integer targets:

```json
{
  "source": { "assetId": "sha256:<64 lowercase hexadecimal characters>" },
  "maxWidth": 1200,
  "maxBytes": 2097152
}
```

```powershell
node dist/cli.js image-scale --request .\scale-image.json
```

The result identifies the original source and the prepared candidate, including their dimensions, byte sizes, and digests. `changed: false` means the source already met the requested bounds and Sheg reused it without re-encoding. Failed preparation does not create source or candidate records.

Read metadata without creating a preview:

```json
{ "assetId": "sha256:<64 lowercase hexadecimal characters>" }
```

```powershell
node dist/cli.js image-get --request .\get-image.json
```

Set `"export": true` to explicitly export or reuse a preview:

```json
{
  "assetId": "sha256:<64 lowercase hexadecimal characters>",
  "export": true
}
```

The returned path points to a digest-named file under `asset-previews/` inside Sheg's selected data root. The datastore remains authoritative; export verifies stored bytes and safely replaces only the tool-owned preview file. CLI and MCP share the platform default data root. Use `--data-root <absolute-directory>` for one CLI command or set `SHEG_DATA_DIR` for processes that should share another root. See the [datastore guide](datastore.md) for platform paths and compatibility.

For MCP, send an absolute local path or an existing saved `assetId`; relative paths are rejected. `image_get` returns metadata only by default. Set `export: true` to create a preview and return its local path. The generated request contracts are in the `stimulus-response-polling/assets` directory shipped with the plugin.

## Inspect before using a candidate

Keep the original asset and inspect any scaled candidate at its returned preview path. Check that the details relevant to the user's question remain visible at the prepared size. Smaller files can erase typography, facial expression, or other distinctions. If a candidate loses information, prepare a larger candidate or use the original in a future inference request that can admit it.

An inference-capable agent must author the image description and decide what visual evidence to present. Sheg does not describe image content, judge visual suitability, estimate full-request context fit from `maxBytes`, or make editorial decisions in this preparation flow. Inspect the complete study request before accepting it for provider execution.

## Storage and recovery

Imported bytes, prepared candidates, and their source derivation are retained in the shared datastore. Removing or moving the original file does not change a saved asset. Do not edit the database, backups, or preview files to change image identity. Use the digest-based asset ID and import again if the source bytes change.

If the datastore cannot be opened or migrated, use `run_storage` with `operation: "inspect"` to review compatibility and recovery options. Do not create a new data root to bypass the reported failure. Reset is a separate destructive action and requires an explicit confirmation. See [datastore compatibility and recovery](../decisions/0031-set-schema-nine-as-release-baseline.md) and the [release guide](releases.md#datastore-compatibility).
