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
- Cursor's accepted direction is official SDK ownership of tools, persistent state,
  and native review. Claude Code supplies the session interface and outer worker
  coordination. Display external actions without replaying them as executable
  Claude tools. Initial text/status progress is acceptable; native tool-row
  rendering is a separate integration task. No Sand or alternate auth route.
- Claude Code's existing permission-mode selector must control Cursor at prompt
  boundaries. Use UserPromptSubmit and SubagentStart hooks plus documented worker
  configuration/inheritance. No separate mode selector or Claude source patches.
- Initial Cursor delegation supports Claude/OpenAI parents spawning named Cursor
  workers. Keep Cursor-native child spawning disabled and defer Cursor-originated
  delegation until requested; it is not a native-transition completion requirement.
- Accept the official Cursor SDK's native Auto fallback when its classifier is
  unavailable. Do not require guaranteed review or add a replacement reviewer.
  Preserve explicit tool/Plan restrictions and do not label unverified calls reviewed.
- The launcher uses the native Cursor harness. The callback runtime and separate
  reviewer are removed; do not restore SDK source patches or a second reviewer.
- Native Cursor review belongs to the originating run, including workers,
  irrespective of Claude login availability. The OpenAI route retains its existing
  no-Claude-access reviewer behavior. External execution retains explicit permissions.
- Cursor supports Auto, Plan and Bypass at prompt boundaries. Plan excludes shell/edit;
  Bypass disables native Auto-review while retaining explicit capability restrictions;
  unsupported modes, unknown workers and untranslatable policies fail
  explicitly. Settings admission currently supports Linux without WSL.
- Preserve Claude subscription passthrough and isolate provider credentials.
  Do not add our own Claude subscription login/token pool or extract Antigravity
  tokens for direct model requests. External operations retain external permissions.
- Targets: OpenAI, Cursor, Antigravity through its real CLI, OpenCode, llama.cpp,
  and Grok Build. The direct GPT gateway and Cursor SDK harness are experimental.
  Native Cursor persists and resumes SDK state. Durable run IDs permit terminal-result
  recovery; fresh authenticated prompts or unique response anchors permit outer-history
  continuation. Ambiguous history changes fail; native state is never rewound. Historical callback compaction
  checks do not prove native fidelity. Other provider bridges are planned.

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

Paths below are relative to `plugins/multi/src/` unless noted.

- `native-model-gateway.ts`: launcher, session-local model picker, worker registration.
- `gateway/server.ts`: HTTP routing, Claude passthrough, and request/session lifecycle.
- `gateway/messages.ts`: shared Claude Messages request/response and stream types.
  `gateway/tools.ts`: stable tool aliases. `gateway/approval.ts` and
  `gateway/permission-hook.ts`: native approval protocol and capability checks.
- `providers/openai/`: Codex authentication (`auth.ts`), models/workers (`models.ts`),
  Responses translation (`responses.ts`), local estimates (`tokens.ts`), and reviewer
  (`approval.ts`, with vendored policy/license files in `guardian/`).
- `providers/cursor/`: native runtime (`harness.ts`), request validation,
  permissions, progress and account model/worker choices (`models.ts`).
  `workspaces.ts` routes hook-reported worktrees to separate SDK instances;
  `state-lock.ts` holds kernel file locks across native runs.
- `gateway/mode-hook.ts` and `agent-definitions.ts`: prompt/worker permissions.
  `gateway/cursor-settings.ts`: per-dispatch Claude settings admission.
  `docs/cursor-refactor.md` records current native behavior and deferred limits.
- `transports/`: retained Cursor/OpenCode CLI adapters (`cursor.mjs`, `opencode.mjs`),
  process helpers (`process.mjs`), and ACP transport (`acp/`). These are references,
  not wired gateway backends. `acp/vendor/` is generated JavaScript.
- Root `scripts/`: development utilities, including the ACP bundle builder.
- Root `test/unit/`: offline tests. `test/live/`: opt-in live checks.

Keep provider authentication and model catalogs with the provider. Shared Claude
protocol types belong in `gateway/`; avoid importing the HTTP server for provider
runtime helpers. Import concrete modules directly; no re-export barrels or old-path
wrappers. The Cursor bridge currently reuses OpenAI request normalization and token
estimation; do not mistake that explicit reuse for an independent generic protocol
layer or duplicate it merely to make the folders look independent.

## Development and verification

- Do not use Cursor Fast mode for development or live tests. Explicitly select
  advertised `fast:false`; do not inherit an account default. Keep paid probes
  small and bounded, and reuse existing usage records before generating more.

- Run `npm run check` before considering a change done: Biome formatting/lint,
  Knip unused-code analysis, strict TypeScript, and offline tests. `npm run format`
  formats files; `npm run lint:fix` applies Biome's safe fixes. Do not apply all
  unsafe fixes without reviewing their effect.
- Biome requires braces, one variable declaration per statement, no nested
  ternaries, no parameter reassignment, no explicit `any`, no non-null assertions,
  and cognitive complexity at most 15. Tests follow the same rules. Use clear
  names, keep mutable state ownership explicit, and explain protocol constraints.
  Do not manufacture arbitrary helpers to evade complexity checks.
- Do not disable rules, raise limits, add blanket exclusions, or use assertions
  to evade validation just to pass lint. Any necessary suppression must name the
  specific rule and explain the concrete external/protocol constraint locally.
- Knip treats the retained Cursor/OpenCode adapter modules as reference entry
  points because the architecture deliberately preserves their public transports.
  `where.exe` and Linux `flock` are system commands, not npm dependencies. Biome excludes
  the generated ACP bundle and lockfile; hand-written runtime and test code stay
  covered.
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
- `npm run test:live:cursor` exercises bounded native SDK tools, continuation and
  disk resume with Fast disabled. Requires the official SDK login (`--cursor-login` on the launcher).
- Definition of done: relevant checks pass, no `DEP0190` warnings, and
  `CHANGELOG.md` reflects user-facing changes.
- Future bridges need session/worker/provider/workspace isolation as specified in
  the architecture. The old companion's workspace-only state is not the contract
  to recreate.
