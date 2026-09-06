# Privacy Policy — cc-multi-cli-plugin

_Last updated: 2026-09-05_

## TL;DR

**The plugin has no hosted service or author-operated telemetry.** The gateway
runs on your machine and listens on localhost. It forwards Claude-bound requests
to Anthropic and requests for registered OpenAI models to OpenAI. Switching
models can therefore send earlier conversation content to the newly selected
provider. Each provider applies its own privacy policy.

## What the plugin does not do

- Does not collect telemetry or analytics for the plugin author
- Does not "phone home" to any server operated by the plugin author
- Does not upload logs or diagnostics to a service operated by the plugin author
- Does not create plugin-author user accounts

## What gets stored on your machine

The gateway processes requests in memory. It writes no state files, no job
records, and no logs of its own, and it does not rewrite Claude Code's stored
transcript. Its optional `MULTI_NATIVE_TRACE=1` diagnostics go to stderr and
report routing, model/effort, HTTP status, and tool names — not prompt bodies,
response bodies, or credentials.

Provider-owned files still apply: Claude Code and Codex maintain their own
credentials and transcripts. The gateway reads Codex's existing `auth.json`
(`CODEX_HOME/auth.json`, or `~/.codex/auth.json`); it does not create a separate
OpenAI login store and leaves token refresh to Codex.

Earlier versions of this plugin stored workspace job state, job logs, broker
files, and MCP setup records. That implementation has been removed. If you used
it, its files remain until you delete them — see "Removing data" below.

## What goes to third parties

| Route | Provider | Their privacy policy |
|---|---|---|
| Claude models (passthrough) | Anthropic | https://www.anthropic.com/legal/privacy |
| Registered GPT `/model` choices and native OpenAI workers, through the existing Codex ChatGPT login | OpenAI | https://openai.com/policies/privacy-policy |

The gateway processes prompts, responses, and tool data to route requests and
translate formats. Routing is decided per request from the model ID, and each
branch attaches only its own provider's credentials: Claude credentials are not
forwarded to OpenAI, and the Codex token is not forwarded to Anthropic.

External harness bridges for Cursor, OpenCode, and later targets are planned, not
active data routes. As bridges are implemented, their real CLIs will handle
provider communication and native login. A Claude Code display does not change
which external service receives the task. See [ARCHITECTURE.md](ARCHITECTURE.md)
for current integration status.

## Removing data

Exit the launched Claude session to stop the gateway; nothing of its own remains
on disk. If you used an earlier command-based version, remove
`~/.claude/plugins/cc-multi-cli-plugin/` and any workspace state directories it
created (under `$CLAUDE_PLUGIN_DATA/state/` or the system temporary directory's
`codex-companion/`), and remove wizard-created MCP entries and backups from the
CLI configuration files separately, preserving unrelated entries.

Provider credentials and local Claude/CLI transcripts have their own retention
and deletion controls. For data retention or deletion at the **third-party
providers** above, follow each provider's own process — the plugin author has no
access to those systems.

## Open source

The source is licensed Apache 2.0 and available at
https://github.com/greenpolo/cc-multi-cli-plugin. Anyone can audit exactly what
it does. If you find behavior that contradicts this policy, please open an issue.

## Changes to this policy

If the plugin's data-handling behavior ever changes, this file will be updated
and the change will be noted in the [CHANGELOG](CHANGELOG.md). The "Last updated"
date at the top reflects the most recent revision.

## Contact

Open an issue at https://github.com/greenpolo/cc-multi-cli-plugin/issues for any
privacy-related question or concern.
