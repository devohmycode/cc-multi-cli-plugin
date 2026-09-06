# AGENTS.md

Shared orientation for agents working in this repository. Read this first.

## Product direction

`cc-multi-cli-plugin` is moving from slash-command delegation to **external models
and coding harnesses inside one Claude Code session**. Reduce Claude token use by
letting the selected external model or harness do the work.

[ARCHITECTURE.md](ARCHITECTURE.md) is the authoritative direction.
[README.md](README.md) describes the current prototype and its limitations.

- Maintain our custom Node gateway and provider-specific adapters. No CLIProxyAPI,
  Go gateway, Vercel engine migration, or user-facing backend selector is planned.
- Expose explicit model and effort choices through `/model` and named native
  workers while preserving Claude's ordinary tier meanings and configuration.
- Visible worker lifecycle, elapsed time, streamed progress, completion, failure,
  and cancellation are product requirements.
- Direct model integrations use Claude Code's tools and execution loop. Harness
  bridges use the real external CLI's execution loop and native authentication.
  Never replay observed external tool events as executable Claude tool calls.
- Preserve Claude subscription passthrough and isolate provider credentials.
  Do not add our own Claude subscription login/token pool or extract Antigravity
  tokens for direct model requests. External operations retain external permissions.
- Targets: OpenAI, Cursor, Antigravity through its real CLI, OpenCode, llama.cpp,
  and Grok Build. The direct GPT gateway is experimental; harness bridges are
  planned and must be demonstrated before claiming support.

## Refactor scope

The existing command, skill, and Sonnet-forwarder surface is a candidate for
replacement or deletion. Its current structure is **not a compatibility
requirement for the refactor**. Do not expand or repair it merely to preserve
the old design; work on it only when the task calls for that work.

While a forwarder remains in use, keep it thin: frame the delegation, run the
companion, return its output or an explicit failure. Do not turn it into another
coding agent. Future native workers need not use a Claude forwarder at all.

Reuse existing process, session, job, and ACP helpers where they fit. Do not build
speculative abstractions or preserve obsolete modules just because they exist.
Research and old plans under `.agent/archive/` are historical evidence, not active
instructions. Keep new scratch research in gitignored `.agent/`.

## Current code map

- `plugins/multi/scripts/native-model-gateway.ts`: experimental gateway launcher,
  model-picker settings, and native worker registration.
- `plugins/multi/scripts/lib/native-gateway.ts` and `native-responses.ts`:
  provider routing and Messages/Responses translation.
- `plugins/multi/scripts/multi-cli-companion.mjs` and `lib/commands/`: existing
  companion dispatcher and command handlers.
- `plugins/multi/scripts/lib/adapters/`: Codex, Cursor, and OpenCode adapters;
  `CONTRACT.md` describes this companion interface, not the future harness bridge.
- `plugins/multi/scripts/lib/`: reusable process, state, broker, and transport
  helpers; `lib/acp/` contains the maintained client and bundled official SDK.
- `plugins/multi/{agents,commands,skills}/` and `plugins/{codex,cursor,opencode}/`:
  existing prompt-driven interface, subject to the refactor above.
- `test/unit/`: offline tests. `plugins/multi/scripts/test/`: opt-in live checks.

## Development and verification

- Preserve unrelated uncommitted work. Do not restore removed integrations from
  archived plans or install/publish changes merely because an old skill says to.
- Do not spawn fleets of Claude agents to implement or validate work here.
- Node ≥ 20; tests use Node's built-in runner. ACP is bundled for runtime use;
  build dependencies are declared in `package.json`.
- Run `npm test` for offline verification. Add or extend meaningful unit tests for
  behavior changes; documentation-only edits do not need new tests.
- Run appropriate opt-in live checks when changing a live integration path;
  these invoke real CLIs and spend provider usage. `npm run test:live` covers the
  companion path; the README lists native gateway checks.
- Definition of done: relevant checks pass, no `DEP0190` warnings, and
  `CHANGELOG.md` reflects user-facing changes.
- Always pass the intended `--cwd` to companion calls. State is keyed by resolved
  workspace root, so subdirectories of one repository share state. Use separate
  worktrees when isolated workspaces are needed. Future bridges additionally need
  session/worker isolation as specified in the architecture.
