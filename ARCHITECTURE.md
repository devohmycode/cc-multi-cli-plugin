# Architecture

Authoritative product direction, updated 2026-09-09. Pair this with [AGENTS.md](AGENTS.md)
for development rules and [README.md](README.md) for usage and limitations.
Historical plans and experiments under `.agent/` are evidence, not active instructions.

## One session, external models and harnesses

Maintain our custom Node gateway and provider-specific adapters. Users select
external models through Claude Code's `/model` picker and delegate to explicitly
named workers. Preserve ordinary Claude tier meanings, subscription passthrough,
and configuration. Worker lifecycle, elapsed time, streamed progress, completion,
failure and cancellation are product requirements. Claude access is optional for
external providers; authentication remains owned by each provider.

There are two execution paths:

1. Direct model adapters use Claude Code's tools, permissions and execution loop.
   The OpenAI adapter translates Messages to Responses using Codex authentication.
   The official Codex app-server renews saved tokens; the gateway retries only one
   HTTP authentication rejection, never an accepted inference stream.
2. Harness integrations use the provider's real CLI or supported SDK execution loop
   and authentication. Cursor's official SDK owns its tools, persistent state and
   review. Claude Code provides the outer session and worker coordination.

```text
Claude Code: model picker, session, named workers
                         |
                  Our Node gateway
               /          |                   \
     direct adapter   Cursor SDK harness   CLI bridges (planned)
           |                |                      |
      Claude tools     Cursor tools           provider tools
```

No CLIProxyAPI, Go gateway, Vercel engine migration or user-facing backend selector
is planned. Never extract Antigravity tokens for direct requests, create a Claude
subscription token pool or use an alternate Cursor authentication route. Resolve
model/effort choices against provider capabilities; do not silently substitute models.

## Current scope

| Provider | Execution route | Status |
| --- | --- | --- |
| OpenAI | Direct Responses adapter with Codex login | Experimental main-model and named-worker integration; Claude executes tools. |
| Cursor | Official SDK | Native tools/state/review, Auto/Plan/Bypass mapping, worktree isolation and saved-run recovery. Live Composer recovery/recall and GPT-parent Grok-worker edits pass. |
| Antigravity | Real `agy` CLI | Opt-in experimental main model and incoming workers; native pre-tool restrictions, persisted continuation and uncertain-run refusal. See [current limits](docs/antigravity.md). |
| OpenCode Zen | Direct Responses / Chat Completions APIs | Experimental main models and native workers; Claude executes tools. OpenCode CLI harness remains planned. |
| llama.cpp | Prefer Anthropic-compatible server endpoint | Planned; model/tool fidelity needs verification. |
| Grok Build | Real CLI headless/ACP | Planned; no adapter. |

The old slash-command companion, skills, forwarders and CLI/ACP transports are
removed, including their process helpers and vendor bundle. Git retains their
history; their shape is not a compatibility requirement for future integrations.
Reuse active gateway/provider helpers when they save concrete work.

## Cursor native execution

The launcher selects `plugins/multi-cursor/src/harness.ts`. Native actions are displayed as
attributed text/status and never replayed as executable Claude `tool_use` calls.
The SDK owns its system prompt, tools and ongoing conversation. Bounded text diff
and shell-output previews are implemented; custom native cards and manual approval
controls remain public-interface limits.

Claude/OpenAI parents can spawn named Cursor workers, each with separate SDK state.
Cursor main-model selection remains supported. Native task and MCP capabilities
are disabled; Cursor-originated delegation, including Cursor children, is deferred
until requested. No Sand, SDK source patches or separate reviewer belongs in this path.

### Permissions and settings

UserPromptSubmit and SubagentStart hooks record Claude's existing permission selector
through the authenticated gateway. Worker definitions and documented parent-mode
precedence resolve the effective mode. Changes apply at the next prompt, including
workers; immediate mid-run synchronization and a separate selector are out of scope.

Auto selects SDK agent mode with native `autoReview: true`. The user accepts the
SDK's documented fallback when its classifier is unavailable: execution may proceed
without classifier review. This does not waive explicit tool restrictions or establish
that a completed call was reviewed. Native review belongs to the originating Cursor
run, irrespective of Claude login. Do not substitute a different provider's reviewer.

Plan selects SDK plan mode and limits available tools to read, grep, glob and directory
listing. Shell/edit, task and MCP are excluded. A mode label alone is insufficient:
the whitelist is reapplied on SDK resume. Worker allow/deny lists intersect native
capabilities conservatively. Bypass selects agent mode with native Auto-review off;
explicit capability restrictions and SDK sandbox configuration still apply. Default,
acceptEdits and dontAsk fail because no equivalent manual decision transport is wired.

Every dispatch rechecks selected user/project/local settings, CLI restrictions,
plugin definitions/policies and Linux managed settings/fragments. Whole-tool
restrictions translate through capability intersection. Unsupported argument/path
rules, ask rules, permission hooks, sandbox policy and managed controls reject
admission. Unknown workers and ignored Cursor policy files also reject. Platform
admission remains Linux without WSL; other platform policy sources are unsupported.

### State and failures

Scope native state by Claude session, worker, provider and workspace. Ordinary
follow-ups reuse SDK state; disk resume restores it. Effective mode/tool policy
changes close and resume the same SDK identity with updated configuration.
Completed identical requests replay saved output rather than repeat actions.

