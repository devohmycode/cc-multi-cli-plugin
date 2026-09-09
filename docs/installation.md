# Installing Multi

## For humans

Use the [README's in-Claude installation steps](../README.md#for-humans), or run
these equivalent terminal commands for the providers you want:

```sh
claude plugin marketplace add greenpolo/cc-multi-cli-plugin
claude plugin install multi-openai@cc-multi-cli-plugin --scope user
claude plugin install multi-cursor@cc-multi-cli-plugin --scope user
claude plugin install multi-zen@cc-multi-cli-plugin --scope user
```

You can install any subset. Each provider declares a dependency on `multi-core`.
Core requires user scope because its startup code runs before the workspace trust
prompt. Provider enablement comes from `claude plugin list --json`, including its
native scope/settings resolution. Multi forwards `--settings` and
`--setting-sources` when querying that list.

Open Claude, run `/reload-plugins`, then `/multi-core:setup`. Setup checks for Node
>=24.12 and a real Claude executable. Use a persistent Node installation, not a
temporary npx download. Setup records its Node executable for the wrapper and
supports Bash/Zsh on Linux/macOS. Cursor and Antigravity currently require Linux;
this installer does not add Windows/WSL harness support.

Setup adds one marked PATH block to `~/.bashrc` or `~/.zshrc` and writes its small
bootstrap under `~/.local/share/multi-cli/`. It does not replace the Claude binary,
change global Claude model settings, log in to providers, or spend inference usage.
Existing shell aliases/functions named `claude` can shadow the wrapper; reconcile
those explicitly. Open a new terminal after setup. `multi status` should list the
installed core and your selected providers; this is an enablement check, not an
authentication or inference test. Then run `claude` normally.

## Connect accounts

| In-Claude command | Underlying flow |
| --- | --- |
| `/multi-openai:login` | Codex's official ChatGPT browser login |
| `/multi-cursor:login` | Official Cursor SDK browser login |
| `/multi-zen:connect` | Existing OpenCode auth or hidden API-key entry in your terminal |
| `/multi-antigravity:connect` | Install the scoped native permission hook after official agy login |

The equivalent terminal commands are `multi login openai`, `multi login cursor`,
`multi connect zen`, and `multi login antigravity`. OpenAI supports the additional
`--device-auth` argument for remote hosts when enabled on the account. See
[Codex authentication](https://developers.openai.com/codex/auth/).

OpenAI's current adapter reads Codex's `auth.json`. The login helper asks Codex to
use its file store for that invocation; it does not change persistent Codex
configuration or extract OS-keyring credentials. Codex retains token renewal.
Cursor credentials remain owned by the official SDK.

Zen uses API keys, not OAuth. `multi connect zen` reuses `OPENCODE_API_KEY` or
OpenCode's saved key. If missing, it directs you to https://opencode.ai/auth and
accepts hidden key entry in a terminal, preserving other providers in OpenCode's
`auth.json` and writing it with mode 0600. Never paste a key into Claude, a skill
argument, or a shell command. The helper refuses key entry through a non-TTY.

After login, relaunch Claude: credentials, models and workers are discovered at
startup. Installing Antigravity enables its experimental route; its owned hook is
refreshed at startup to match the active runtime path. Other native hooks and
credentials are preserved.

## Updates and removal

Use Claude's normal marketplace/plugin update commands. The wrapper queries the
installed core location on each new launch, so it does not pin a versioned cache
path. Running sessions keep their original runtime until they exit. Re-running
`/multi-core:setup` refreshes the bootstrap and is safe to repeat.

`multi uninstall` removes our exact marked shell block and known bootstrap files.
It preserves other shell content and provider credentials, and works even if the
core package was already removed. If you edited the marked block, uninstall stops
rather than overwriting it. Open a new terminal after removal, then remove the
provider/core plugins with `/plugin` if desired. Antigravity's separately installed
native hook remains; it is environment-scoped and inert in ordinary `agy` runs.

Disabling all providers or disabling/removing core causes ordinary `claude`
passthrough. Disabled provider routes also reject typed model IDs and workers,
even when credentials still exist. Auth, plugin management, version/help and
updater commands pass directly to the real Claude executable.

## For agents

1. Read `AGENTS.md` and this guide. Check Node, npm, Claude, shell and platform.
   Ask which providers the user wants if that is not already known.
2. Use the native terminal installation commands above at user scope. Reuse the
   existing marketplace when present. Do not manually edit Claude's plugin cache.
3. Run the core setup helper from the installed core root:
   `node <core-root>/plugins/multi-core/src/setup.ts`. Find that root in
   `claude plugin list --json`; do not guess a versioned path. If needed, pass
   `--shell bash` or `--shell zsh`, or `--claude /absolute/path/to/real/claude`.
   Explain the marked shell change. Do not overwrite user aliases or functions.
4. Reuse existing logins. The installed CLI is available immediately at
   `~/.local/share/multi-cli/bin/multi` even before the user's shell reloads. Launch
   requested browser-login flows and let the user complete them. Zen key entry
   belongs in their own terminal, never an agent tool session or transcript.
5. Run `multi status` using that absolute path, and tell the user to open a new
   terminal and verify `/model`. Keep interactive Claude in the user's terminal;
   do not nest it inside an agent tool session. Report exactly what was tested.

## Local development and package layout

For an unpublished checkout, add its absolute path as a local marketplace instead
of the GitHub URL, then install providers normally. Root `package.json` and
`package-lock.json` are copied with core; Claude installs their Node dependencies.
Run `npm run test:live:install` for verification using a temporary Claude home and the real plugin manager,
including running the cached runtime after removing the source checkout.

The core package deliberately ships the whole reviewed runtime. Provider packages
supply opt-in identity and connection skills, rather than loading executable
provider code from arbitrary cache paths before workspace trust. Source remains
organized in `plugins/multi-core` and `plugins/multi-<provider>`. New providers still
need a runtime adapter, a marketplace entry and an enablement identifier.

Direct development launches remain available after root `npm ci`:

```sh
node plugins/multi-core/src/launcher.ts
```

That entry uses credential-based discovery. The installed wrapper supplies an
explicit provider allowlist and uses the real Claude executable to avoid recursion.
The installation documentation structure follows
[Claude HUD's human/agent setup flow](https://github.com/jarrodwatts/claude-hud/blob/main/CLAUDE.README.md);
Multi's gateway startup implementation is separate.
