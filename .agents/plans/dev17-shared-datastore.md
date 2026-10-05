# dev.17: Shared default datastore

## Scope

CLI and MCP must select the same default datastore for the same OS user without requiring an agent to remember a flag. Change the shared root resolver to use the platform application data directory regardless of `PLUGIN_DATA`. Preserve explicit `SHEG_DATA_DIR` and CLI `--data-root` overrides. Existing pre-release plugin directories are not moved, merged, reset, or deleted automatically.

## Implementation

- [x] Extend root-selection and packaged lifecycle tests to cover differing plugin environments and standalone CLI recall without a data-root flag; observe the behavioral failure first.
- [x] Remove plugin-specific default selection at the shared infrastructure owner. Keep worker root propagation and persistence contracts unchanged.
- [x] Record the changed operational choice in an ADR, document shared defaults and pre-release store access, and clarify CLI help.
- [x] Set root version to `0.3.0-dev.17`, regenerate distribution and metadata, and validate the complete repository gate and copied package behavior.
- [x] Review final owners, boundaries, and exceptions, commit, push, and open a draft PR into `develop`.

## Validation

The packaged lifecycle test must start and complete a run through MCP with `PLUGIN_DATA`, then recall its answer using standalone CLI without `PLUGIN_DATA`, `SHEG_DATA_DIR`, or `--data-root`. Both processes use isolated platform data locations so the test cannot touch user studies. Root-selection behavior covers Windows, macOS, Linux, and explicit override validation. Reuse existing lifecycle and recovery tests; do not add source-change assertions or development receipt files.