Cancellation reaches the native run. Kernel file locks prevent concurrent ownership
and release on process exit. A durable pending SDK run ID permits terminal-result
recovery through public `Agent.getRun`; missing identity or unavailable terminal
results fail without rerunning uncertain actions. Recovery does not rewind SDK state.

A fresh authenticated prompt with matching text hash, or a unique saved-response
anchor, admits continuation after outer history changes while preserving native
history. Ambiguous edits/branches without either proof reject. This is not native
compaction or arbitrary history reconciliation; callback compaction evidence remains
historical. Public summary events observe natural SDK compaction, but no public
force-compaction or threshold control is exposed.

Progress uses attributed text with bounded sanitized diff/output previews. Arbitrary
Claude-native tool cards and manual approval widgets are not established public
Messages extensions. Native Cursor runs and direct OpenAI requests have no default
gateway execution deadline; Anthropic passthrough retains 180 seconds. The launcher defaults `API_TIMEOUT_MS` to the documented
maximum 2147483647 while preserving explicit inherited values. Independent Claude
stream watchdogs and native tool limits remain. See [environment variables](https://code.claude.com/docs/en/env-vars).

## Antigravity native execution

The official CLI owns subscription authentication, tools and native history.
`MULTI_ANTIGRAVITY=1` enables experimental selections and incoming workers. A stable,
namespaced global native hook reads only the originating process's tool policy;
ordinary CLI sessions skip it. Explicit deny decisions enforce tool restrictions
without granting native permissions. No token extraction or direct requests.

Auto and acceptEdits use native edit acceptance with native command policy and no
reviewer. Plan denies shell/edit; Bypass retains explicit hook restrictions. Unknown
or untranslatable policy fails. Native children and MCP are denied; external events
are never executable Claude tools. State is scoped by session/worker/workspace,
completed responses replay, and uncertain interrupted work is never rerun blindly.
Cache and native-compaction evidence remain distinct from functional continuation.
See [implementation and setup](docs/antigravity.md).

## Direct OpenAI permissions and provider boundaries

OpenAI continues to use Claude-executed tools and native static permissions. With
Claude credentials, preserve Anthropic classification passthrough. Without them,
use the authenticated OpenAI account's supported reviewer capability. Missing
review capability, malformed evidence and unsupported formats cannot grant approval;
the working model never substitutes for the reviewer. Native ask rules retain
Claude's permission prompt. This is separate from Cursor's native review policy.

Provider review contexts remain isolated by session, worker and originating provider.
Only matching second-stage denials may be reused. Preserve provider reasoning state
with its owner when switching models; visible conversation context may be sent to
the newly selected provider. Never infer billing from a model name alone.

Future harnesses must preserve their own execution permissions, isolate state,
propagate cancellation and expose failures. Displaying an external action in Claude
Code does not transfer enforcement to Claude.

## Direct Zen execution

Zen uses API-key authentication and Claude's execution loop. The initial bounded
catalog covers GPT Responses and selected Chat Completions models; the OpenCode
CLI harness and other Zen protocols remain separate future work. Reuse the
existing Responses translator and tool aliases; no general gateway engine is added.

Cache affinity is stable across restarts by Claude session, worker, model and
workspace. Preserve deterministic prompt prefixes and report upstream cache-read,
cache-write and fresh-input usage separately. Compaction can invalidate a prefix;
cache availability and retention belong to the upstream provider. No automatic
inference replay is added after accepted streams. Zen/model-owned reasoning is
kept separate from Codex reasoning, including for identical GPT model names.

Zen has no independent model-based reviewer. OpenCode's CLI auto-approval is an
unconditional approval of non-denied requests, not a reviewer to port. Preserve
Claude-backed classification where available; otherwise gate Auto and allow the
user's explicit ordinary or bypass permission mode. Never borrow Codex review or
silently convert Auto into bypass. Chat models without adjustable effort use their
native reasoning defaults; the picker states that inherited Claude effort is not
applied and workers do not advertise effort variants.

## Runtime map and verification

Paths are relative to `plugins/multi-core/src/`:

- `launcher.ts`: session launcher, login/catalog discovery and workers.
- `gateway/server.ts`: routing, identity and request lifecycle; `messages.ts` owns
  the shared protocol. `mode-hook.ts`, `agent-definitions.ts` and `cursor-settings.ts`
  own prompt permissions and settings admission.
- `../../multi-openai/src/`: auth, catalog, Responses translation, token estimates and reviewer.
- `../../multi-cursor/src/`: native harness, permissions, request validation, progress and catalog.
  Existing reuse of OpenAI normalization/counting remains explicit.

Run `npm run check` before completion, then bounded live checks appropriate to the
changed integration. Cursor probes explicitly disable Fast. Do not promote old
callback evidence into native validation claims. [The current map](docs/cursor-refactor.md)
tracks supported behavior and deferred limitations; no next-provider order is agreed.

Upstream interfaces: [Cursor SDK](https://cursor.com/docs/sdk/typescript),
[Antigravity headless](https://www.antigravity.google/docs/cli/headless/),
[Grok Build](https://docs.x.ai/build/cli/headless-scripting),
[Zen endpoints](https://opencode.ai/docs/zen/#endpoints),
[llama.cpp server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md).
