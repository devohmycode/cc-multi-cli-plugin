---
name: setup
description: Configure ordinary claude startup for installed Multi providers.
disable-model-invocation: true
allowed-tools: Bash
---

Check `node --version` (requires >=24.12) and `claude --version`. Use a persistent
Node installation: setup records its executable path, so a temporary npx download
will break startup when removed. This user-invoked
setup installs a small wrapper and adds one marked PATH block to ~/.bashrc or
~/.zshrc. It preserves the real Claude executable and existing settings. Explain
these changes, then run the fixed helper using this plugin's root:

```sh
node "${CLAUDE_PLUGIN_ROOT}/plugins/multi-core/src/setup.ts"
```

If the user's shell cannot be identified, ask whether they use Bash or Zsh, then
pass `--shell bash` or `--shell zsh`. Never pass an API key as an argument. Keep
provider login separate from setup. Report failures without claiming completion.
On success, tell the user to open a new terminal, run `multi status`, and start
`claude-multi` to launch Multi. Setup never replaces or shadows the `claude`
command; plain `claude` keeps starting ordinary Claude Code unchanged. Existing
sessions do not acquire a new gateway. Install provider plugins at user scope
with the normal plugin installer; do not manually edit Claude caches.
