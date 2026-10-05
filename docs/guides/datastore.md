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

The [release guide](releases.md#datastore-compatibility) owns schema compatibility and recovery. [ADR-0036](../decisions/0036-share-the-default-datastore-across-harnesses.md) records the default-selection decision.
