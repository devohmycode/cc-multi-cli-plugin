# Architecture

This is the authoritative product and architecture direction, agreed 2026-09-05.
Pair it with [AGENTS.md](AGENTS.md) for development rules. Historical research and rejected proposals are
archived locally under `.agent/archive/`; they are not implementation instructions.

## Direction: external models and harnesses inside one Claude Code session

Keep building our own Node gateway and provider-specific adapters. The goal is
one Claude Code session in which users select external models through `/model`
and delegate to explicitly named workers. Native subagent visibility, elapsed
time, live progress, completion, and cancellation are core requirements. Reduce
Claude token use by sending the work to the selected external model or harness.
Enable Anthropic-independent use of external providers, including automatic
approval wherever the selected provider supports it. Claude access remains optional.

There are two execution paths behind that experience:

1. **Direct model integration:** Claude Code owns the prompt/tool loop and tool
   permissions; our gateway translates model requests and responses. The existing
   OpenAI prototype demonstrates this path for both the main agent and subagents.
2. **External harness integration:** the real provider CLI or supported agent SDK
   owns execution and native authentication. Our bridge translates its public
   progress stream and final result for display inside Claude Code. This path
   remains the fallback for integrations that execute tools externally. Cursor's
   SDK bridge is a more direct variant: its inference loop requests our custom
   callbacks, which wait while Claude executes the corresponding native tools.
   That variant passed the authenticated Composer 2.5 callback, main-model and
   worker Read/Edit, cancellation, and saved-history switching contract.

```text
Claude Code: /model, named workers, native subagent lifecycle
                         |
                  Our Node gateway
               /          |                   \
     direct adapter   SDK callback bridge   CLI bridge (planned)
           |                |                      |
    provider/server    official Cursor SDK      real CLI
      Claude tools        Claude tools         CLI tools
```

The backend mechanism is chosen by the integration. Users should not need to
choose a gateway engine or start a second interface. Preserve Claude's ordinary
opus/sonnet/haiku meanings and existing configuration; expose external model and
effort choices explicitly. Labels should identify the actual execution route,
for example "Gemini via Antigravity". Resolve supported model/effort values from
each provider's current capabilities; do not silently substitute another model.

### Scope and current status

| Target | Intended route | Current state in this checkout |
| --- | --- | --- |
| OpenAI | Direct model adapter using the saved Codex login | Main-model switching and native GPT workers work as an experimental gateway; compatibility gaps remain. |
| Cursor | Official SDK with asynchronous callbacks into Claude's tool loop | Experimental: Composer 2.5 passed live callback, main-model and worker Read/Edit, cancellation, and Cursor → Claude → Cursor with saved history. Composer main-session manual/repeated/automatic compaction and disk resume also pass; other-model fidelity and subagent compaction remain unverified. |
| Antigravity | Real `agy` CLI with its native login and documented streaming | Future harness bridge; the old transcript-recovery adapter was removed. |
| OpenCode | Real CLI delegation; direct Zen endpoints where appropriate | Headless/ACP transport references are retained; direct Zen gateway integration is not implemented. |
| Local models via llama.cpp | Prefer its Anthropic-compatible Messages endpoint | Planned; validate model/tool/template compatibility before adding translation. |
| Grok Build | Real CLI headless mode or ACP | Planned; no adapter or live verification in this checkout. |

The TypeScript branch removed the old slash commands, skills, and Sonnet
forwarders. This records the branch state, not a new requirement for future work. Their current contracts are not compatibility requirements
for the new architecture. Reuse useful runtime components; do not invest in
preserving the old interface unless a task specifically calls for it.

### Execution and subscription boundaries

- When Anthropic credentials are available, preserve Claude Code's native automatic
  classification, including for external working models. When they are absent, map
  the selected provider's supported automatic approval into Claude Code's native
  auto-mode experience. Disable auto mode when neither approval route is available,
  including after provider switches; sandboxing alone does not establish that
  support. Do not silently fall back to unauthenticated Anthropic classification or
  unrestricted execution. The OpenAI adapter, experimental Cursor Bash reviewer, and capability guard are implemented; exact native mode
  switching remains limited by the unmodified CLI interface.
