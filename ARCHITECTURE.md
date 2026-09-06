# Architecture

The authoritative product and architecture direction. Pair it with
[AGENTS.md](AGENTS.md) for development rules and [README.md](README.md) for what
works today. Historical research and rejected proposals are archived locally
under `.agent/`; they are not implementation instructions.

## Direction: external models and harnesses inside one Claude Code session

Keep building our own Node gateway and provider-specific adapters. The goal is
one Claude Code session in which users select external models through `/model`
and delegate to explicitly named workers. Native subagent visibility, elapsed
time, live progress, completion, and cancellation are core requirements. Reduce
Claude token use by sending the work to the selected external model or harness.

There are two execution paths behind that experience:

1. **Direct model integration:** Claude Code owns the prompt/tool loop and tool
   permissions; our gateway translates model requests and responses. The OpenAI
   gateway implements this path for both the main agent and subagents.
2. **External harness integration:** the real provider CLI or supported agent SDK
   owns execution and native authentication. Our bridge translates its public
   progress stream and final result for display inside Claude Code. This path
   is planned; it has not been demonstrated end to end.

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
for example "Grok via Cursor". Resolve supported model/effort values from each
provider's current capabilities; do not silently substitute another model.

### Scope and current status

| Target | Intended route | Current state in this checkout |
| --- | --- | --- |
| OpenAI | Direct model adapter over the saved Codex login | Main-model switching and native GPT workers work; compatibility gaps remain (see README). |
| Cursor | Real CLI; investigate supported SDK controls for a harness bridge | **First planned bridge.** Headless/ACP transport code is retained as a reference; no bridge is implemented. |
| OpenCode | Real CLI delegation; direct Zen endpoints where appropriate | Second planned bridge. Transport code retained as a reference. |
| Antigravity | Real `agy` CLI with its native login and documented streaming | Later target; no adapter in this checkout. |
| Local models via llama.cpp | Prefer its Anthropic-compatible Messages endpoint | Planned; validate model/tool/template compatibility before adding translation. |
| Grok Build | Real CLI headless mode or ACP | Planned; no adapter or live verification in this checkout. |

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

Build one Cursor-backed route using the real CLI's public stream. Exercise it
both as a `/model` choice and as a native worker. Verify streamed output, a
visible running worker and elapsed time, completion, cancellation, explicit
failures, and isolation between workers. Check that an external edit executes
once. Then verify conversation continuation and switching back to Claude. Until
this passes, these are acceptance criteria, not shipped capabilities. Native tool
cards and approval UI are later fidelity work. OpenCode follows Cursor.

There is no planned CLIProxyAPI import, Go gateway migration, Vercel engine
replacement, optional backend selector, or blanket ACP migration. A small
dependency may be adopted later when a concrete integration demonstrates that it
removes work.

Upstream integration references: [Cursor agent SDK](https://cursor.com/docs/sdk/typescript),
[Antigravity headless mode](https://www.antigravity.google/docs/cli/headless/),
[Grok Build headless/ACP](https://docs.x.ai/build/cli/headless-scripting),
[Zen endpoints](https://opencode.ai/docs/zen/#endpoints), and
[llama.cpp server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md).
These document integration surfaces; they do not establish our bridge's parity
or blanket approval for every subscription use case.

## The native model gateway

Three TypeScript files, run directly by Node's type stripping. No build step, no
loader, no runtime dependency.

```text
native-model-gateway.ts   reads CODEX_HOME/auth.json, mints a per-session token,
      |                   binds 127.0.0.1:0, spawns `claude` with
      |                   ANTHROPIC_BASE_URL pointed at itself, a model-picker
      |                   settings blob, and --agents worker definitions
      v
lib/native-gateway.ts     one HTTP handler:
      |                     - token check on every request
      |                     - model not in the allowlist -> proxy to
      |                       api.anthropic.com with the caller's own headers
      |                     - registered `multi/openai/<model>` -> translate and
      |                       POST chatgpt.com/backend-api/codex/responses with
      |                       the Codex access token
      |                     - 8 MiB body cap, 180 s timeout, client abort
      |                       propagated upstream
      v
lib/native-responses.ts   Messages <-> Responses translation: content blocks,
                          tool calls and results, images, JSON-schema output,
                          SSE deltas, stop reasons, usage, and encrypted
                          reasoning state kept with its owning provider.
```

Claude credentials never reach OpenAI and the Codex token never reaches
Anthropic: routing is decided per request from the model ID, and each branch
attaches only its own provider's authorization. `MULTI_NATIVE_TRACE=1` emits
routing, upstream model/effort, HTTP status, and tool-name diagnostics on stderr
without prompt bodies or credentials. The gateway is session-local: it exits with
the launched Claude process and changes no global configuration.

Registered models are `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`, and
`gpt-5.6-luna`. Each is exposed as a `/model` entry and as workers
`openai-native`, `openai-sol`, `openai-terra`, `openai-luna`, with `-low`,
`-medium`, `-high`, `-xhigh`, `-max` variants mapping to OpenAI's
`reasoning.effort`. Unregistered model strings are not routed to OpenAI.

## Retained transport references

`lib/adapters/cursor.mjs`, `lib/adapters/opencode.mjs`, `lib/acp/`, and
`lib/process.mjs` are the surviving pieces of the deleted companion
architecture. Nothing imports them at runtime; they are kept, with their unit
tests, as source material for the Cursor bridge and then OpenCode:

- binary discovery, headless argument construction, stdin prompt delivery,
  streamed-event parsing, result normalization, and session IDs;
- the ACP client on the official SDK: handshake, live model/mode selection,
  progress, inactivity and overall watchdogs, `session/cancel`;
- OpenCode's read-only permission enforcement and variant forwarding;
- spawn/environment/Windows handling and process-tree termination.

What must not be carried over unexamined: the old role names, report layout, and
adapter contract; cancellation that assumes a companion kills a job process;
unbounded event buffering; role-based permission escalation. POSIX termination
tries the process group and then the direct PID — the PID fallback alone does not
prove every grandchild dies, so validate real child-tree cleanup in the bridge.
