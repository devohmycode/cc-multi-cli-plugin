# Cursor native integration status

Updated 2026-09-15. [ARCHITECTURE.md](../ARCHITECTURE.md) owns product direction;
[README.md](../README.md) explains usage. Earlier migration waves, source-patch
experiments and callback proofs are historical research under `.agent/`.

## Current runtime

The launcher selects the official Cursor SDK harness. The callback bridge and
separate source-patched Bash reviewer are removed. Cursor owns native tools,
persistent state and native review; Claude Code supplies the session and outer
worker interface. Gateway-streamed external actions appear as wrapped, display-only
`tool_use` rows answered by the Claude Mod's `tool.call`. Observed actions never
become executable Claude filesystem or shell calls. The former MCP display server
and row store are gone.

| Surface | Current contract |
| --- | --- |
| Model selection | Official SDK login and account catalog; explicit advertised effort; base routes disable Fast when advertised. |
| Main/worker identity | Session and worker state isolated within workspace/provider scope. Claude/OpenAI parents can spawn named Cursor workers. |
| Mode observation | Claude Mods post authenticated prompt and worker snapshots with worker definitions and documented inheritance; next-prompt changes. |
| Auto | SDK native auto-review, including its accepted unavailable-classifier fallback. Completion does not prove review. |
| Plan | Native plan mode with only read/grep/glob/ls; shell/edit/task/MCP excluded. |
| Other modes | Bypass disables native Auto-review while retaining explicit tools and SDK sandbox; default, acceptEdits and dontAsk fail. |
| Tool/settings policy | Conservative capability intersection; whole-tool rules, CLI restrictions and discovered plugin policy translate; unsupported restrictions and unknown workers reject admission. Files rechecked before dispatch. |
| Platforms | Native settings admission supports Linux without WSL; Linux managed settings/fragments support narrow policy translation; unsupported controls and other platforms reject. |
| Continuation | Persistent SDK agent and disk resume; changed mode/tools resume with the new whitelist. Once a session has a prior response, only the newest turn (everything after the last assistant message) is forwarded; a request whose history ends with an assistant message, or that has no new user message after it, fails explicitly. If the outer history no longer contains the previous response, the gateway streams a notice and continues on the native record; native state is never rewound. |
| Retries/failures | Completed identical requests replay output. Cancellation reaches SDK; a durable run ID recovers a readable terminal result via Agent.getRun and persists it. When recovery is impossible or the run did not finish, the session stays interrupted and the next request dispatches fresh work with a notice instead of refusing; a non-finished run is never cached, so an identical retry simply runs again. |
| Delegation | Native Cursor task and MCP capabilities disabled; no Cursor children or Cursor-originated cross-provider delegation. |

## Claude Mods runtime

The launcher requires Claude Code 2.1.272 or newer, always sets
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, and fails explicitly when function hooks are
unavailable. The bundled Multi core mod is the only Cursor display and permission
synchronization path. The gateway streams display-only `tool_use` blocks whose
bounded results are answered locally by the mod. `ui.render` wraps their rows;
detached `ui.status` polling shows model, worker, elapsed time and lifecycle.
Programmatic `$.tool.call` is not used to create transcript rows. Cursor and
Antigravity remain the executors, and display tools never grant native permissions.

The launcher precomputes worker definitions. At each prompt, detached gateway jobs
refresh settings admission and the catalog; short hook requests poll the job and
acknowledge its generation. Discovery that outlasts the bounded wait blocks the
prompt. Native dispatch still rechecks settings. Worker offers hide unknown or
unsupported entries, and spawns validate parent, model, cwd and generation against
the prepared catalog. The child-start boundary must acknowledge the engine's ID
before a native request. Ambiguous concurrent starts of the same type/cwd fail
closed. Generated `--agents` and classic direct-tool permission review remain.

`turn.step` sends model/effort telemetry and forwards core chunks unchanged. It
never runs inference itself. Native summary precompute runs detached with zero
tool capabilities and a two-minute deadline. A summary may replace only its exact
leading transcript under the same instructions, worker and generation; stale or
missing summaries fall through to core only after tool-free authorization. The
classic Antigravity `PreCompact` transport is removed; the native global pre-tool
hook stays. Precompute is limited to the 32 KiB control
payload and native harness models. Native state is never rewound.

