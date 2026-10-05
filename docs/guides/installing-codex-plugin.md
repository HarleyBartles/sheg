# Install the Codex plugin

The repository is a local marketplace whose `.agents/plugins/marketplace.json` points to the generated `plugins/sheg/` package. That package contains the portable `plugin.json` and `mcp.json` manifests, bundled server, shipped skills, and runtime assets. Users need Node.js 24 but not TypeScript or `node_modules` to launch the installed server.

## Personal installation

1. Copy or clone this repository to a stable local directory.
2. Register the repo marketplace once with `codex plugin marketplace add <repository-root>`.
3. Restart Codex and install or enable **Sheg** in the Plugins Directory.
4. Confirm Sheg's tools load and use keyless `run_inspect` to validate a proposed request. Hosted runs need the selected Jev key and explicit authorization.
5. Offer **Connect TypeSafe**, **Connect OpenRouter**, or **Skip for now**. Users can connect both keys by repeating setup. Skipping permits request design; inference still requires either a configured local Laya service or the selected Jev credential.

## Secure key setup on Windows

An installation agent offers the choices above before concluding onboarding. For the selected route, resolve the actual repository or installed plugin root and give the user the command below with that absolute path. If an interactive terminal tool is available, the agent can open a visible terminal and run the command for the user to paste into the local hidden prompt. Never ask for a key in chat, an MCP argument, a command argument, a file, or an environment variable.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\path\to\sheg\dist\credentials\windows-credential.ps1" -Operation Setup -TargetName Sheg/Jev/TypeSafe
```

For OpenRouter, use `-TargetName Sheg/Jev/OpenRouter`. The helper writes directly to the current user's Windows Credential Manager. Run `Status` to check safely, `Setup` again to replace, or `Remove` to delete the selected entry. If secure storage is unavailable or rejects setup, explain the failure and stop key setup. There is no plaintext fallback. macOS and Linux backends are future work.

Credential setup makes no inference request and does not authorize a paid study. When a user who skipped setup later selects Jev, offer this local prompt again for the selected route. Having both keys never chooses or switches routes automatically.

The marketplace entry points to `./plugins/sheg`, resolved from the repository root. Codex installs a cached copy, so package edits require refreshing the marketplace and restarting Codex. Follow the current [Codex plugin installation guide](https://developers.openai.com/plugins/build/plugins) for local marketplace behavior.

## Updating a development copy

From the repository root, run:

```sh
npm ci
npm run build
```

Commit canonical source and the generated `dist/` and `plugins/sheg/` outputs together. Refresh the local marketplace plugin and restart Codex to load the updated package. The server launches as `node ${PLUGIN_ROOT}/dist/mcp.js` from the installed package root.

## Provider configuration

Configure each provider using its dedicated reference: [Jev](../providers/jev.md) or [local Laya](../providers/laya.md).
