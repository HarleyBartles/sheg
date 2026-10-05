# Local datastore

## Shared default

CLI and MCP use one Sheg datastore per OS user by default. Both call the same runtime and root resolver; detached workers receive that selected root. Plugin installation paths, plugin versions, current working directories, and the host's `PLUGIN_DATA` variable do not select different stores.

| Platform | Default root |
| --- | --- |
| Windows | `%LOCALAPPDATA%\Sheg`, or `~/AppData/Local/Sheg` when `LOCALAPPDATA` is absent |
| macOS | `~/Library/Application Support/Sheg` |
| Linux | `$XDG_DATA_HOME/sheg`, or `~/.local/share/sheg` when `XDG_DATA_HOME` is absent |

The root contains `runs.sqlite` and the runtime's associated files. For normal use, invoke CLI durable commands without `--data-root`; runs created through MCP are already in the same store.

## Intentional alternatives

Set `SHEG_DATA_DIR` to an absolute directory to select another store. This setting must reach each process intended to use that alternative. CLI `--data-root <dir>` overrides the setting for that command. Test harnesses must isolate their roots explicitly or supply isolated platform data directories. Invalid explicit environment paths fail instead of silently using another store.

## Earlier development stores

Before dev.17, MCP preferred the plugin host's `PLUGIN_DATA` directory while a standalone CLI used the platform directory. Dev.17 stops using that host variable for root selection. It does not relocate, merge, reset, or delete either existing database. A previously used plugin store may therefore contain runs absent from the new default.

To inspect a known earlier store, select its root explicitly with CLI `--data-root`, or configure `SHEG_DATA_DIR` for both entrypoints if that store should remain your chosen store. This is an intentional override for existing data, not a requirement for new MCP and CLI runs to share the default. Do not overwrite one database with another when both contain studies, and do not copy a live SQLite database's files while its MCP processes or detached workers are running.

An older schema may require recovery rather than open successfully. Use storage inspection on the selected root before considering any reset. Existing recovery preserves a backup and requires explicit confirmation; the default-location change does not authorize a reset. The [release guide](releases.md#datastore-compatibility) owns schema compatibility, and [ADR-0036](../decisions/0036-share-the-default-datastore-across-harnesses.md) records the default-selection decision.
