# Privacy Policy — cc-multi-cli-plugin

_Last updated: 2026-09-05_

## TL;DR

**The plugin has no hosted service or author-operated telemetry.** The experimental
gateway runs on your machine and listens on localhost. The earlier companion
was removed in the TypeScript branch.
Selected CLI/provider routes and configured MCP servers receive task content.
The direct GPT gateway sends conversation context to OpenAI and forwards
Claude-bound requests to Anthropic. Switching models can therefore send earlier
conversation content to the newly selected provider. Each provider applies its
own privacy policy.

## What the plugin does not do

- Does not collect telemetry or analytics for the plugin author
- Does not "phone home" to any server operated by the plugin author
- Does not upload job logs or diagnostics to a service operated by the plugin author
- Does not create plugin-author user accounts; local job/session identifiers are used to track work

## What gets stored on your machine

The current gateway processes requests in memory and writes no state files of its
own. Earlier companion versions kept the following local files; removing the
code does not remove existing data. Provider-owned files still apply. These files
may contain task content or credentials; local storage does not mean the corresponding task content is
never sent to a provider.

- **Plugin config** at `~/.claude/plugins/cc-multi-cli-plugin/config.json` — API keys you provided for Exa and Context7 MCP servers (so the plugin can wire them into the CLIs that need them).
- **Setup records and CLI configuration** — the earlier setup wizard recorded managed MCP servers in `managed-servers.json` alongside its plugin config, and could write MCP entries and backups in Codex's and Cursor's own configuration locations.
- **Workspace state** under `$CLAUDE_PLUGIN_DATA/state/<workspace-slug>-<hash>/` when that environment variable is set, otherwise under the system temporary directory's `codex-companion/<workspace-slug>-<hash>/`. `state.json` records configuration and tracked jobs; `jobs/<id>.json` contains job data and results. These supported `/multi:status`, `/multi:result`, and `/multi:cancel`.
- **Job diagnostics** in that workspace directory's `jobs/<id>.log` — progress, errors, and logged output can include task content.
- **Broker files** — `broker.json` in the workspace state directory points to a temporary broker session directory containing process/socket information and diagnostics.
- **Provider-owned files** — Claude Code and external CLIs maintain their own credentials and transcripts. The direct GPT gateway reads Codex's existing `auth.json`; it does not create a separate OpenAI login store.

These paths document existing data from earlier versions, not a commitment to
retain their storage design in future harness bridges.

## What goes to third parties

Earlier companion commands forwarded the task to the selected CLI. Those routes
are no longer active in this checkout; their provider policies are retained below
for users of earlier versions. The experimental native
gateway forwards model requests directly to the selected provider. These services
apply their own privacy policies:

| CLI / service (current and earlier versions) | Provider | Their privacy policy |
|---|---|---|
| `/codex:execute`, `/codex:review`, `/codex:adversarial-review`, `/codex:rescue` | OpenAI | https://openai.com/policies/privacy-policy |
| Experimental GPT `/model` choices and native OpenAI workers | OpenAI, through the existing Codex ChatGPT login | https://openai.com/policies/privacy-policy |
| `/cursor:delegate`, `/cursor:research`, `/cursor:explore` | Cursor (Anysphere) | https://cursor.com/privacy |
| `/opencode:delegate`, `/opencode:research`, `/opencode:explore` | OpenCode (SST) / configured model provider | https://opencode.ai/docs (and the routed provider's policy) |
| Exa MCP (web search) | Exa | https://exa.ai/privacy-policy |
| Context7 MCP (library docs) | Upstash | https://upstash.com/privacy |
| Claude Code itself | Anthropic | https://www.anthropic.com/legal/privacy |

The plugin processes prompts, responses, and tool data to route tasks, translate
formats, and track results. Companion job files and provider CLI transcripts may
retain task content locally. The native gateway processes requests in memory and
does not rewrite Claude's stored transcript. Its optional `MULTI_NATIVE_TRACE`
diagnostics report routing, model/effort, status, and tool names without prompt
bodies or credentials. Claude credentials are not forwarded to OpenAI; the GPT
route reads the existing Codex login and leaves refresh to Codex.

External harness bridges for Antigravity and Grok Build are planned, not active
data routes. As bridges are implemented, their real CLIs will handle provider
communication and native login. A Claude Code display does not change which
external service receives the task. See [ARCHITECTURE.md](ARCHITECTURE.md) for
current integration status.

## Your rights / removing data

Stop active jobs and gateway/broker processes before deleting their state. Remove
the plugin's setup directory and the relevant workspace state and broker session
directories described above. Deleting only
`~/.claude/plugins/cc-multi-cli-plugin` does not remove job state stored elsewhere.

Remove unwanted wizard-created MCP entries and backups from the CLI configuration
files separately, preserving unrelated entries. Provider credentials and local
Claude/CLI transcripts have their own retention and deletion controls.

To uninstall the plugin entirely, run `/plugin uninstall multi@cc-multi-cli-plugin` (and the per-CLI plugins) inside Claude Code.

For data retention or deletion at the **third-party providers** above, follow each provider's own data-deletion process — the plugin author has no access to those systems.

## Open source

The plugin source is licensed Apache 2.0 and available at https://github.com/greenpolo/cc-multi-cli-plugin. Anyone can audit exactly what the plugin does. If you find behavior that contradicts this policy, please open an issue.

## Changes to this policy

If the plugin's data-handling behavior ever changes, this file will be updated and the change will be noted in the [CHANGELOG](CHANGELOG.md). The "Last updated" date at the top reflects the most recent revision.

## Contact

Open an issue at https://github.com/greenpolo/cc-multi-cli-plugin/issues for any privacy-related question or concern.
