# Architecture

See [AGENTS.md](AGENTS.md) for contributor rules and [README.md](README.md) for
usage. Provider setup and limits are documented in [docs/installation.md](docs/installation.md),
[docs/openai.md](docs/openai.md), [docs/cursor.md](docs/cursor.md),
[docs/zen.md](docs/zen.md), [docs/antigravity.md](docs/antigravity.md),
[docs/permissions.md](docs/permissions.md), and [docs/platform-support.md](docs/platform-support.md).

## Overview

The plugin puts external models and coding harnesses inside one Claude Code
session. The launcher registers provider models and named workers. The Node
gateway routes requests, preserves Claude passthrough, and coordinates sessions.
Claude Mods provide the in-engine control plane for model rows, worker rows,
permission state, progress, and compaction. Provider adapters own their model
catalogs, authentication, execution, and review boundaries.

```text
Claude Code session (/model, workers, prompts)
                  |
        Claude Mods control plane
                  |
             Node gateway
        /          |           \
   OpenAI       Zen       Cursor / Antigravity
 direct API   direct API   SDK or real CLI
 Claude loop  Claude loop  provider loop
```

## Request flow

Claude Code sends Anthropic Messages traffic and provider requests to the gateway.
The gateway passes Anthropic traffic through and translates direct-provider
requests. `/model` exposes provider model and effort rows. Named workers expose
explicit provider choices. Each run reports a visible lifecycle: row, elapsed
time, streamed progress, completion, failure, and cancellation.

## Execution contracts per provider

| Provider | Tool execution | Review | State ownership | Authentication |
| --- | --- | --- | --- | --- |
| OpenAI | Claude Code tools and loop | OpenAI account reviewer | Gateway and provider reasoning state | Codex login |
| Zen | Claude Code tools and loop | Claude-backed review where available | Gateway and Zen reasoning/cache state | Zen API key |
| Cursor | Cursor SDK loop | Cursor native review | Cursor SDK, scoped by run | Cursor SDK login |
| Antigravity | `agy` CLI loop | No reviewer | Antigravity native history and cache | `agy` login |

OpenAI and Zen are direct model integrations. Their worker hooks record prompt
identity and let Claude Code run the tool loop. Full settings translation runs
at Cursor and Antigravity prompts, or when a direct-model conversation requests
a harness worker. OpenAI
review stays with the originating OpenAI account. Zen never borrows Codex
review. Missing GPT review fails explicitly.

Cursor and Antigravity are harness integrations. Their SDK or CLI executes tools,
keeps native state, and applies provider authentication. Claude displays external
actions and progress; it never replays those actions as executable Claude tool
calls. Cursor supports Auto, Plan, and Bypass. Antigravity uses its native CLI
with Claude policy enforcement at the prompt boundary.

## Permissions

Claude's permission mode controls each provider at prompt boundaries through the
UserPromptSubmit and SubagentStart hooks. The gateway intersects worker rules,
provider capabilities, project settings, and platform policy. Unsupported modes,
unknown workers, untranslatable policies, and unavailable required reviewers fail
explicitly. Plan denies shell and edit capabilities. Bypass disables Cursor native
Auto review while retaining explicit restrictions. See [docs/permissions.md](docs/permissions.md).

Native harness actions do not enter Claude's PreToolUse or PermissionRequest
admission path. Their worker admission loads the selected settings and managed
policy sources, while those hooks observe native activity. Antigravity native
children and MCP stay denied. Explicit native workspace selection is required.

Claude's launcher enables on-demand tool discovery for the local gateway. Direct
provider adapters omit deferred tool schemas until Claude discovers or uses
them; tool references and loaded declarations survive later turns and provider
switches.

## Isolation

Every run isolates Claude session, worker, provider, and workspace identity.
Provider credentials and review contexts remain separate. Claude subscription
passthrough remains available; the plugin has no Claude token pool. External
operations retain external permissions.

## State

`state-lock.ts` serializes native state with a portable marker-file lock that survives crashes. Durable
run IDs support terminal-result recovery. A recoverable run resumes its native
record; an uncertain run does not rerun actions blindly. Claude, OpenAI, and Zen
conversations use Claude Code's compaction without Multi's harness checks;
Cursor and Antigravity compaction remains provider-owned and policy-bound. Follow-ups forward the
newest turn after the last assistant response. Outer history changes continue
only with a matching prompt hash or unique saved-response anchor. Native state is
never rewound. Compaction summarizes authenticated context while preserving the
native record. Cache reuse and usage accounting remain provider-owned.

## Platform layer

The process tree tracks and cancels child processes. Executable resolution selects
platform-appropriate commands. Managed-policy sources are admitted per platform.
Atomic writes protect settings and state. Install shims bootstrap the real Claude
executable and preserve its arguments. Linux, WSL, macOS, and Windows support is
described in [docs/platform-support.md](docs/platform-support.md).

## Design rules

- Keep authentication, model catalogs, review, and native state with each provider.
- Keep shared Claude protocol types and cross-provider helpers in `gateway/`.
- Never replay observed external tool events as Claude tool calls.
- Apply Claude permission mode and explicit capability restrictions at prompt boundaries.
- Propagate cancellation and expose progress, completion, and failure.
- Fail on ambiguous ownership, unsupported policy, unknown workers, or missing review.
- Never borrow another provider's reviewer or infer billing from a model name.
- Never rewind native state or repeat uncertain actions.
- Isolate every session, worker, provider, workspace, and credential context.
