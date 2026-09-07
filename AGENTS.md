# AGENTS.md

Shared orientation for agents working in this repository. Read this first.

## Product direction

`cc-multi-cli-plugin` is moving from slash-command delegation to **external models
and coding harnesses inside one Claude Code session**. Reduce Claude token use by
letting the selected external model or harness do the work.

[ARCHITECTURE.md](ARCHITECTURE.md) is the authoritative direction.
[README.md](README.md) describes the current prototype and its limitations.
For session continuity in this checkout, read `.agent/HANDOFF.md` if present;
it records pending work and validation, while this file and the architecture
define the product direction.

- Maintain our custom Node gateway and provider-specific adapters. No CLIProxyAPI,
  Go gateway, Vercel engine migration, or user-facing backend selector is planned.
- Expose explicit model and effort choices through `/model` and named native
  workers while preserving Claude's ordinary tier meanings and configuration.
- Visible worker lifecycle, elapsed time, streamed progress, completion, failure,
  and cancellation are product requirements.
- Direct model integrations use Claude Code's tools and execution loop. Harness
  bridges use the real external CLI's execution loop and native authentication.
  Never replay observed external tool events as executable Claude tool calls.
- Cursor uses the official SDK with only our custom MCP callbacks enabled.
  These forward **unexecuted** tool requests to Claude and await results; Claude
  permissions apply. Do not enable Cursor's independent tools or ambient settings.
- Preserve Claude subscription passthrough and isolate provider credentials.
  Do not add our own Claude subscription login/token pool or extract Antigravity
  tokens for direct model requests. External operations retain external permissions.
- Targets: OpenAI, Cursor, Antigravity through its real CLI, OpenCode, llama.cpp,
  and Grok Build. The direct GPT gateway and Cursor SDK bridge are experimental;
  Cursor's Composer 2.5 live baseline passes. Other models and Cursor compaction
  are unverified; other provider bridges are planned.

## Refactor scope

The TypeScript branch removed the old command, skill, and Sonnet-forwarder
surface. Those removals do not decide the design of future integrations. The old
structure is **not a compatibility requirement for the refactor**. Do not expand
or repair it merely to preserve
the old design; work on it only when the task calls for that work.

While a forwarder remains in use, keep it thin: frame the delegation, run the
companion, return its output or an explicit failure. Do not turn it into another
coding agent. Future native workers need not use a Claude forwarder at all.

Reuse retained process and ACP helpers where they fit, and consult earlier
session/job code only when it saves concrete work. Do not build
speculative abstractions or preserve obsolete modules just because they exist.
Research and old plans under `.agent/archive/` are historical evidence, not active
instructions. Keep new scratch research in gitignored `.agent/`.

## Current code map

- `plugins/multi/src/native-model-gateway.ts`: experimental gateway launcher,
  model-picker settings, and native OpenAI/Cursor worker registration.
- `plugins/multi/src/lib/native-gateway.ts` and `native-responses.ts`:
  provider routing and Messages/Responses translation. `native-tools.ts` handles
  stable tool aliases; `native-tokens.ts` provides local count estimates.
- `native-cursor.ts`: SDK callback lifecycle, retry cache, streaming, and isolation.
  `native-cursor-models.ts`: account catalog selections and native worker names.
- `plugins/multi/src/lib/adapters/`: retained Cursor/OpenCode transport
  references, with their tests; they are not wired into the gateway yet.
- `plugins/multi/src/lib/acp/` and `lib/process.mjs`: retained transport and
  process helpers. The ACP SDK bundle is generated JavaScript, not migration input.
- `scripts/`: repository development utilities, including the ACP bundle builder.
- `test/unit/`: offline tests. `test/live/`: opt-in live checks.

## Development and verification

- Preserve unrelated uncommitted work. Do not restore removed integrations from
  archived plans or install/publish changes merely because an old skill says to.
- Do not spawn fleets of Claude agents to implement or validate work here.
- Node ≥ 24.12; the gateway uses strict TypeScript and Node's type stripping.
  `npm test` runs `tsc --noEmit` before Node's built-in test runner. ACP is bundled
  for runtime use; dependencies are declared in `package.json`. The local token
  counter uses `js-tiktoken`; Node type stripping does not replace type checking.
- Run `npm test` for offline verification. Add or extend meaningful unit tests for
  behavior changes; documentation-only edits do not need new tests.
- Run appropriate opt-in live checks when changing a live integration path;
  these invoke real CLIs and spend provider usage. The README lists native gateway
  checks; the old companion `test:live` script was removed.
- `npm run test:live:cursor` exercises real SDK callbacks and Claude main/subagent
  Read/Edit. Requires the official SDK login (`--cursor-login` on the launcher).
- Definition of done: relevant checks pass, no `DEP0190` warnings, and
  `CHANGELOG.md` reflects user-facing changes.
- Future bridges need session/worker/provider/workspace isolation as specified in
  the architecture. The old companion's workspace-only state is not the contract
  to recreate.
