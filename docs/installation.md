# Installing Multi

## Current installation

Multi's experimental runtime currently requires a checkout, Node >= 24.12,
npm, and Claude Code. The marketplace manifest does not yet bootstrap the gateway.
The source directories are now split into `multi-core` and `multi-<provider>`,
but they still use checkout-relative imports and root npm dependencies. They are
not yet independently installable provider packages.
Follow [the manual installation steps](../README.md#for-humans). Cursor currently
supports Linux without WSL. Install Codex only if using the OpenAI integration;
Zen needs a key but does not require an OpenCode CLI during inference.

OpenAI uses Codex's ChatGPT login and CLI-owned renewal. The current adapter reads
Codex's `auth.json`, so the documented login command selects Codex's file store.
It does not change the user's persistent Codex configuration. Respect managed
authentication restrictions; do not extract credentials from an OS keyring.
For a remote machine, Codex also supports `login --device-auth` when enabled for
the account. See [official Codex authentication](https://developers.openai.com/codex/auth/).

Cursor's `--cursor-login` calls the official SDK's authentication API and leaves
credential storage with the SDK. Zen is API-key authentication, not an OAuth
integration: use [OpenCode's connection flow](https://opencode.ai/docs/zen/#how-it-works)
or a local environment variable. Never put a key in a Claude prompt or command argument.

To verify without inference charges, run `node --version`, `claude --version`,
and `node plugins/multi-core/src/launcher.ts --help`. For Cursor,
`--cursor-models` checks its authenticated catalog. `--zen-models` lists supported
models but does not verify credentials. Finally launch an interactive session and
check `/model`. Only claim live inference was verified if an actual request ran.

## For agents

1. Read the checkout's `AGENTS.md` and this guide. Reuse an existing checkout;
   preserve local work. If cloning, use a user-selected or clearly reported path.
2. Check Node, npm and Claude Code. Ask which providers the user wants if that
   preference is not already known. Check platform requirements for those providers.
3. Run `npm ci` in the repository root. Do not install the marketplace manifest
   and report the gateway operational: automatic activation is not implemented.
4. Reuse the requested providers' existing authentication without printing secret
   files. When login is needed, run the manual guide's provider command and let the
   user complete the browser interaction. Keep Zen key entry outside the transcript.
5. Perform the read-only checks above. Explain the exact launch command, including
   the absolute launcher path when the user's project is outside this checkout.
   An interactive Claude session belongs in the user's terminal, not nested inside
   another agent's tool session.
6. Report installed location, providers configured, checks completed, and any
   remaining user action. Do not change the user's `claude` command or global
   Claude settings as an undocumented installation side effect.

## Planned marketplace experience

This is the intended UX, not a list of commands shipped today. The reference is
[Claude HUD's human and agent setup flow](https://github.com/jarrodwatts/claude-hud/blob/main/CLAUDE.README.md):
marketplace installation followed by a namespaced setup command. We adopt the
structure; its statusline activation mechanism is not our gateway startup mechanism.

Users will select provider plugins in the Multi marketplace, each depending on a
shared core. A one-time core setup will configure ordinary `claude` startup to
launch the session gateway and the real Claude executable. Both manual and agent
instructions must invoke the same setup implementation, preserve existing settings,
and provide a reversal path. Provider enablement must honor Claude's plugin scope.

Proposed user-invoked commands:

| Command | Behavior |
| --- | --- |
| `/multi-core:setup` | Configure startup and verify prerequisites |
| `/multi-openai:login` | Run Codex's official browser login; offer device login for remote hosts |
| `/multi-cursor:login` | Run the existing official Cursor SDK login helper |
| `/multi-zen:connect` | Guide the user to Zen and local secret entry; reuse saved OpenCode auth |
| `/multi-core:status` | Show connection status and whether a restart is needed, without secrets |

Login commands should invoke fixed helpers through user-invoked plugin skills,
show a URL and waiting/completion status, and support cancellation. OAuth tokens
remain owned by the provider CLI or SDK. Secret entry must happen outside model
context; it is not a skill argument. With the current runtime, connecting a new
provider requires relaunching because credentials, catalogs and workers are
discovered at startup. An in-session refresh would require additional runtime work.