All routes retain token/origin checks and use a 32 KiB request limit. Session,
pending-action and summary state is bounded and cleared on detach. Provider
credentials remain isolated. Wrapped rows are supported; native Read/Edit row
rewrites and the new lifecycle appearance still need an interactive TTY check.

## Code ownership

Paths below are relative to `plugins/multi-core/src/`:

- `launcher.ts`: launcher, model picker, workers and settings callback.
- `gateway/server.ts`: canonical identity, routing and lifecycle.
- `gateway/mode-hook.ts`, `agent-definitions.ts`, `cursor-settings.ts`: mode snapshots,
  worker permission resolution and effective settings admission.
- `../../multi-cursor/src/harness.ts`: SDK state, dispatch, replay and cancellation.
- `../../multi-cursor/src/permissions.ts`: mode/tool translation and policy admission.
- `../../multi-cursor/src/request.ts`, `progress.ts`, `errors.ts`: native input validation,
  display-only progress and sanitized failures.
- `../../multi-cursor/src/models.ts`: account selections and worker choices.

The direct OpenAI path and shared gateway approval modules retain their existing
Claude-executed tool behavior. The obsolete Cursor/OpenCode CLI/ACP transports
are removed. Do not recreate deleted callback or reviewer modules.

## Public interface boundaries and remaining validation

- Attributed text includes bounded sanitized edit diffs, output, exit status and
  elapsed time. Arbitrary Claude-native tool cards and manual approval widgets
  have no verified public Messages extension surface; do not replay executable tools.
- The SDK exposes no wired manual decision transport equivalent to default,
  acceptEdits or dontAsk. Native Auto fallback remains the accepted SDK behavior.
- Natural SDK compaction is observable through summary events, but the public API
  has no force-compaction/threshold control or authoritative occupancy counter.
  Broader model fidelity and natural-compaction validation remain testing work.
- Terminal recovery requires a durable SDK run ID. Unknown dispatch without one
  remains uncertain; no recovery mechanism may repeat the action blindly. Kernel
  file locks protect session ownership. Outer-history continuation preserves native
  history, and is not arbitrary edit/branch reconciliation or rewind.
- Plugin discovery, whole-tool restrictions and narrow Linux managed-policy
  translation are implemented. Richer argument/path policies and other operating
  systems still require enforcement work; unsupported policies fail explicitly.
- Native runs have no gateway execution deadline. OpenAI has no default gateway
  deadline; Anthropic passthrough retains 180 seconds. The launcher defaults `API_TIMEOUT_MS` to the documented maximum
  2147483647, preserving an explicit inherited value; Claude stream watchdogs and
  native tool limits remain. [Environment variables](https://code.claude.com/docs/en/env-vars)
- Cursor-originated delegation remains deferred until requested.

These limits do not justify restoring callback execution or a separate reviewer.

## Validation

Final integrated `npm run check` passes the offline tests, Biome, Knip and
TypeScript with no DEP0190 warnings. Lock tests cover owner crashes, contention and
descriptor cleanup; workspace tests cover canonical worktree routing and shutdown.

Latest buildout checks passed real Composer saved-run recovery without inference,
recall after removing outer history, and a GPT-5.6 Luna parent delegating a native
edit to Grok 4.6 at low effort. These used three non-Fast Cursor inference turns.
Native workspace routing uses the hook-reported worker cwd for both SDK execution
and policy checks.

Run `npm run check` for offline verification. Run
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test plugins/multi-core` to test
the bundled mod without provider inference. `npm run test:live:cursor` and its
`test:live:cursor-harness` alias exercise bounded native SDK tools, continuation and
resume. `-- --compact --recover` additionally checks outer-history continuation and
recovery of the first actual SDK result without another inference turn. These are
test capabilities, not a claim that the latest combined run passed. Paid tests must
use explicit non-Fast selections.

Integrated live checks passed a real Claude-parent Composer 2.5 worker edit,
persisted SDK resume, cached retry, follow-up recall and read-only Plan. These used
four non-Fast Cursor inference turns in total. No broad feature-parity or native
compaction claim follows from these bounded checks or earlier callback tests.
