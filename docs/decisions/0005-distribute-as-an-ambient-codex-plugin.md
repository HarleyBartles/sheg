# ADR-0005: Distribute as an ambient Codex plugin

- Status: Accepted
- Date: 2026-09-27
- Supersedes: None

## Context

The simulated-reader skill and harness are useful across the maintainer's
repositories. Installing a copy into every consuming repository would create
repeated configuration and version drift. Publishing through the personal
agent-asset marketplace is not required for a plugin that is installed directly
in Codex and made available ambiently.

The skill needs to provide editorial judgment and instructions, while the
harness must make model decisions through a reusable provider interface. A
bundled MCP server provides a stable tool boundary without asking an agent to
orchestrate each reader decision itself.

## Options considered

- Install a copy in each consuming repository. This makes repository ownership
  explicit but duplicates installation and upgrade work.
- Publish only through the personal plugin marketplace. This fits marketplace
  managed distribution but adds an unnecessary distribution dependency for
  this personal ambient plugin.
- Keep the plugin and harness in this repository and install the plugin at the
  Codex user level. The skill, server, and runner have one canonical source and
  are available across repositories.

## Decision

Make this repository the canonical source for a self-contained Codex plugin
containing the simulated-reader skill and a bundled Node.js MCP server. Install
it at the Codex user level for ambient use across repositories. Do not require
consuming repositories to vendor or install it individually, and do not make
the agent-asset marketplace a required distribution path. The MCP server calls
the shared harness; provider adapters handle Jev or a separately configured
local Laya service.

## Consequences

There is one editable implementation and one update path. The packaged plugin
must resolve its files relative to its installed location and work without the
source checkout or a consuming repository. Packaging and installation need
explicit verification. The local Laya service and model weights remain
independent of the plugin, and provider choice is explicit rather than a
silent fallback.
