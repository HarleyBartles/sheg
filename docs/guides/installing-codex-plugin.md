# Install the Codex plugin

This repository root is both an Agent Plugin package and a local repo marketplace. The portable `plugin.json` and `mcp.json` define the plugin and its local stdio MCP server. `.agents/plugins/marketplace.json` makes the root plugin available from the Codex Plugins Directory. The built server is included under `dist/`; users need Node.js 24 but not TypeScript or `node_modules` to launch the installed server.

## Personal installation

1. Copy or clone this repository to a stable local directory.
2. Register the repo marketplace once with `codex plugin marketplace add <repository-root>`.
3. Restart Codex and install or enable **System One Polling** in the Plugins Directory.
4. Verify `poll_check` and `poll_trace` appear before preparing a paid run.

The marketplace entry points to the repository root (`./`), where `plugin.json`, `mcp.json`, `skills/`, and `dist/` live. Codex installs a cached copy, so source edits require refreshing the marketplace and restarting Codex. Follow the current [Codex plugin installation guide](https://developers.openai.com/plugins/build/plugins) for local marketplace behavior.

## Updating a development copy

From the repository root, run:

```sh
npm ci
npm run build
```

Commit source and generated `dist/` together. Refresh the local marketplace plugin and restart Codex to load the updated package. The server launches as `node ${PLUGIN_ROOT}/dist/mcp.js`.

## Provider configuration

Configure each provider using its dedicated reference: [Jev](../providers/jev.md) or [local Laya](../providers/laya.md).
