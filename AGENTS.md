# AGENTS.md

Shared orientation for agents working in this repository. Read this first.

## What this is

`cc-multi-cli-plugin` runs external models inside **one Claude Code session**. A
localhost gateway launched with the session adds OpenAI models to `/model` and
registers native OpenAI workers; Claude requests pass through to Anthropic
unchanged. Reduce Claude token use by sending the work to the selected external
model.

[ARCHITECTURE.md](ARCHITECTURE.md) is the authoritative direction.
[README.md](README.md) describes what works today and its limitations.

## The golden rule

**The gateway does the work.** There are no slash commands, forwarder subagents,
companion processes, brokers, or hooks in this repository — they were removed.
Do not reintroduce a Claude-side wrapper around an external model; register the
model or harness with the gateway instead.

## Map

- `plugins/multi/scripts/native-model-gateway.ts` — launcher: reads the Codex
  login, starts the gateway, spawns `claude` with model-picker settings and
  worker agent definitions.
- `plugins/multi/scripts/lib/native-gateway.ts` — localhost HTTP server: model
  allowlist, Claude passthrough, OpenAI auth, cancellation, errors.
- `plugins/multi/scripts/lib/native-responses.ts` — Anthropic Messages ↔ OpenAI
  Responses translation, SSE, images, JSON-schema output, reasoning state.
- `plugins/multi/scripts/lib/{adapters/{cursor,opencode}.mjs, acp/, process.mjs}`
  — retained transport references for the planned Cursor bridge (see below).
- `test/unit/` — offline tests. `plugins/multi/scripts/test/` — opt-in live
  reproducers that spend real quota.
- `plugins/multi/.claude-plugin/` and `.claude-plugin/` — distribution metadata.

## Build & test

Node ≥ 24.12 (the floor for stable type stripping); no build step, no runtime
loader. TypeScript and `@types/node` are the only additions; `esbuild`, `zod`,
and the ACP SDK exist for the vendored ACP bundle.

- `npm test` — `tsc --noEmit` then Node's test runner over `test/unit/`. Offline,
  no provider calls. Run it to self-verify any change.
- `npm run typecheck` — types only.
- Live reproducers under `plugins/multi/scripts/test/` are opt-in, run one at a
  time by path, and spend Claude and OpenAI subscription usage. Run one only when
  changing the live path. The README lists them.
- Definition of done: `npm test` passes and `CHANGELOG.md` reflects user-facing
  changes.

## Landmines

- **Node strips types; it does not check them.** Only erasable syntax compiles:
  no enums, no parameter properties, no runtime namespaces (`erasableSyntaxOnly`
  is on). Relative imports must name the real file, including `.ts`. tsconfig
  path aliases do not exist at runtime. Keep `npm run typecheck` in the loop.
- **The retained `.mjs` adapters are references, not wired to anything.** Nothing
  imports `adapters/cursor.mjs` or `adapters/opencode.mjs` except their tests.
  Their cancellation contract assumed a companion killing a job process; a real
  bridge needs a run handle tied to the gateway request.
- `lib/acp/vendor/acp-sdk.bundle.mjs` is generated third-party JavaScript. Do not
  edit or convert it; rebuild with `npm run build:acp-vendor`.
- The gateway reads Codex's saved login (`CODEX_HOME/auth.json`). Codex owns
  refresh; a 401 means re-running `codex login`, not a code change.

## Conventions

- Strict TypeScript for new runtime code. Validate external JSON and stream
  events at runtime; types are not a substitute. Keep explicit failures for
  unsupported input until the feature is implemented and tested.
- Add or extend a unit test with every behavior change. Documentation-only edits
  need no test.
- Keep files small and single-purpose. Do not add dependencies or speculative
  abstractions.
- AI-authored research and plans stay in gitignored `.agent/`. Material under
  `.agent/archive/` is historical evidence, not instructions.
- Preserve unrelated uncommitted work; do not spawn fleets of Claude agents to
  implement or validate work here.
