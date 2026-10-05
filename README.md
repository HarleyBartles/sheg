# Sheg

Sheg helps you explore how different simulated readers respond to text. It runs bounded studies with frozen respondent profiles, typed questions, and recorded answers you can inspect and use to shape a follow-up.

## A study example

Suppose you are choosing a pull quote for an article. Sheg can ask a varied set of reader profiles which paragraph best represents the article's central idea, then let you select the recorded contexts for a follow-up that presents each chosen paragraph on its own and asks what it communicates. The first study compares candidates; the follow-up helps you inspect why they worked for those simulated readers.

Vary respondent profiles, stimulus text, questions and response options, or what each respondent has already seen. Repeating identical inputs does not add meaningful coverage. Simulated responses can help you explore alternatives, but they do not establish human readership, real-world accuracy, statistical significance, or causal lift.

## Install and start

Sheg supports the Codex plugin harness and requires Node.js 24. You do not need TypeScript, npm dependencies, or a local build to use the packaged plugin.

Add the [Sheg Git marketplace](https://github.com/HarleyBartles/sheg) with `codex plugin marketplace add HarleyBartles/sheg`, restart Codex, then select Sheg in the Plugins Directory. For a versioned GitHub Release ZIP or local development, follow the [installation guide](docs/guides/installing-codex-plugin.md).

Start with a request such as: “I am choosing a pull quote for this article. Help me compare the strongest candidate paragraphs with distinct reader perspectives, then propose a follow-up that shows each selected paragraph in isolation and asks what it communicates.” Sheg helps shape the study and checks its fit before asking you to approve a run. Hosted inference needs your authorization and a call limit.

## Shared local studies

MCP and the standalone CLI use the same datastore by default for the same OS user: `%LOCALAPPDATA%\Sheg` on Windows, `~/Library/Application Support/Sheg` on macOS, and `${XDG_DATA_HOME:-~/.local/share}/sheg` on Linux. Switching entrypoints or plugin installations does not require a data-root flag. Set `SHEG_DATA_DIR` for an intentional alternative, or use CLI `--data-root` for one command.

Earlier development builds used the plugin host's `PLUGIN_DATA` directory. Those databases remain untouched; dev.17 does not copy or merge them into the shared default. They can still be selected explicitly. See the [datastore guide](docs/guides/datastore.md) before switching an existing development installation.

## Learn more

- [Design a study](skills/study-design/SKILL.md) and [run polls, queries, and follow-ups](skills/stimulus-response-polling/SKILL.md).
- Configure [Jev](docs/providers/jev.md) or review the separately operated [Laya service](docs/providers/laya.md).
- Read the [study manifest guide](docs/reference/study-manifest.md), [data contracts](docs/reference/data-contracts.md), and [run and recovery guide](skills/stimulus-response-polling/references/run-and-recovery.md).
- Browse the [architecture decisions](docs/decisions/README.md) and [release guide](docs/guides/releases.md).

Sheg is licensed under the [MIT License](LICENSE).
