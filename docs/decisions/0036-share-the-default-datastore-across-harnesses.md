# ADR-0036: Share the default datastore across harnesses

- Status: Accepted
- Date: 2026-10-05
- Supersedes: [ADR-0018](0018-store-durable-runs-in-sqlite.md) for data-root selection

## Context

CLI and MCP share the durable runtime, but a plugin host supplies `PLUGIN_DATA` while a standalone shell does not. Prioritizing that host variable selected different databases for the same user. An agent switching entrypoints could lose sight of recorded studies unless it remembered a data-root flag.

## Options considered

- Retain host-specific defaults and document the flag. This leaves ordinary cross-entrypoint use dependent on an agent remembering the host's private path.
- Discover plugin directories from the CLI. This couples datastore selection to one harness's installation layout and creates ambiguity across plugin installations.
- Use the platform's Sheg application data directory for every entrypoint. This gives the same OS user a stable default independent of plugin installation and retains explicit isolation when requested.

## Decision

The shared infrastructure resolver uses `SHEG_DATA_DIR` when explicitly set, otherwise the platform's Sheg application data directory. `PLUGIN_DATA` has no role in selection. Windows uses `LOCALAPPDATA/Sheg` with a home-directory fallback; macOS uses `~/Library/Application Support/Sheg`; Linux uses `XDG_DATA_HOME/sheg` with `~/.local/share/sheg` as fallback. The CLI retains `--data-root` as a command-specific override. Detached workers receive the already resolved root from their launching runtime.

This changes a pre-release default before the v0.3.0 compatibility promise. Existing plugin-backed databases remain untouched and can be explicitly selected. Do not automatically merge, relocate, reset, or delete old stores. Existing schema inspection, supported migration, and explicit recovery behavior applies to whichever store is selected.

## Consequences

MCP, standalone CLI, and fresh plugin installations share recorded runs by default for the same OS user. Harness-specific `PLUGIN_DATA` changes no longer change visible studies. Intentional isolated studies and test processes must select an explicit Sheg root or isolated platform data location. Users with pre-release plugin stores can select those stores for access; this change does not transfer their runs into the new default.
