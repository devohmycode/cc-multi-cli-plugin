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

The launcher uses Cursor's official SDK for native tools, persistent state and
review. Claude Code supplies the session interface and outer worker coordination;
external actions appear as attributed text/status, never executable Claude tool
calls. The callback runtime and separate Cursor reviewer have been removed.
See [the execution contract](ARCHITECTURE.md#cursor-native-execution).

## Direction: one session, multiple models and harnesses

We are building a custom Node gateway that brings external models and real coding
CLIs into Claude Code's `/model` picker and named native workers. Visible subagent
rows, elapsed time, live progress, completion, and cancellation are central to
the experience, alongside preserving each provider's supported authentication.

The direct GPT path uses Claude Code's tools and execution loop. Cursor uses
its own SDK tools and persistent execution loop. Claude or GPT parents can spawn
named Cursor workers; Cursor-native children remain disabled. Antigravity and the
other external harness integrations remain planned.

Our targets are OpenAI, Cursor, Antigravity, OpenCode, local models through
llama.cpp, and Grok Build. We will maintain our adapters and reuse existing
process/session infrastructure. There is no planned replacement with a general
gateway engine or a user-facing backend choice. The old commands, skills, and
forwarders were removed in the TypeScript branch; their design is not a requirement
for the new integrations.
[ARCHITECTURE.md](ARCHITECTURE.md) is the authoritative direction, including
current status, execution boundaries, and the first bridge milestone.

## Requirements

Node ≥ 24.12 and Claude Code. Claude login is optional for external models.
Native Cursor settings admission currently supports Linux without WSL.
Enable OpenAI with Codex's ChatGPT
login, or Cursor with the SDK login below, or both. From a checkout, run `npm install` for dependencies. `npm test`
runs type checking and offline tests. Node runs the gateway's TypeScript directly.

## Development checks

Run `npm run check` for Biome formatting/lint checks, Knip unused-code analysis,
strict TypeScript checking, and the offline tests. CI runs the same command.
Use `npm run format` to format and `npm run lint:fix` for safe lint fixes;
`npm run lint` and `npm run check:unused` run the checks separately.

Biome enforces braces, single variable declarations, simple conditionals, and a
cognitive-complexity limit of 15. Explicit `any`, non-null assertions, parameter
reassignment, focused/skipped tests, and unused imports/variables are rejected.
Runtime and tests use the same rules. The generated ACP bundle and lockfile are
excluded from Biome. Knip preserves the deliberately retained Cursor/OpenCode
transport entry points. See AGENTS.md for authoring and suppression rules.

## Source layout

Runtime lives in `plugins/multi/src/`:

```text
native-model-gateway.ts    launcher
gateway/                  HTTP/session handling, Claude Messages, approval, tool aliases
providers/openai/         auth, models, Responses translation, counting, reviewer policy
providers/cursor/         native SDK harness, permissions, progress and model catalog
transports/               retained CLI adapters, process helpers, ACP and its vendor bundle
```

The launcher imports concrete gateway/provider modules. Shared Claude protocol types
live in `gateway/messages.ts`; provider credentials and catalogs stay with their
provider. Cursor currently reuses OpenAI normalization/counting helpers. The retained
CLI transports have offline tests but are not connected to the gateway. Development
utilities live in root `scripts/`, with tests under `test/unit/` and `test/live/`.

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
The request limit is 8 MiB. Direct providers retain a three-minute gateway timeout;
native Cursor runs have no gateway execution deadline. Response streaming
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

## Experimental Cursor SDK harness

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

Base Cursor routes and named workers explicitly disable Fast when the catalog
advertises that parameter. Fast requires an explicit preset; it is never inherited
from the account's default variant. Our live checks use the non-Fast base routes.

Cursor executes native shell/read/edit/search tools. Task and MCP capabilities
are disabled, including ambient MCP servers. An observed external action is only
displayed in Claude Code; it is never replayed as an executable `tool_use`.

Claude's existing permission selector controls Cursor at the next prompt through
UserPromptSubmit/SubagentStart hooks. Worker modes resolve from parent inheritance
and built-in, user/project, supplied CLI or discovered plugin definitions. Unknown
workers fail explicitly. Auto requests native SDK Auto-review; its accepted fallback
when the classifier is unavailable may execute without review. Completion is not
proof of classification. Plan selects SDK plan mode with only read, grep, glob and
listing tools. Bypass selects native agent mode with Auto-review disabled, while
retaining explicit tool restrictions and the SDK's sandbox configuration. Default,
acceptEdits and dontAsk remain unsupported; there is no separate mode selector.

Worker tool lists, whole-tool deny rules and supported CLI restrictions intersect
native capabilities. Settings and plugin policies are rechecked before dispatch.
Linux managed settings and fragments support the same narrow policy translation;
unsupported managed controls, argument/path-specific rules, ask rules, permission
hooks and Claude sandbox policies fail explicitly. Unknown plugin definitions and
Cursor policy files that isolated SDK settings cannot honor also fail. macOS,
Windows and WSL policy admission remain unsupported. No policy is silently dropped.

`/effort` selects an exact advertised effort value where the model supports one;
unsupported values fail explicitly. Catalog presets retain their parameters.
Cursor's own system prompt remains active; session instructions and initial
conversation context are supplied to it.

Completed turns retain the same native SDK agent and disk state. Changed mode/tool
policy resumes that identity with the new configuration. Main sessions and workers
have separate state, guarded by kernel file locks. Worktree workers use their
hook-reported workspace for both native execution and policy checks. Identical completed requests
replay output. An interrupted gateway commit with a saved SDK run ID can recover
its terminal result through `Agent.getRun` without rerunning actions. Missing run
identity or an unreadable/nonterminal result fails explicitly and preserves state.

Outer history compaction can continue from a fresh authenticated prompt whose text
hash matches, or a unique saved-response anchor. This keeps Cursor's own history;
it does not rewind native state or replay rewritten history. Other ambiguous edits
and branches fail explicitly. Historical callback compaction tests are not native
compaction evidence.

Attributed text shows tool lifecycle, bounded sanitized edit diffs and shell output,
exit status and elapsed time. Cancellation reaches the SDK run. Arbitrary native
Claude tool cards and manual approval controls have no verified public extension
surface. Cursor-originated delegation remains deferred. The public SDK reports
natural compaction events but exposes no force-compaction or cheap threshold control.

Strict structured output, forced tool choice (including `none`), stop strings,
PDF attachments and per-response generation caps are unsupported. Images are
forwarded as SDK attachments. Token counting is a local estimate, not exact native
context occupancy or billed usage. Model-specific fidelity remains experimental.

`npm run test:live:cursor` (also `test:live:cursor-harness`) runs the bounded native
SDK tool/continuation/resume smoke check with Fast explicitly disabled. The ordinary
`npm test` suite is offline. `npm run test:live:mode-hooks` checks unmodified Claude
mode hooks against local fake responses without provider inference. Append `-- --plan`
to the Cursor check for one read-only turn. Integrated validation passed a real
Claude-parent Composer 2.5 worker edit, persisted SDK resume, cached retry,
follow-up recall and read-only Plan, all with Fast disabled. Historical callback
tests do not establish native parity. Append `-- --compact --recover` to check
outer-history continuation and terminal SDK-run recovery using the same two turns.
Both checks passed against Composer 2.5. A GPT-5.6 Luna parent also successfully
delegated a native edit to Grok 4.6 at low effort. These checks do not establish
natural Cursor compaction behavior.

Native runs have no gateway execution deadline. The launcher defaults Claude's
`API_TIMEOUT_MS` to its documented maximum `2147483647`, preserving an explicit
inherited value. Direct provider requests still have a 180-second gateway deadline.
Claude's independent stream watchdogs and native tool limits still apply.
See [Claude environment variables](https://code.claude.com/docs/en/env-vars).

The SDK currently brings an `undici` 5.x dependency with unresolved `npm audit`
advisories. No incompatible dependency override has been applied.

## OpenAI approval and permission checks

Claude-executed OpenAI tools retain Claude's ordinary permissions. When Claude
credentials are available, native Anthropic classification passes through. Without
them, the launcher uses the authenticated OpenAI account's `codex-auto-review`
capability where available. Unsupported review actions and unavailable evidence
fail explicitly; the working model never substitutes for a reviewer.

The OpenAI reviewer uses the bundled Guardian policy and a bounded read-only
investigation loop. It receives the classification transcript, originating request,
worker root context and tool working directory. Static deny/ask rules remain with
Claude. Reviews are bounded to 60 seconds, six investigation turns and 1 MiB of
initial context; only matching second-stage denials are reused. This does not
reproduce the entire Codex reviewer harness or translate Claude's Auto prose policy.
Cursor review belongs to its native run regardless of Claude login availability.

These opt-in checks use real logins and retain temporary diagnostics:

```sh
npm run test:live:auto-mode
npm run test:live:provider-approval -- --launcher
npm run test:live:reviewer
npm run test:live:approval-worker
npm run test:live:permissions
```

The Claude/OpenAI checks exercise classifier routing and Claude-executed tool
permissions. Their historical Cursor callback cases are retired and do not prove
native Cursor enforcement. Use the native Cursor check described above for that
execution path. Native Auto availability changes across provider switches and the
full interactive permission UX remain limited by Claude's public interface.

## Historical implementation

The old slash commands, skills, companion and separate Cursor reviewer are removed.
Retained Cursor/OpenCode transports are reference modules, not selectable gateway
backends. Historical investigation lives under `.agent/archive/` and `.agent/`;
its callback compaction results and source-patch experiments are not current runtime
contracts. [The current map](docs/cursor-refactor.md) records native behavior and
remaining limitations.

## License

Apache 2.0. See [NOTICE](NOTICE) for upstream credits.
