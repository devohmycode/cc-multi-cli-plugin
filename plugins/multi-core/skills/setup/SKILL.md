---
name: setup
description: Configure ordinary claude startup for installed Multi providers.
disable-model-invocation: true
allowed-tools: Bash
---

Check `node --version` (requires >=24.12) and `claude --version`. Use a persistent
Node installation: setup records its executable path, so a temporary npx download
will break startup when removed. This user-invoked
setup installs small wrappers and adds one marked PATH block to ~/.bashrc, ~/.zshrc,
fish's config file, or the PowerShell profile. It preserves the real Claude
executable and existing settings. Explain these changes, then offer two optional customizations before running
setup. Use the defaults unless the user chooses otherwise:

- **Launch command name** (default `claude-multi`). Multi is the real Claude Code
  binary started behind a local gateway, so only the command name differs. Any name
  works, such as `multiclaude`; pass it with `--command <name>`. Naming it `claude`
  shadows the plain command for every launch, including scripts, editors and agents
  that run `claude`; explain that before accepting it.
- **Models shown in `/model`** (default: curated rows for connected providers). Pass
  `--models <id,id,...>` with full IDs such as `multi/openai/gpt-6-astra` from the
  provider docs, `--models none` to hide external rows, or `--models all` to show
  the full connected catalog. Claude's own models always stay listed. Use
  `--models +<id,id,...>` to add models to the saved selection; with no saved
  selection, it extends the curated defaults. Existing explicit selections
  remain until changed. If a requested worker is unavailable, find its model ID
  in the provider docs or with `--cursor-models` / `--zen-models`, add it to the
  displayed models, and relaunch the session. Do not inject model-selection
  advice at every worker spawn.

Run the fixed helper using this plugin's root, adding the chosen flags:

```sh
node "${CLAUDE_PLUGIN_ROOT}/plugins/multi-core/src/setup.ts"
```

Re-running setup without flags keeps the previous command name and model
selection.

If the user's shell cannot be identified, ask whether they use Bash, Zsh, fish,
PowerShell, or cmd, then pass the matching `--shell` value. Never pass an API key
as an argument. Keep provider login separate from setup. Report failures without
claiming completion.
On success, tell the user to open a new terminal, run `multi status`, and start
the launch command (`claude-multi` by default) to launch Multi. Unless the user
chose the name `claude`, setup never replaces or shadows the `claude` command;
plain `claude` keeps starting ordinary Claude Code unchanged. Existing
sessions do not acquire a new gateway. Install provider plugins at user scope
with the normal plugin installer; do not manually edit Claude caches.
