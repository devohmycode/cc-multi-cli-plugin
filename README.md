![cc-multi-cli-plugin](docs/assets/banner.png)

# cc-multi-cli-plugin

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/greenpolo/cc-multi-cli-plugin?include_prereleases&sort=semver&label=release)](https://github.com/greenpolo/cc-multi-cli-plugin/releases)
[![Built for Claude Code](https://img.shields.io/badge/built_for-Claude_Code-d97757)](https://docs.anthropic.com/en/docs/claude-code)
[![Node 24+](https://img.shields.io/badge/node-%E2%89%A524.12-3c873a)](https://nodejs.org/en/about/previous-releases)
[![Stars](https://img.shields.io/github/stars/greenpolo/cc-multi-cli-plugin?style=social)](https://github.com/greenpolo/cc-multi-cli-plugin/stargazers)

cc-multi-cli-plugin brings external models into **one Claude Code session**. A
localhost gateway, started with the session, adds OpenAI models to the `/model`
picker and registers native OpenAI workers. Claude requests still go to Anthropic
on your Claude subscription; GPT requests use the ChatGPT login Codex already
saved. Claude Code's own tool loop and permissions run the work.

The next step is an **external harness bridge**: a provider's real CLI executes
the task while our gateway streams its progress and answer into Claude Code.
Cursor is the first planned bridge, then OpenCode. This is not available yet.
[ARCHITECTURE.md](ARCHITECTURE.md) is the authoritative direction, including
status per target and the execution/subscription boundaries.

The earlier slash-command delegation system (`/codex:*`, `/cursor:*`,
`/opencode:*`, `/multi:*`, their forwarder subagents, the companion process, and
the Codex broker) has been **removed**. The Cursor and OpenCode transport code is
kept as a reference for the planned bridges and is not wired to anything.

## Requirements

- Node ≥ 24.12 (types are stripped at runtime; there is no build step).
- Claude Code, signed in with `claude`.
- Codex, signed in with `codex login` — the gateway reads its saved token from
  `CODEX_HOME/auth.json`, or `~/.codex/auth.json`. No API key is needed.

## Run it

From a checkout:

```sh
npm install
node plugins/multi/scripts/native-model-gateway.ts
```

That starts a session-local gateway and launches Claude against it. Additional
Claude arguments follow `--`, for example `-- --model opus`. Keep
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and `ANTHROPIC_BASE_URL` unset so
Claude keeps its subscription login; the launcher refuses to start otherwise.
Exit Claude normally to stop the gateway. It changes no global configuration.

### GPT as the main agent

Run `/model` to select GPT-6 Astra or GPT-5.6 Sol, Terra, or Luna. The picker
keeps the built-in Claude choices. Press **s** on a selected row to switch for
this session only. You can also type a model ID directly:

```text
/model multi/openai/gpt-5.6-luna
/effort high
/model sonnet
```

Typed `/model` commands and Enter in the picker save Claude Code's default for
future sessions; use **s** if you also launch ordinary Claude without this
gateway. GPT runs Claude Code's native tool loop and can delegate to the workers
below. Switching back to Claude resumes subscription-backed Anthropic requests.
Text and tool history survive switches; opaque reasoning state stays with its own
provider and is excluded from requests to the other provider. The stored
transcript is not rewritten. Any prior conversation content you continue with GPT
is sent to OpenAI as context.

### Native OpenAI workers

Ask: **"Use openai-luna-high to investigate this issue."** The selected model runs
inside Claude Code's native subagent harness, with its own agent row, tool
activity, elapsed time, and completion notification. The main conversation keeps
using whichever model you selected.

| Worker | OpenAI model |
| --- | --- |
| `openai-native` | `gpt-6-astra` |
| `openai-sol` | `gpt-5.6-sol` |
| `openai-terra` | `gpt-5.6-terra` |
| `openai-luna` | `gpt-5.6-luna` |

Append `-low`, `-medium`, `-high`, `-xhigh`, or `-max` to any worker name, for
example `openai-sol-max`; unsuffixed names use `medium`. These set the native
subagent's `effort`, which the gateway sends as OpenAI's `reasoning.effort`.
Main-session effort is independent. `ultra` orchestration and arbitrary
unregistered model strings are not supported. Restart through the launcher to
load newly added workers; a plain Claude session does not acquire them.

Native Claude Code permissions apply to the worker's Read, Grep, Glob, Bash,
Edit, and Write tools.

## Supported and unsupported today

Tested with Claude Code 2.1.261. Supported: text and native function tools,
images in user messages and tool results, JSON-schema output, streamed output,
encrypted reasoning continuation, and request cancellation. Image sources can be
base64 (PNG, JPEG, GIF, WebP) or HTTP(S) URLs; the gateway forwards URLs to the
provider without fetching them. The request limit is 8 MiB and the timeout is
three minutes. Both `output_config.format` and legacy `output_format` JSON
schemas map to Responses `text.format` with strict mode; schemas must satisfy
OpenAI's strict subset (required properties, `additionalProperties: false`) and
are passed through unchanged rather than rewritten.

Rejected or missing: documents, server-side tools, explicit stop sequences, and
per-request output-token caps (the subscription endpoint does not accept one).
MCP tool names over 64 characters are not translated yet. The full built-in tool
definitions are accepted, but this is not feature parity — unsupported content
also prevents switching an existing conversation that contains it, and auxiliary
features with incompatible schemas can still fail. Claude assumes a conservative
200K context window for these custom model IDs; long-session compaction and
resume have not been live-validated. Codex owns token refresh; renew its login if
the gateway reports 401. Credential stores that do not expose `auth.json` are not
supported. Cursor, OpenCode, Antigravity, Grok Build, and llama.cpp routes are
not implemented.

Boris Cherny has explicitly stated that using Claude Code with other models
through a proxy is supported, while noting that harness prompting and tools are
model-specific ([statement](https://x.com/bcherny/status/2086183356795060396)).

## Checks

`npm test` runs `tsc --noEmit` and the offline unit tests. It makes no provider
calls.

The reproducers below are **opt-in** and spend real Claude and OpenAI
subscription usage. Run one only when changing the live path.

```sh
node plugins/multi/scripts/test/native-model-gateway.ts openai-luna-high
node plugins/multi/scripts/test/native-main-switch.ts
node plugins/multi/scripts/test/native-translation.ts
```

The first delegates a real native Read/Edit task in a temporary directory and
asserts the upstream model and reasoning level; omit the worker name to test
Astra at medium effort. The second tests Claude → GPT main → native delegation →
Claude in one conversation. The third tests modern and legacy JSON schemas plus
user/tool-result images against Luna using synthetic fixtures.

Set `MULTI_NATIVE_TRACE=1` to print routing, upstream model/effort, HTTP status,
and tool-name diagnostics on stderr, without prompt bodies, response bodies, or
credentials.

## License

Apache 2.0. See [NOTICE](NOTICE) for upstream credits.
