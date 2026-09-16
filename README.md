![multi-cli — plugin for claude code](docs/assets/banner.svg)

# cc-multi-cli-plugin

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/greenpolo/cc-multi-cli-plugin?include_prereleases&sort=semver&label=release)](https://github.com/greenpolo/cc-multi-cli-plugin/releases)
[![Built for Claude Code](https://img.shields.io/badge/built_for-Claude_Code-d97757)](https://docs.anthropic.com/en/docs/claude-code)
[![Node 24.12+](https://img.shields.io/badge/Node-%E2%89%A524.12-555)](#install)
[![Stars](https://img.shields.io/github/stars/greenpolo/cc-multi-cli-plugin?style=social)](https://github.com/greenpolo/cc-multi-cli-plugin/stargazers)

Multi brings external models and coding harnesses into one Claude Code session through the `/model` picker and named native workers, with each provider's own login and permissions. Providers are OpenAI (ChatGPT via Codex login), Cursor (official SDK), OpenCode Zen (API key), and Antigravity (official CLI).

## Install

In Claude Code, add the marketplace and install the providers you want:

```text
/plugin marketplace add greenpolo/cc-multi-cli-plugin
/plugin install multi-openai@cc-multi-cli-plugin
/plugin install multi-cursor@cc-multi-cli-plugin
/plugin install multi-zen@cc-multi-cli-plugin
/plugin install multi-antigravity@cc-multi-cli-plugin
/reload-plugins
/multi-core:setup
```

Install any subset; each provider pulls in the shared `multi-core` plugin. Open a new terminal, run `claude-multi`, and connect the providers you installed:

| Plugin | Command | What it gives you |
| --- | --- | --- |
| `multi-openai` | `/multi-openai:login` | [ChatGPT models through Codex](docs/openai.md) |
| `multi-cursor` | `/multi-cursor:login` | [Official Cursor SDK models and workers](docs/cursor.md) |
| `multi-zen` | `/multi-zen:connect` | [OpenCode Zen models with an API key](docs/zen.md) |
| `multi-antigravity` | `/multi-antigravity:connect` | [Antigravity models and workers through `agy`](docs/antigravity.md) |

`multi status` shows what is installed and connected. `multi uninstall` removes the shell integration and keeps provider logins. Plain `claude` is never changed. Details: [installation](docs/installation.md).

### For agents

Paste this into any coding agent:

> Install cc-multi-cli-plugin by following https://github.com/greenpolo/cc-multi-cli-plugin/blob/main/docs/installation.md#for-agents. Ask which providers I want, hand browser logins and API-key entry to me, and never ask for credentials in chat.

## Use

Launch with `claude-multi`. `/model` lists the external models next to Claude's; `/effort` sets effort where the model supports it. Named workers run as subagents with live progress, elapsed time and cancellation. Claude's permission mode governs every provider; see [permissions](docs/permissions.md). Resume a saved session with `claude-multi --resume <session-id>`.

## Platforms

Linux, macOS, and Windows are supported. See [platform support](docs/platform-support.md).

## Development

Run `npm run check` for the repository checks.

See the [contributor guide](AGENTS.md).

## License

Apache 2.0. See [NOTICE](NOTICE) for upstream credits.