- Provider auto-review is exclusively the no-Claude-access edge case. It requires
  authentication with the originating agent's provider and reviews only that
  provider's tool requests: OpenAI for OpenAI, Cursor for Cursor via its SDK.
  This applies to main agents and subagents; resolve the provider from the agent
  issuing the pending tool call, not the parent model. Subagents inherit the
  parent's auto permission mode, but not a different provider's reviewer.
  Provider connection alone does not activate review, and a provider reviewer
  must never substitute for another provider's missing review capability.
- Preserve native auto-mode semantics: provider-approved actions proceed and
  provider-denied actions are blocked. Explicit ask rules and other native manual
  approval requirements retain Claude Code's ordinary permission prompt. Reproduce
  the provider's automatic review behavior, not Anthropic's classifier policy.
  Let Claude resolve static permissions before invoking the reviewer; do not add
  a second command-safety parser or review every tool from PreToolUse.
- The launcher preserves native Anthropic classification when Claude reports an
  existing credential. Otherwise it discovers OpenAI's subscription reviewer and
  the supported Cursor SDK review adapter, selecting per originating provider. Native permission filtering owns
  escalation. The reviewer uses the provider policy, current request/transcript,
  current tool cwd, and bounded read-only filesystem investigation.
- Cursor review is verdict-only, using the same classifier-response adapter as
  OpenAI. An isolated SDK process submits the exact pending Bash action to native
  Auto-review without executing it. Source-pinned hooks correlate native allowance
  and rejection; model prose is not a verdict. SDK drift and unsupported actions
  fail closed. This is separate from the ordinary inference callback bridge and
  does not redesign Claude Code's tool execution or introduce Sand/MCP review.
- Review contexts are scoped to session and worker. Two-stage classification
  reuses only a matching denial; working-model classifier retries cannot bypass
  review. Unknown capability, errors, or missing context cannot grant approval.
- Claude 2.1.263 cannot reload launcher flag settings or change permission mode
  through a gateway API. Unsupported startup routes disable auto mode for the
  session. Mid-session providers and workers lacking an available approval adapter
  are blocked in auto mode with an explicit capability error, never a manual
  fallback; the displayed mode may remain auto. Native availability changes across
  switches remain unfinished. Adapter support means an implemented and validated
  integration: OpenAI has one; Cursor's is unfinished.
- Keep the user's Claude login in unmodified Claude Code. Preserve its
  subscription passthrough and isolate other providers' credentials. Do not add
  a third-party Claude subscription login or token pool.
- For CLI-backed integrations, let the real CLI own login and credential refresh.
  Direct Antigravity OAuth/token extraction is excluded. Supported direct API
  routes remain appropriate where their authentication and billing allow them.
- External tool events report work performed by the external harness. Never
  replay them as actionable Claude `tool_use` blocks: that could execute an edit
  or command twice. Start with attributed text progress; native tool-row rendering
  and interactive approval bridging require separate proof.
- A supported SDK's **unexecuted callback request** can instead become Claude
  `tool_use`: return Claude's result to the waiting callback. Disable independent
  execution tools and ambient MCP/settings on that route. This is the Cursor
  implementation; it does not turn observed external actions into new tool calls.
- Claude Code permissions govern Claude-executed tools. External operations must
  use the external harness's permissions; displaying them in Claude does not
  transfer enforcement. Do not silently widen permissions to make a bridge work.
- Scope external session state by Claude session, worker, provider, and workspace.
  Handle resume, retries, branching, compaction, and switching explicitly; never
  blindly replay a completed external task after a request retry.
- Cancellation must reach the external run/process tree. A crash, timeout, or
  missing terminal result must be visible as failure, with partial output retained
  where possible. Model selection alone is not evidence that a task ran.
- A model switch may send conversation context to the selected provider. Preserve
  useful history while keeping opaque provider reasoning state with its owner.

### Next work

OpenAI compatibility work and the Cursor Composer 2.5 live baseline are in place.
Preserve those regression checks as new providers are added. Composer main-session
compaction is verified; subagent compaction and visual lifecycle fidelity still
need live verification. Antigravity and direct
OpenCode Zen integration remain unimplemented; no next-provider order is agreed.

### First harness-bridge proof

