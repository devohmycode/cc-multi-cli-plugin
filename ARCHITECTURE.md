# Architecture

This is the authoritative product and architecture direction, agreed 2026-09-05.
Pair it with [AGENTS.md](AGENTS.md) for development rules and
[the companion adapter contract](plugins/multi/scripts/lib/adapters/CONTRACT.md)
for the existing CLI interface. Historical research and rejected proposals are
archived locally under `.agent/archive/`; they are not implementation instructions.

## Direction: external models and harnesses inside one Claude Code session

Keep building our own Node gateway and provider-specific adapters. The goal is
one Claude Code session in which users select external models through `/model`
and delegate to explicitly named workers. Native subagent visibility, elapsed
time, live progress, completion, and cancellation are core requirements. Reduce
Claude token use by sending the work to the selected external model or harness.

There are two execution paths behind that experience:

1. **Direct model integration:** Claude Code owns the prompt/tool loop and tool
   permissions; our gateway translates model requests and responses. The existing
   OpenAI prototype demonstrates this path for both the main agent and subagents.
2. **External harness integration:** the real provider CLI or supported agent SDK
   owns execution and native authentication. Our bridge translates its public
   progress stream and final result for display inside Claude Code. This path
   is planned; it has not yet been demonstrated end to end in our gateway.

```text
Claude Code: /model, named workers, native subagent lifecycle
                         |
                  Our Node gateway
                   /             \
      direct model adapter     external harness bridge (planned)
              |                         |
      provider/local server    real provider CLI or agent SDK
      Claude executes tools    external harness executes tools
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
| OpenAI | Direct model adapter and existing Codex CLI delegation | Main-model switching and native GPT workers work as an experimental gateway; compatibility gaps remain. |
| Cursor | Real CLI; investigate supported SDK controls for a harness bridge | Companion headless/ACP adapters exist; gateway harness bridge is not implemented. |
| Antigravity | Real `agy` CLI with its native login and documented streaming | Future harness bridge; the old transcript-recovery adapter was removed. |
| OpenCode | Real CLI delegation; direct Zen endpoints where appropriate | Companion headless/ACP adapters exist; direct Zen gateway integration is not implemented. |
| Local models via llama.cpp | Prefer its Anthropic-compatible Messages endpoint | Planned; validate model/tool/template compatibility before adding translation. |
| Grok Build | Real CLI headless mode or ACP | Planned; no adapter or live verification in this checkout. |

The upcoming refactor may replace or delete the existing slash commands, skills,
and Sonnet forwarders. Their current contracts are not compatibility requirements
for the new architecture. Reuse useful runtime components; do not invest in
preserving the old interface unless a task specifically calls for it.

### Execution and subscription boundaries

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

### Next implementation proof

Build one Antigravity-backed route using the real CLI's public stream. Exercise
it both as a `/model` choice and as a native worker, without a Sonnet forwarder.
Verify streamed output, a visible running worker and elapsed time, completion,
cancellation, explicit failures, and isolation between workers. Check that an
external edit executes once. Then verify conversation continuation and switching
back to Claude. Until this passes, these are acceptance criteria, not shipped
capabilities. Native tool cards and approval UI are later fidelity work.

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

`plugins/multi/scripts/native-model-gateway.ts` launches Claude with session-local
model-picker settings, named OpenAI workers, and a localhost gateway.
`lib/native-gateway.ts` separates Claude passthrough from registered GPT routes;
`lib/native-responses.ts` handles Messages/Responses translation and opaque
reasoning state. See the [README](README.md#experimental-native-openai-models)
for usage, tested behavior, and limitations. This code is the starting point for
the harness bridge, not an implementation of that bridge already.

## Existing companion implementation — reference for the refactor

This describes code that exists today, not the required shape of the replacement.
The command and skill prompts have not been refreshed for the new architecture.

- `multi-cli-companion.mjs` dispatches to `lib/commands/`. Its current subcommands
  include task, review, adversarial review, status, result, cancel, and setup.
- `lib/adapters/registry.mjs` selects Codex, Cursor, or OpenCode. The
  [companion contract](plugins/multi/scripts/lib/adapters/CONTRACT.md) describes
  that existing boundary; it does not define a gateway harness-bridge interface.
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
