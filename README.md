![cc-multi-cli-plugin](docs/assets/banner.png)

# cc-multi-cli-plugin

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/greenpolo/cc-multi-cli-plugin?include_prereleases&sort=semver&label=release)](https://github.com/greenpolo/cc-multi-cli-plugin/releases)
[![Built for Claude Code](https://img.shields.io/badge/built_for-Claude_Code-d97757)](https://docs.anthropic.com/en/docs/claude-code)
[![CLIs supported](https://img.shields.io/badge/CLIs-Codex_·_Cursor_·_OpenCode-555)](#existing-commands-and-skills)
[![Stars](https://img.shields.io/github/stars/greenpolo/cc-multi-cli-plugin?style=social)](https://github.com/greenpolo/cc-multi-cli-plugin/stargazers)

cc-multi-cli-plugin is being refactored to bring external models and coding
harnesses into one Claude Code session. The checkout contains an experimental
direct GPT gateway and the earlier Codex, Cursor, and OpenCode delegation system.

## Direction: one session, multiple models and harnesses

We are building a custom Node gateway that brings external models and real coding
CLIs into Claude Code's `/model` picker and named native workers. Visible subagent
rows, elapsed time, live progress, completion, and cancellation are central to
the experience, alongside preserving each provider's supported authentication.

The direct GPT path below already works experimentally: Claude Code executes its
tools. The next step is an **external harness bridge**: a provider's real CLI
executes the task while our gateway streams its progress and answer into Claude
Code. For example, a future "Gemini via Antigravity" selection would run the
actual Antigravity harness. This bridge is planned, not available yet; native
tool-card and approval rendering remain unproven.

Our targets are OpenAI, Cursor, Antigravity, OpenCode, local models through
llama.cpp, and Grok Build. We will maintain our adapters and reuse existing
process/session infrastructure. There is no planned replacement with a general
gateway engine or a user-facing backend choice. The upcoming refactor may replace
or delete the existing commands, skills, and forwarders.
[ARCHITECTURE.md](ARCHITECTURE.md) is the authoritative direction, including
current status, execution boundaries, and the first bridge milestone.

## Install the existing command-based plugin

Paste into Claude Code:

```
/plugin marketplace add https://github.com/greenpolo/cc-multi-cli-plugin
/plugin install multi@cc-multi-cli-plugin
/multi:setup
```

The existing `/multi:setup` wizard guides CLI detection and sub-plugin installation,
with Exa/Context7 configuration for Codex and Cursor. OpenCode manages its own MCP
configuration. This installs the current command surface; the experimental gateway
below is launched separately from a checkout.

## Experimental native OpenAI models

From a checkout, start a new Claude Code session with:

```sh
node plugins/multi/scripts/native-model-gateway.mjs
```

Run `/model` to select GPT-6 Astra or GPT-5.6 Sol, Terra, or Luna as the **main
agent**. The picker retains the built-in Claude choices. Press **s** on a selected
row to switch for this session only. You can also type a model ID directly:

```text
/model multi/openai/gpt-5.6-luna
/effort high
/model sonnet
```

Typed `/model` commands and Enter in the picker save Claude Code's default for
future sessions; use **s** if you also launch ordinary Claude without this gateway.
GPT runs Claude Code's native tool loop and can delegate to the workers below.
Switching back to Claude resumes subscription-backed Anthropic requests. Text
and tool history survive switches; opaque reasoning state stays with its own
provider and is excluded from requests to the other provider. The stored
transcript is not rewritten. Any prior conversation content you continue with
GPT is sent to OpenAI as context.

Then ask: **“Use openai-luna-high to investigate this issue.”** The selected model
runs inside Claude Code's native subagent harness, with its own agent row, tool activity,
elapsed time, and completion notification. The main conversation uses the model
you select. Claude requests use the existing Claude subscription; GPT requests
use the ChatGPT login
saved by Codex (`CODEX_HOME/auth.json`, or `~/.codex/auth.json`). Sign in with
`claude` and `codex login` first. No API key is needed.

The launcher registers these workers (unsuffixed names use `medium` reasoning):

| Worker | OpenAI model |
| --- | --- |
| `openai-native` | `gpt-6-astra` |
| `openai-sol` | `gpt-5.6-sol` |
| `openai-terra` | `gpt-5.6-terra` |
| `openai-luna` | `gpt-5.6-luna` |

Append `-low`, `-medium`, `-high`, `-xhigh`, or `-max` to any worker name to choose
its reasoning level, for example `openai-sol-max` or `openai-luna-low`. These set
the native subagent's `effort`, which the gateway sends as OpenAI's
`reasoning.effort`. Main-session effort is independent. `ultra` orchestration and
arbitrary unregistered model strings are not supported. Restart through this
launcher to load newly added workers; an already-running plain Claude session
does not acquire them automatically.

The launcher starts a localhost gateway for that session and injects these
agent definitions and model-picker settings. It does not itself change global settings. Claude
requests pass through to Anthropic; only registered external worker models route to
OpenAI. Credentials stay separated. Native Claude Code permissions apply to the
worker's Read, Grep, Glob, Bash, Edit, and Write tools. Additional Claude arguments
can follow `--`, for example `-- --model opus`. Keep API-key and gateway-auth
overrides unset to retain subscription authentication.

This is an opt-in prototype, tested with Claude Code 2.1.261. It currently supports
text and native function tools, images in user messages and tool results,
JSON-schema output, streamed output, encrypted reasoning continuation,
and request cancellation. Image sources can be base64 (PNG, JPEG, GIF, WebP) or
HTTP(S) URLs; the gateway forwards URLs to the provider without fetching them.
The total request limit remains 8 MiB and the timeout is three minutes.
Both `output_config.format` and legacy `output_format` JSON schemas map to
Responses `text.format` with strict mode. Schemas must satisfy OpenAI's strict
subset (including required properties and `additionalProperties: false`);
the gateway preserves them unchanged rather than rewriting their constraints.
Documents, server-side tools, and explicit stop sequences are rejected. The subscription endpoint does not
accept a per-request output-token cap. Codex owns token refresh; renew its login
if the gateway reports 401. Credential stores that do not expose `auth.json` are
not supported yet. Direct OpenCode Zen integration and external harness-backed
workers for Cursor, Antigravity, and Grok Build are not implemented; neither is
the llama.cpp route.
The full built-in tool definitions are accepted, but this is not complete feature
parity: unsupported content also prevents switching an existing conversation
that contains it. Auxiliary features with incompatible schemas can still fail.
Long MCP tool names (over 64 characters) are not translated yet.
Claude currently assumes a conservative 200K context window for these custom
model IDs; long-session compaction and resume have not been live-validated.
Boris Cherny has explicitly stated that using Claude Code with other models
through a proxy is supported, while noting that harness prompting and tools are
model-specific ([statement](https://x.com/bcherny/status/2086183356795060396)).

Offline checks run with `npm test`. The opt-in integration check
`node plugins/multi/scripts/test/native-model-gateway.mjs openai-luna-high` uses both
subscriptions to delegate a real native Read/Edit task in a temporary directory
and asserts the upstream model and reasoning level. Omit the name to test Astra
at medium effort.
`node plugins/multi/scripts/test/native-main-switch.mjs` tests Claude → GPT main
→ native delegation → Claude in one conversation with generated fixtures.
`node plugins/multi/scripts/test/native-translation.mjs` tests modern and legacy
JSON schemas plus user/tool-result images against Luna, using only synthetic
fixtures and the Codex subscription.

Set `MULTI_NATIVE_TRACE=1` to print routing, upstream model/effort, HTTP status, and tool-name diagnostics
without logging prompts, response bodies, or credentials. Exit Claude normally
to stop its gateway. Existing `/codex:*`, `/cursor:*`, and `/opencode:*` commands
use the companion path, independently of this gateway.

## Existing commands and skills

These belong to the earlier companion-based implementation and may be replaced or
deleted in the refactor. The `customize` and `multi-cli-anything` skills modify that
interface; they do not implement native gateway integrations. Their prompts have
not been updated for the new direction.

Provider commands live under each CLI's namespace; the cross-cutting `/multi:*` commands operate the shared runtime.

| Command | What it does |
|---|---|
| `/codex:execute` | Delegate a specific plan or plan step to Codex |
| `/codex:rescue` | Hand a stuck or open-ended problem to Codex for an independent investigation |
| `/codex:review` | Codex code review of your working tree or a branch (read-only) |
| `/codex:adversarial-review` | Adversarial design/code review — challenges the approach, not just the diff (read-only) |
| `/cursor:delegate` | Delegate an implementation task or plan step to Cursor (agentic; writes code; supports `--until-done`) |
| `/cursor:research` | Read-only external web/documentation research via Cursor |
| `/cursor:explore` | Read-only codebase exploration via Cursor |
| `/opencode:delegate` | Delegate an implementation task to OpenCode (agentic; writes code; supports `--until-done`; default model: opencode/claude-opus-5 via Zen) |
| `/opencode:research` | Read-only external web/documentation research via OpenCode |
| `/opencode:explore` | Read-only codebase exploration via OpenCode |
| `/multi:setup` | One-shot wizard — detects CLIs, configures Exa + Context7 MCPs |
| `/multi:status` | Show active and recent background jobs for this repo |
| `/multi:result` | Show the stored final output for a finished job |
| `/multi:cancel` | Cancel an active background job |

Provider model availability comes from the installed CLI and the user's account.
The companion passes explicit model choices to its adapter; the native gateway
currently accepts only the registered GPT models described above. Billing depends
on the actual provider and credentials, not just a model name or prefix.

## Transports

Each CLI is driven over a transport. These are the current companion transports; the ACP path is opt-in.

- **Codex** → ASP (app-server behind a broker).
- **Cursor** and **OpenCode** → headless print mode **by default**, with an optional **ACP** path (Agent Client Protocol — structured JSON-RPC over stdio, via the official `@agentclientprotocol/sdk`). ACP adds in-protocol model selection, session modes, and `session/cancel`; it's still in bake-in, so headless remains the default.

Opt into ACP per CLI with environment variables (e.g. in `~/.claude/settings.json` under `env`):

```json
"env": {
  "MULTI_TRANSPORT_CURSOR": "acp",
  "MULTI_TRANSPORT_OPENCODE": "acp"
}
```

Each is `acp` | `headless` (default `headless`). With no flag set, behavior is identical to before. Codex has no ACP path (it exposes no native ACP). When on the ACP path, `ACP_TRACE=1` traces the JSON-RPC wire to stderr.

## Known issues

These are upstream CLI quirks and current limitations. If you hit something not listed, check the companion's stderr (the forwarders append `2>&1`) — a bad model id, an auth failure, or a sandbox block surfaces there.

- **Cursor runs in headless `agent -p` mode by default** (ACP is opt-in — see [Transports](#transports)). On the headless path the adapter delivers the prompt on stdin, selects the model with `--model` (default `auto`), and parses `json`/`stream-json` output. MCP servers come from Cursor's own `~/.cursor/mcp.json`, which `/multi:setup` maintains (this holds on the ACP path too — the adapter passes no MCP servers in-protocol, so Cursor reads its own config either way).

- **Cursor's shell is slow/unreliable on Windows.** Cursor's terminal tool can stall or wait out a per-command timeout on Windows (host-PATH/WSL, open upstream). So `/cursor:delegate` does **not** run build/test verification itself — it lists the commands in a `## Verification` block and Claude runs them. File writes and web/codebase reads are unaffected.

- **OpenCode has no `--read-only` flag.** For read-only roles (`/opencode:research`, `/opencode:explore`), the adapter enforces read-only by injecting a custom primary agent via `OPENCODE_CONFIG_CONTENT` with write/edit/bash denied, plus an `OPENCODE_PERMISSION` deny floor. A stale bun `opencode.exe` may shadow the npm `.cmd` shim on Windows — the adapter never resolves to `opencode.exe`; set `OPENCODE_CLI_PATH` to force the right binary if needed.

- **OpenCode billing depends on the selected provider and login.** Its current
  adapter default is `opencode/claude-opus-5` through Zen, overridable with
  `OPENCODE_CLI_DEFAULT_MODEL`. An `anthropic/*` prefix alone does not mean the
  request uses the same Claude subscription as Claude Code.

- **OpenCode `--effort` maps to `opencode run --variant`** (provider-specific reasoning effort, validated by OpenCode against the chosen model; headless transport only). `--until-done` is supported.

- **OpenCode MCP servers are not managed by `/multi:setup`.** OpenCode reads MCP configuration from its own `opencode.json`; use OpenCode's interactive wizard to wire Exa/Context7 there.

These notes describe the existing companion implementation, not guarantees for the planned harness bridges.

## License

Apache 2.0. See [NOTICE](NOTICE) for upstream credits.