Build one Cursor-backed route using the official SDK and pending custom-tool callbacks. Exercise
it both as a `/model` choice and as a native worker, without a Sonnet forwarder.
Verify streamed output, a visible running worker and elapsed time, completion,
cancellation, explicit failures, and isolation between workers. Check that a
Claude-executed edit occurs once and permission denials reach Cursor. Then verify
conversation continuation and switching back to Claude. Composer 2.5 now passes
the live callback, Read/Edit, cancellation, and switching baseline. Permission
denial/isolation/retry behavior has offline coverage. Main-session manual, repeated,
and automatic compaction passes with saved-session recall and native edits; UI
timing and subagent compaction need additional live checks before claiming full fidelity.

The Cursor bridge keeps pending callbacks and retry responses in memory. After
completion or restart it reconstructs an SDK agent from Claude's authoritative
transcript, including completed tool results. It does not restore SDK checkpoints.
The SDK persists its own local agent data. Abandoned callback waits are bounded;
there is no immediate cancellation signal between Messages requests. See README
for exact limits and the current validation status.

Reuse our existing process, job, session, and ACP helpers where they fit. Keep
hardening the direct OpenAI adapter against its documented limitations. There is
no planned CLIProxyAPI import, Go gateway migration, Vercel engine replacement,
optional backend selector, or blanket ACP migration. A small dependency may be
adopted later when a concrete integration demonstrates that it removes work.

Upstream integration references: [Antigravity headless mode](https://www.antigravity.google/docs/cli/headless/),
[Cursor agent SDK](https://cursor.com/docs/sdk/typescript),
[Grok Build headless/ACP](https://docs.x.ai/build/cli/headless-scripting),
[Zen endpoints](https://opencode.ai/docs/zen/#endpoints), and
[llama.cpp server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md).
These document integration surfaces; they do not establish our bridge's parity
or blanket approval for every subscription use case.

## Existing native model gateway

`plugins/multi/src/native-model-gateway.ts` launches Claude with session-local
model-picker settings, named external workers, and a localhost gateway.
`gateway/server.ts` separates Claude passthrough from registered GPT/Cursor routes.
`gateway/messages.ts` defines the shared Claude Messages contract; approval protocol
and capability handling live alongside it in `gateway/`.
`providers/openai/responses.ts` handles Messages/Responses translation and opaque
reasoning state; authentication, model registration, counting, and the reviewer
are adjacent OpenAI modules. `providers/cursor/bridge.ts` owns callback exchanges;
`providers/cursor/models.ts` builds model/worker choices from the account catalog.
The Cursor bridge still reuses OpenAI normalization/counting helpers. That existing
coupling remains explicit; the shared Messages types no longer live in the OpenAI
translator. See the [README](README.md#experimental-native-openai-models) for usage,
tested behavior, and limitations. The retained headless/ACP adapters live under
`transports/` as references, not an optional Cursor backend. All paths in this
paragraph are relative to `plugins/multi/src/`.

## Earlier companion implementation — historical reference

The TypeScript branch deleted the companion, commands, brokers, and job store.
The following records the earlier design, not current runnable paths or a contract
for the replacement. Cursor/OpenCode transports, ACP, and process helpers survive
as references with tests.

- `multi-cli-companion.mjs` dispatches to `lib/commands/`. Its current subcommands
  include task, review, adversarial review, status, result, cancel, and setup.
- `lib/adapters/registry.mjs` selects Codex, Cursor, or OpenCode. The
  former companion contract described
  that boundary; it does not define a gateway harness-bridge interface.
- Codex uses its app-server through a persistent broker. Cursor and OpenCode
  default to headless CLI processes and have opt-in ACP adapters using the
  maintained `lib/acp/` client and bundled official SDK.
- `lib/process.mjs`, `lib/tracked-jobs.mjs`, `lib/state.mjs`, and the broker/session
  helpers are candidates for reuse. Existing job state resolves to a workspace
  root, not an isolated namespace for every Claude worker. Bridges need the finer
  isolation described above.
- Background jobs retain results and diagnostics for status/result/cancel calls.
  Detached companion jobs do not by themselves provide native subagent UI.
- Codex brokers are reused per workspace. SessionEnd cleanup covers the primary
  workspace; an idle shutdown window covers other brokers. The default is
  600000 ms (`CODEX_COMPANION_BROKER_IDLE_MS`; `0` disables idle shutdown).

Provider selection and credentials determine billing; an OpenCode model prefix
alone does not establish which subscription or API account pays. Consult the
actual adapter and selected provider when moving behavior into the gateway.
