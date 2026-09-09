# Privacy Policy — cc-multi-cli-plugin

_Last updated: 2026-09-09_

## Current gateway

The plugin has no hosted service or author-operated telemetry. Its gateway runs
on your machine and listens on localhost. It processes prompts, conversation
history, responses and tool data to route requests and track sessions.
Switching models can send earlier conversation content to the selected provider.

| Route | What receives task content |
| --- | --- |
| Claude passthrough | Anthropic, using your existing Claude login. |
| Direct OpenAI models and workers | OpenAI, using your Codex ChatGPT login. Claude Code executes tools. |
| Antigravity models and workers | Official Antigravity CLI using native account login and native tools. |
| Cursor models and workers | Cursor's official SDK and native execution loop, using its own login or SDK API key. |

Providers apply their own policies: [Anthropic](https://www.anthropic.com/legal/privacy),
[OpenAI](https://openai.com/policies/privacy-policy), and [Cursor](https://cursor.com/privacy).
The Cursor SDK retains its own telemetry and privacy controls; absence of plugin-author
telemetry does not disable provider telemetry. Native tools may read workspace files,
run commands or contact external services according to the effective permissions.
Claude-executed tools and any configured Claude MCP services retain their own behavior.
The Cursor route disables ambient MCP servers and native child spawning.
Antigravity is opt-in and experimental. Its gateway records live in
`~/.gemini/antigravity-cli/multi-harness/`; the CLI retains native conversations and
logs separately. Setup adds a namespaced global native hook that is inactive outside
gateway-launched runs. No Antigravity OAuth tokens are extracted. See
[the native bridge](docs/antigravity.md).

Claude credentials are not forwarded to OpenAI or Cursor. OpenAI uses the saved
`CODEX_HOME/auth.json` (or `~/.codex/auth.json`); the gateway asks the official Codex
app-server to renew tokens, with Codex owning OAuth and persistence. It creates no
separate OpenAI login store. Cursor authentication remains with the official SDK.

Without Claude login, OpenAI automatic approval uses the account's supported
reviewer. Review requests can include action transcripts and workspace evidence
read for the decision. Cursor's native review remains with its originating SDK run.
See [the execution and permission contract](ARCHITECTURE.md).

## Local storage

- **Launcher settings:** an owner-only `multi-native-settings-*` directory under
  the system temporary directory contains the generated model picker and hooks.
  It is removed on normal shutdown; a crash can leave it behind.
- **Cursor bridge state:** `~/.cursor/multi-harness/` contains session/run identities,
  instructions, history hashes, saved responses, displayed events and failure records.
  These support continuation and result recovery and may contain task content,
  workspace paths and tool-output previews. They persist after the gateway exits.
- **Provider-owned files:** Claude Code, Codex and the Cursor SDK keep their own
  credentials, transcripts and execution state. Cursor SDK login stores a user key
  in `~/.cursor/sdk/auth.json`; its agent/checkpoint/event storage may contain supplied
  conversation context and tool results. Closing the gateway does not delete it.
- **Diagnostics:** optional `MULTI_NATIVE_TRACE` output reports routing, model/effort,
  status and tool names without prompt bodies or credentials. Opt-in live checks
  write fixtures, conversation logs and usage reports to temporary directories;
  they also create provider-owned sessions.

The OpenAI gateway processes translation state in memory and does not rewrite
Claude's stored transcript. The author cannot access your local session records.

## OpenCode Zen

Zen requests send the selected conversation, instructions, tools and attachments
to `https://opencode.ai/zen/v1/`. The gateway reads `OPENCODE_API_KEY` or the
OpenCode-managed saved Zen API entry; it does not create another token store.
It does not forward Claude/Codex credentials to Zen or pass the environment key
to the launched Claude process. Provider retention and billing follow
[OpenCode Zen's policies](https://opencode.ai/docs/zen/#privacy).

Zen's session-affinity header and Responses cache key are hashes of the Claude
session, worker, model and gateway workspace. They are stable within that scope
and do not contain a plaintext workspace path. No prompt bodies or keys appear
in optional gateway traces; token/cache usage may appear there. Model-owned
reasoning signatures are stored in Claude's transcript for continuation. The
Zen adapter has no separate conversation store. Live checks create synthetic
conversation/usage artifacts under the system temporary directory.

## Data from earlier versions

The slash-command companion, setup wizard and CLI/ACP transports are removed.
Removing code does not delete data or configuration created by an earlier release:

- **Plugin config** at `~/.claude/plugins/cc-multi-cli-plugin/config.json` — API keys you provided for Exa and Context7 MCP servers (so the plugin can wire them into the CLIs that need them).
- **Setup records and CLI configuration** — the earlier setup wizard recorded managed MCP servers in `managed-servers.json` alongside its plugin config, and could write MCP entries and backups in Codex's and Cursor's own configuration locations.
- **Workspace state** under `$CLAUDE_PLUGIN_DATA/state/<workspace-slug>-<hash>/` when that environment variable is set, otherwise under the system temporary directory's `codex-companion/<workspace-slug>-<hash>/`. `state.json` records configuration and tracked jobs; `jobs/<id>.json` contains job data and results. These supported `/multi:status`, `/multi:result`, and `/multi:cancel`.
- **Job diagnostics** in that workspace directory's `jobs/<id>.log` — progress, errors, and logged output can include task content.
- **Broker files** — `broker.json` in the workspace state directory points to a temporary broker session directory containing process/socket information and diagnostics.

These paths are historical data-removal guidance, not current storage contracts.
Earlier CLI routes and their configured MCP services may also have retained data
under their providers' own policies.

## Removing data

Stop the gateway and active provider runs before removing session state. Removing
`~/.cursor/multi-harness/` discards bridge continuation and recovery records, but
does not remove the SDK's own data or credentials. Remove unwanted temporary
launcher/live-test directories separately. Provider credentials and transcripts
have their own retention and deletion controls.

For earlier versions, remove unwanted plugin configuration, workspace job state
and broker directories listed above. Review wizard-created MCP entries and backups
in each CLI's configuration separately, preserving unrelated entries. Removing
only `~/.claude/plugins/cc-multi-cli-plugin` does not remove data stored elsewhere.

If installed through the marketplace, uninstall with
`/plugin uninstall multi@cc-multi-cli-plugin` in Claude Code; uninstall any old
per-CLI plugins separately. A checkout launcher is independent of that registration.
For provider-side deletion, follow the provider's own process; the plugin author
has no access to those systems.

## Source and contact

The [source](https://github.com/greenpolo/cc-multi-cli-plugin) is licensed Apache 2.0.
Report privacy concerns through [GitHub issues](https://github.com/greenpolo/cc-multi-cli-plugin/issues).
Changes to data handling are recorded in [CHANGELOG.md](CHANGELOG.md).
