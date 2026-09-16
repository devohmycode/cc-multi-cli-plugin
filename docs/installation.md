# Installing Multi

## Requirements

- Node 24.12 or newer from a persistent installation. Setup records its executable path.
- Claude Code 2.1.272 or newer with function hooks.
- OpenAI: the official Codex CLI (`codex`) and a ChatGPT login.
- Cursor: the official Cursor SDK login. No separate Cursor CLI is required.
- OpenCode Zen: an OpenCode account or an `OPENCODE_API_KEY`.
- Antigravity: the official `agy` CLI and its native login.

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

Each provider pulls in `multi-core`. Setup writes one marked PATH block to the
applicable shell file: `~/.bashrc`, `~/.zshrc`, fish's config file, or the
PowerShell profile. It writes wrappers and shims under Multi's platform data
directory. It never shadows `claude`; `claude-multi` starts Multi. Open a new
terminal after setup.

## Connect accounts

| Provider | Command | Account or credential |
| --- | --- | --- |
| OpenAI | `/multi-openai:login` | Codex's official ChatGPT login |
| Cursor | `/multi-cursor:login` | Official Cursor SDK browser login |
| OpenCode Zen | `/multi-zen:connect` | OpenCode auth or an API key |
| Antigravity | `/multi-antigravity:connect` | The official `agy` login and scoped hook |

Run Zen key entry in a separate terminal. After connecting any provider, relaunch
Claude so its models and workers are discovered. `multi status` reports installed
and enabled providers; it does not authenticate accounts or run inference.

## Update

Use Claude's normal marketplace and plugin update commands. Re-running
`/multi-core:setup` refreshes the startup files and wrappers.

## Uninstall

Run `multi uninstall` before removing the plugins. It removes Multi's marked PATH
block and known wrappers while retaining provider logins. Open a new terminal,
then remove the provider and core plugins through `/plugin` if desired.

## For agents

1. Check Node, Claude Code, the shell, the platform, and the requested providers.
2. Install the selected plugins at user scope through Claude's plugin manager.
3. Run `/multi-core:setup` and explain the marked PATH change.
4. Hand browser sign-in to the human. Have the human enter Zen keys in a separate
   terminal. Never accept credentials in chat or an agent tool session.
5. Run `multi status`. Ask the human to open a new terminal, launch `claude-multi`,
   and check `/model`.

## Run from a checkout

```sh
npm install
node plugins/multi-core/src/launcher.ts
MULTI_ANTIGRAVITY=1 node plugins/multi-core/src/launcher.ts
node plugins/multi-core/src/launcher.ts --antigravity-setup
```

The launcher relies on the installed `multi-core` plugin for its Claude Mods
hooks, so install the plugins from the checkout first:
`/plugin marketplace add /path/to/checkout` followed by the plugin installs
above. Antigravity is enabled by installing `multi-antigravity`. From a
checkout, set `MULTI_ANTIGRAVITY=1` to show its models and workers. Run
`--antigravity-setup` after the official `agy` login to install its scoped
permission hook.
