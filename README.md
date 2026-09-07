![cc-multi-cli-plugin](docs/assets/banner.png)

# cc-multi-cli-plugin

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/greenpolo/cc-multi-cli-plugin?include_prereleases&sort=semver&label=release)](https://github.com/greenpolo/cc-multi-cli-plugin/releases)
[![Built for Claude Code](https://img.shields.io/badge/built_for-Claude_Code-d97757)](https://docs.anthropic.com/en/docs/claude-code)
[![Node 24.12+](https://img.shields.io/badge/Node-%E2%89%A524.12-555)](#requirements)
[![Stars](https://img.shields.io/github/stars/greenpolo/cc-multi-cli-plugin?style=social)](https://github.com/greenpolo/cc-multi-cli-plugin/stargazers)

cc-multi-cli-plugin is being refactored to bring external models and coding
harnesses into one Claude Code session. The checkout contains an experimental
direct GPT gateway and an experimental Cursor SDK bridge in TypeScript, plus
retained Cursor/OpenCode transport references.
The earlier command-based delegation system was removed in the TypeScript branch.

## Direction: one session, multiple models and harnesses

We are building a custom Node gateway that brings external models and real coding
CLIs into Claude Code's `/model` picker and named native workers. Visible subagent
rows, elapsed time, live progress, completion, and cancellation are central to
the experience, alongside preserving each provider's supported authentication.

The direct GPT path below already works experimentally: Claude Code executes its
tools. The **Cursor SDK bridge** also hands tool execution to Claude: Cursor's
custom-tool callbacks pause while Claude applies permissions and returns results.
Cursor retains its own inference loop and system prompt. This route is implemented
with offline coverage and a live Composer 2.5 contract covering Claude main-model
and native-worker Read/Edit, cancellation, and switching back to Claude.
A future "Gemini via Antigravity" selection would run the actual Antigravity
harness; that separate integration remains planned.

Our targets are OpenAI, Cursor, Antigravity, OpenCode, local models through
llama.cpp, and Grok Build. We will maintain our adapters and reuse existing
process/session infrastructure. There is no planned replacement with a general
gateway engine or a user-facing backend choice. The old commands, skills, and
forwarders were removed in the TypeScript branch; their design is not a requirement
for the new integrations.
[ARCHITECTURE.md](ARCHITECTURE.md) is the authoritative direction, including
current status, execution boundaries, and the first bridge milestone.

## Requirements

Node ≥ 24.12 and Claude Code signed in normally. Enable OpenAI with Codex's ChatGPT
login, or Cursor with the SDK login below, or both. From a checkout, run `npm install` for dependencies. `npm test`
runs type checking and offline tests. Node runs the gateway's TypeScript directly.

## Experimental native OpenAI models

From a checkout, start a new Claude Code session with:

```sh
node plugins/multi/src/native-model-gateway.ts
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
text and native function tools, images and documents in user messages and tool
results, JSON-schema output, streamed output, encrypted reasoning continuation,
local stop sequences, and request cancellation. Image sources can be base64 (PNG, JPEG, GIF, WebP) or
HTTP(S) URLs; the gateway forwards URLs to the provider without fetching them.
The request limit is 8 MiB and the timeout is three minutes. Response streaming
is bounded to 32 MiB overall and 8 MiB per SSE event.
Both `output_config.format` and legacy `output_format` JSON schemas map to
Responses `text.format` with strict mode. Schemas must satisfy OpenAI's strict
subset (including required properties and `additionalProperties: false`);
the gateway preserves them unchanged rather than rewriting their constraints.
Documents support base64 PDFs and plain-text sources. URL-based documents and
provider-hosted file IDs are rejected rather than fetched or silently discarded.
Long MCP names and tool IDs use deterministic aliases; Claude receives the
original tool names. Named tool choice and discovered tool references are preserved.
Deferred custom-tool schemas are sent up front; native deferred tool search is
not emulated. Provider-side tools (such as Anthropic's hosted search/advisor) are
still unsupported; ordinary Claude-executed tools keep their normal permissions.

`/v1/messages/count_tokens` returns a local `o200k_base` estimate, including tool
schemas and heuristic media allowances, with `x-multi-token-count: estimate`.
It does not call a provider and is not an exact context or billing count.
Explicit `output_config.effort` wins. Legacy thinking budgets map approximately to
low (≤1024), medium (≤8192), high (≤24576), or xhigh; disabled thinking maps to
low because the registered models do not offer a no-reasoning level.

Stop strings are enforced locally across streamed text chunks; matching text and
later output are withheld and the upstream request is cancelled. Usage on an early
local stop is unavailable and reported as zero. The subscription endpoint does not
accept a per-request output-token cap. Codex owns token refresh; renew its login
if the gateway reports 401. Credential stores that do not expose `auth.json` are
not supported yet. Direct OpenCode Zen integration and external harness-backed
workers for Antigravity and Grok Build are not implemented; neither is
the llama.cpp route.
The full built-in tool definitions are accepted, but this is not complete feature
parity: unsupported content also prevents switching an existing conversation
that contains it. Auxiliary features with incompatible schemas can still fail.
Claude currently assumes a conservative 200K context window for these custom
model IDs. The compaction contract passed on Luna with Claude Code 2.1.263:
manual and repeated compaction, automatic compaction of roughly 70K tokens,
saved-session resume, continued editing, and return to Claude. Full-window stress
and compaction inside subagents are not covered by that main-session test.
Boris Cherny has explicitly stated that using Claude Code with other models
through a proxy is supported, while noting that harness prompting and tools are
model-specific ([statement](https://x.com/bcherny/status/2086183356795060396)).

Offline checks run with `npm test`. The opt-in integration check
`node test/live/native-model-gateway.ts openai-luna-high` uses both
subscriptions to delegate a real native Read/Edit task in a temporary directory
and asserts the upstream model and reasoning level. Omit the name to test Astra
at medium effort.
`node test/live/native-main-switch.ts` tests Claude → GPT main
→ native delegation → Claude in one conversation with generated fixtures.
`node test/live/native-translation.ts` tests modern and legacy
JSON schemas plus user/tool-result images against Luna, using only synthetic
fixtures and the Codex subscription. It also verifies PDF ingestion and a named
call to a long MCP tool.

`npm run test:live:compaction` runs the compaction contract against Luna, starting
with Claude history. It requires real `compact_boundary` events for two manual
compactions and one automatic compaction, checks conversation-only facts with
tools disabled, verifies a native edit after compaction, and returns to Claude.
Every turn launches a fresh gateway and resumes the same saved session by ID.
Use `npm run test:live:compaction -- openai-sol-high` to select another registered
worker, or append `--manual-only` to skip the larger automatic-trigger fixture.
The automatic case uses synthetic padding and a session-local 50K trigger
(`--autocompact 100k`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50`); it is not a full-context
stress test. No global settings are changed. This opt-in check spends subscription
usage and leaves a dedicated synthetic session in Claude's normal session store.
It prints a temporary artifact directory containing the fixture, per-stage event
logs, and `report.json` with versions, routing, timings, boundary metadata, and
pass/fail status. A successful command response without a boundary fails the test.
Run it when changing a provider's history, reasoning, usage, or compaction handling.
The boundary and trigger contracts follow Claude's
[SDK command documentation](https://code.claude.com/docs/en/agent-sdk/slash-commands#compact-history-with-compact)
and [compaction environment settings](https://code.claude.com/docs/en/env-vars).

Set `MULTI_NATIVE_TRACE=1` to print routing, upstream model/effort, HTTP status, and tool-name diagnostics
without logging prompts, response bodies, or credentials. Upstream HTTP failures
preserve status and `Retry-After`; inference is not automatically replayed by the
gateway. Exit Claude normally
to stop its gateway. Plain `claude` launches independently of this experimental
launcher; use session-only model selection to keep your saved default separate.

## Experimental Cursor SDK bridge

Sign in once through Cursor's official SDK browser flow, then launch normally:

```sh
node plugins/multi/src/native-model-gateway.ts --cursor-login
node plugins/multi/src/native-model-gateway.ts --cursor-models
node plugins/multi/src/native-model-gateway.ts
```

The launcher discovers models and presets available to your Cursor account. Its
compact `/model` lineup shows **Auto, Grok 4.6, and Composer 2.5**, labeled
**via Cursor**, alongside Claude and any signed-in OpenAI choices. Entries
unavailable to your account are omitted.
Auto uses the account catalog's `default` model ID and its advertised parameters.
Named workers cover base models and reasoning-only presets; other catalog models
and parameter combinations remain selectable by their full model IDs. `--cursor-models`
prints exact model IDs and any registered worker names. Ask
Claude to delegate to one of those workers, or select its model for the main
conversation. These settings belong to the launched session; the earlier note
about Claude's persistent `/model` selection still applies.

To add other Cursor models to the picker, set `MULTI_CURSOR_EXTRA_MODELS` when
launching. For example, this adds Gemini and GPT through Cursor:

```sh
MULTI_CURSOR_EXTRA_MODELS=gemini-3.8-flash,gpt-5.6-sol \
  node plugins/multi/src/native-model-gateway.ts
```

Choose comma-separated **`selection.id`** values from `--cursor-models`, rather
than the full `multi/cursor/...` routes. Extras appear after the three defaults;
duplicates are removed and unavailable IDs produce an explicit error. To keep
your additions across launches, export the variable in your shell profile.
Leave it unset for the default three. Restart the gateway after changing it.
This only controls picker visibility; full catalog model IDs remain usable.

The SDK login stores a named, expiring user key in `~/.cursor/sdk/auth.json`.
It is separate from Cursor's app/CLI login and uses Cursor's documented user-plan
billing. The SDK also accepts `CURSOR_API_KEY`; that key's account determines
billing. The SDK owns credential handling; the bridge never extracts private
Cursor session tokens. See [Cursor's SDK documentation](https://cursor.com/docs/sdk/typescript).

Only our custom callback tools are enabled. Cursor's filesystem, shell, subagent,
and other built-in execution tools are disabled, and ambient settings/MCP servers
are excluded. A callback yields a fresh Claude `tool_use` request **before any
action executes**. Claude handles permission, runs the tool, and returns its
result to the waiting callback. Observed Cursor tool activity is never replayed
as an executable action. Tool schemas and long-name aliases are passed dynamically.

`/effort` selects an exact advertised `effort`/`reasoning_effort` value where the
model has one; unsupported values fail explicitly. Catalog presets retain their
own parameters. Models without an effort parameter do not acquire one, and
legacy Claude thinking budgets are not mapped onto Cursor. Cursor's own system
prompt remains active; Claude's session instructions and transcript are supplied
as conversation context because full prompt replacement is account-gated.

The SDK run stays alive across tool-result HTTP exchanges. Completed turns, new
user messages, restart, and compaction begin a fresh SDK agent from Claude's
provided history. We do not resume opaque SDK checkpoints or promise identical
behavior to a raw model API. In-memory retry responses are retained for up to ten
minutes/256 requests. Output is capped at 32 MiB per SDK run, with at most 32
active runs per gateway. Session and worker scopes plus tool IDs isolate results;
modified conversation branches cannot settle another branch's callback.
Disconnects during inference and gateway shutdown cancel the run. A callback
waiting between HTTP requests expires after ten minutes: the Messages protocol
does not notify the gateway immediately when a user abandons a permission prompt.

Initial limitations: strict structured output, forced tool choice, stop strings,
PDF attachments, and per-response generation caps are unsupported. Token counts
and displayed Messages usage are estimates, not Cursor billing figures. Images
are supported as prompt attachments and base64 callback results; remote images
inside a live callback result are rejected. Composer 2.5 passed real callback
execution, cancellation while awaiting a result, main-model and native-worker
Read/Edit, and Cursor → Claude → Cursor with saved history and fresh gateways.
Other Cursor models, automated UI/timer assertions, and Cursor compaction are
not covered by that baseline.

The official SDK currently brings an `undici` 5.x dependency with unresolved
`npm audit` advisories. No incompatible dependency override has been applied.
Recheck upstream SDK releases before treating this prototype as release-ready.

`npm run test:live:cursor -- <model-or-worker>` checks a real SDK callback round
trip, cancellation, Cursor as Claude's main model with native Read/Edit, switching
to Claude and back through saved-session resume, and a Claude parent delegating
to a Cursor worker. It spends Cursor and Claude usage on temporary fixtures and
leaves synthetic transcripts in Claude's and Cursor's normal stores. Without an
argument it chooses an advertised Composer model, failing
if none is available. The ordinary `npm test` suite remains offline.

## Auto-mode integration check

`npm run test:live:auto-mode` runs a Claude control, then Luna high and Cursor
Composer 2.5 as both main models and native workers. It uses real provider logins
and classifier requests. All five cases passed on 2026-09-06 with Claude Code
2.1.263, Node 24.20.0, and Cursor SDK 1.0.31. Each case's Bash checks requested
`claude-sonnet-5` through Anthropic passthrough. Select one case with
`npm run test:live:auto-mode -- openai-luna-high`, or append `--worker` to check
delegation. Cursor worker names come from `--cursor-models`.

Each case attempts two harmless Bash writes in a temporary directory. Session-only
`autoMode` prose rules allow one canary and forbid the other. There are no tool
permission allowlists or approval hooks, and Claude's Bash sandbox is disabled for
the test so sandbox auto-approval cannot substitute for classification. The check
requires active auto mode, provider-attributed tool calls, successful Anthropic
classifier requests and allow/deny decisions for both commands, the expected file
effects, and an actual classifier-denial tool result returned to the calling model.
A model refusing to request the command, a static permission denial, or a classifier
failure does not pass. Missing log evidence also fails: diagnostic wording can change
between Claude Code versions.

The test keeps a temporary artifact directory with a versioned `report.json`, CLI
events, gateway routing, and debug logs. These may include local paths and synthetic
prompts; review before sharing. It changes no global settings. Passing establishes
this bounded permission contract, not classifier accuracy for arbitrary commands,
all models, or all accounts. Claude Code still owns classifier selection and
availability; external CLI execution such as the planned Antigravity bridge does
not enter this tool-permission loop. With Anthropic credentials, the launcher
preserves native classifier selection and passthrough. Without them, OpenAI
classification uses the provider reviewer described below. The client-visible classifier model is recorded separately from
the working model. This does not identify any private server-side specialization.
See Claude's
[permission modes](https://code.claude.com/docs/en/permission-modes) and
[classifier configuration](https://code.claude.com/docs/en/auto-mode-config).

The ordinary launcher now selects automatic review without an extra opt-in flag:

- Claude reports an existing login, API key, or auth token: preserve native
  Anthropic classification. The launcher does not read or copy Claude tokens.
- No Anthropic credentials, and the Codex account catalog exposes
  `codex-auto-review`: use that reviewer for OpenAI main agents and workers.
  Claude's static permissions still run first. No reviewer is called from the
  capability hook, and no second command-risk parser is added.
- No available reviewer, or the session starts with an unsupported provider:
  disable auto mode using Claude's session-local permission settings.

**Adapter availability:** OpenAI has an implemented approval adapter; Cursor's
adapter is unfinished. This describes our integration, not an inherent provider
limitation. Without Anthropic credentials, a tool from a provider lacking an
available adapter is blocked in auto mode with an explicit explanation. The
gateway does not substitute manual approval. Other permission modes retain
Claude's normal behavior.

**Mid-session limitation:** Claude 2.1.263 does not reload the launcher's
`--settings` file or expose a gateway operation to change permission mode.
The guard blocks incompatible auto-mode actions, but the displayed mode can
remain auto. A session started with auto disabled requires relaunch to enable
it. Native availability changes across provider switches remain unfinished.

The OpenAI reviewer receives the native classification transcript, original model
request, root user context for workers, and current tool working directory. It uses Codex's bundled synchronous
Guardian policy and a bounded read-only investigation loop: workspace file reads
and directory listings, no shell execution or network tools. Unavailable evidence,
malformed output, timeouts, and unsupported classifier formats cannot grant
approval. It does not reproduce Codex's entire reviewer harness, account-specific
policy discovery, or Guardian V2. The account catalog is checked at launch; Codex
continues to own login refresh.
Claude's `autoMode` prose customization is not translated into Codex policy;
native permission deny/ask rules still apply before provider review.
Reviews are bounded to 60 seconds, six investigation turns, and 1 MiB of initial
context. Exceeding a limit blocks approval rather than silently discarding evidence.

Provider allow/block verdicts become native auto-mode results. Only a matching
second-stage denial is reused, scoped by session, worker, provider, working
directory, and classification transcript. Allows are never cached. Classification
retries naming the working model still go through the reviewer adapter, so a
reviewer error cannot turn the working model into an alternate classifier.

Run the integration checks with Node 24 and the saved provider logins:

```sh
npm run test:live:provider-approval -- --launcher
npm run test:live:provider-approval -- --switch-provider
npm run test:live:reviewer
npm run test:live:approval-worker
```

The launcher test uses a fresh Claude config with no Anthropic credentials. Eight
native tool calls exercise Read/Edit, `pwd`, explicit allow/deny/ask rules, and
one escalated OpenAI review. The switch check adds a real Cursor call and checks
that missing-adapter auto mode blocks it without a prompt or extra classification. Both use Python 3's standard
library PTY on Linux/macOS. The reviewer-only check validates allow, deny, and
actual file investigation; it never executes the proposed commands. Tests retain
versioned temporary diagnostics and use real provider usage.

The non-auto permission contract runs both OpenAI and Cursor through the ordinary
launcher with a fresh, credential-isolated Claude config:

```bash
npm run test:live:permissions
# Restrict a run to one provider or mode:
npm run test:live:permissions -- --model multi/cursor/composer-2.5 --mode default
# Target native workers (also accepts cursor-composer-2-5):
npm run test:live:approval-worker -- --mode dontAsk --worker openai-luna-high
npm run test:live:approval-worker -- --mode bypassPermissions --worker openai-luna-high
```

It exercises `default`, `acceptEdits`, `plan`, `dontAsk`, and
`bypassPermissions`. Observation-only hooks record tool origin and permission
mode; the terminal driver answers only the fixture's native dialogs. Assertions
check pending actions have not executed before approval, exact-once append
results, denied-file absence, actual tool results, unchanged mode, and zero
classifier/Anthropic traffic. Bypass's initial consent is distinct from tool
approval. No permission rules are supplied in the main-model matrix. The
`dontAsk` worker check allows only parent Agent delegation, leaving the worker's
Bash command subject to native permissions.

Plan mode is a read-only behavior check, not a claim of an unconditional write
security boundary: a model may decline to propose writes, while a submitted
edit can produce a native permission prompt. The test denies any such prompt
and records whether canary writes were attempted. Existing auto-mode switching
and worker checks cover the reviewer-specific paths separately. These checks
cover Claude-executed tools; future external-execution bridges need their own
permission enforcement proof.

`--native-escalation` retains the earlier nine-call classifier-adapter proof:
two provider reviews, including a denial reused for Claude's second stage.
Without flags, the test retains the earlier three-call PreToolUse/manual-prompt
proof. Only those older tests add canary-specific policy; production uses the
bundled provider policy with an accurate execution-environment description.

## Earlier commands and skills (historical)

These belonged to the earlier companion-based implementation and were removed
in the TypeScript branch. The following is historical reference, not commands
available from this checkout. The `customize` and `multi-cli-anything` skills modify that
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

## Retained transport references

The earlier companion used the transports below. Cursor/OpenCode headless and ACP
code is retained for future bridges; it is not connected to the gateway. The
Codex app-server implementation was removed.

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

## Earlier companion limitations (reference for bridge work)

These record earlier CLI quirks and companion limitations; revalidate them when
building each bridge. If you hit something not listed, check the companion's stderr (the forwarders append `2>&1`) — a bad model id, an auth failure, or a sandbox block surfaces there.

- **Cursor runs in headless `agent -p` mode by default** (ACP is opt-in — see [Transports](#transports)). On the headless path the adapter delivers the prompt on stdin, selects the model with `--model` (default `auto`), and parses `json`/`stream-json` output. MCP servers come from Cursor's own `~/.cursor/mcp.json`, which `/multi:setup` maintains (this holds on the ACP path too — the adapter passes no MCP servers in-protocol, so Cursor reads its own config either way).

- **Cursor's shell is slow/unreliable on Windows.** Cursor's terminal tool can stall or wait out a per-command timeout on Windows (host-PATH/WSL, open upstream). So `/cursor:delegate` does **not** run build/test verification itself — it lists the commands in a `## Verification` block and Claude runs them. File writes and web/codebase reads are unaffected.

- **OpenCode has no `--read-only` flag.** For read-only roles (`/opencode:research`, `/opencode:explore`), the adapter enforces read-only by injecting a custom primary agent via `OPENCODE_CONFIG_CONTENT` with write/edit/bash denied, plus an `OPENCODE_PERMISSION` deny floor. A stale bun `opencode.exe` may shadow the npm `.cmd` shim on Windows — the adapter never resolves to `opencode.exe`; set `OPENCODE_CLI_PATH` to force the right binary if needed.

- **OpenCode billing depends on the selected provider and login.** Its current
  adapter default is `opencode/claude-opus-5` through Zen, overridable with
  `OPENCODE_CLI_DEFAULT_MODEL`. An `anthropic/*` prefix alone does not mean the
  request uses the same Claude subscription as Claude Code.

- **OpenCode `--effort` maps to `opencode run --variant`** (provider-specific reasoning effort, validated by OpenCode against the chosen model; headless transport only). `--until-done` is supported.

- **OpenCode MCP servers are not managed by `/multi:setup`.** OpenCode reads MCP configuration from its own `opencode.json`; use OpenCode's interactive wizard to wire Exa/Context7 there.

These notes describe the earlier companion implementation, not guarantees for the planned harness bridges.

## License

Apache 2.0. See [NOTICE](NOTICE) for upstream credits.
