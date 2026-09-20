# Grok

Run the official Grok Build CLI (`grok`) as a native coding worker inside Claude Code.

## Setup

Install the plugin as described in [docs/installation.md](installation.md), then
sign in with the official flow:

```text
/multi-grok:login
```

From a checkout, the equivalent is `grok login` followed by a normal launch.
`--grok-models` prints the catalog. The gateway uses the CLI's own account
credential and never reads it. `XAI_API_KEY` is removed from the environment of
every run: an API key silently outranks the browser login and would move billing
from the subscription to metered xAI credit.

The CLI renews its own access token — measured at six hours — from a refresh
token it stores, and asks for a new sign-in periodically. `/multi-usage` reports
whether a renewable login is present rather than counting down that short clock,
and a failed run says to run `grok login`.

## Models

The picker reads the models advertised by `grok models`.

| Picker entry | Route | Named worker |
| --- | --- | --- |
| Advertised model | `multi/grok/<id>` | `grok-<id>` |

`MULTI_GROK_MODELS` restricts the rows to a comma-separated list of advertised
IDs, leaving other providers unchanged. `/effort` accepts `low`, `medium`,
`high`, `xhigh`, and `max`; the CLI also supports `none` and `minimal`, which
have no Claude row and are refused explicitly. The model that answers is not
always the row's name — usage and receipts report the model the CLI billed.

## Execution and permissions

Claude's permission mode and tool rules take precedence and travel with each
run; nothing is written to your Grok configuration and no global hook is
installed.

| Claude mode | Grok run |
| --- | --- |
| Auto | `--permission-mode auto` plus the rules below |
| acceptEdits | `--permission-mode acceptEdits` |
| Plan | `--permission-mode plan`, plus `Bash`, `Edit` and `Write` denied and the matching tools removed |
| Bypass | `--permission-mode bypassPermissions`, explicit restrictions retained |

Restrictions are expressed three times on purpose. The native toolset is bounded
with `--tools`, every ungranted tool is *also* removed by name — the allowlist
alone left nineteen tools for a twelve-tool request, the CLI adding its own
planning, feedback and media tools — and execution is gated with `--deny` rules whose syntax matches Claude
Code's own (`Bash(git:*)`, `Write(path)`, `MCPTool(*)`). Deny rules outrank every
mode, including Bypass. Their genres are coarser than the tool names — `Edit(*)`
also refuses the `write` tool — so a rule is only sent when none of the tools it
reaches was granted, and finer restrictions rely on the bounded toolset. Native subagents (`--disallowed-tools Agent`), dynamic
tool discovery (`search_tool`, `use_tool`) and the interactive `ask_user_question`
tool are always removed.

Plan mode alone removes no native tool, so Multi reconstructs it with explicit
denials rather than trusting the flag. Unsupported modes, untranslatable tool
restrictions, and an unenforced policy fail explicitly.

External actions appear as display text and are never replayed as executable
Claude tools. There is no Grok reviewer, and Multi never borrows another
provider's.

### MCP is denied, not hidden

Grok connects your configured MCP servers after a run starts, and no per-run flag
prevents it: with a two-entry allowlist and the dynamic discovery tools removed,
the announced toolset still grew from 2 entries to 65, all 63 additions being MCP
tools. Multi denies their execution with `MCPTool(*)`, a rule the CLI validates
and applies above every mode, but the model still sees those names. If you need
them out of sight, remove the servers from your Grok configuration with
`grok mcp`.

## What the provider is sent

The conversation is flattened into one native prompt behind a fixed preamble.
Claude's own `system` is never forwarded, and neither are its system reminders:
they are instructions addressed to Claude, mostly catalogues of its deferred
tools, MCP servers, skills and subagents that this provider cannot call. On a
measured session they were 99% of the prompt — 95,011 characters out of 95,852
for a one-word message — and they described capabilities the provider does not
have. Recalled memories are the one exception, because their content exists
nowhere the CLI can reach; the repository's own `AGENTS.md` is dropped with the
rest, since the CLI reads it directly.

A turn left empty by that filtering adds nothing, and a request with no content
at all fails explicitly.

## Continuation, caching and failures

State is isolated by Claude session, worker, provider, and canonical workspace.
The session identity is chosen by the gateway before the run starts and recorded
as soon as the CLI produces output, so a crash resumes the native conversation
instead of starting a fresh one. Follow-ups send only the newest turn after the
last assistant response, and outer history changes produce a notice and continue
on the native record. Native state is never rewound.

One turn runs at a time per worker and workspace, and a second prompt waits its
turn rather than being refused: the answer streams to you before the turn is
released, so a prompt typed straight after reading it would otherwise be lost.
Cursor and Antigravity still refuse a concurrent prompt; only Grok queues.

A completed identical request replays its saved output. A run that ends without
a terminal event is never assumed complete: the next request resumes with an
interruption notice. An answer returned on a different native session is refused
rather than merged. Cost and token counts come from the run's own terminal event;
`grok usage <session>` reports the session total the CLI itself recorded.

## Paths per OS

| OS | Credential | Native sessions |
| --- | --- | --- |
| Linux and macOS | `~/.grok/auth.json` | `~/.grok/sessions/<encoded cwd>/<id>/` |
| Windows | `%USERPROFILE%\.grok\auth.json` | `%USERPROFILE%\.grok\sessions\<encoded cwd>\<id>\` |

Multi keeps its own harness records in a `multi-harness` directory beside them
and never rewrites the CLI's session files.

## Limits

One name differs between the two vocabularies: the shell is announced as
`run_terminal_command` but removed as `run_terminal_cmd`, and passing the
announced name is accepted in silence while the tool keeps running. Multi maps it
and verifies the result on every announcement.

Grok Build is an early beta: its flags and tool names can change between
releases, so the adapter checks the toolset the CLI announces on every run and
fails explicitly when a policy did not take effect. The CLI's sandbox profiles
rely on Landlock and Seatbelt and are unavailable on Windows; Multi does not use
them. Images, PDF attachments, strict output schemas, explicit tool choice and
stop sequences are not supported through this bridge.
