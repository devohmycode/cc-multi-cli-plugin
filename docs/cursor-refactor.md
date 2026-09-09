# Cursor native integration status

Updated 2026-09-09. [ARCHITECTURE.md](../ARCHITECTURE.md) owns product direction;
[README.md](../README.md) explains usage. Earlier migration waves, source-patch
experiments and callback proofs are historical research under `.agent/`.

## Current runtime

The launcher selects the official Cursor SDK harness. The callback bridge and
separate source-patched Bash reviewer are removed. Cursor owns native tools,
persistent state and native review; Claude Code supplies the session and outer
worker interface. External actions produce attributed display-only text/status.
They never become executable Claude tool calls.

| Surface | Current contract |
| --- | --- |
| Model selection | Official SDK login and account catalog; explicit advertised effort; base routes disable Fast when advertised. |
| Main/worker identity | Session and worker state isolated within workspace/provider scope. Claude/OpenAI parents can spawn named Cursor workers. |
| Mode observation | Authenticated UserPromptSubmit/SubagentStart hooks plus worker definitions and documented inheritance; next-prompt changes. |
| Auto | SDK native auto-review, including its accepted unavailable-classifier fallback. Completion does not prove review. |
| Plan | Native plan mode with only read/grep/glob/ls; shell/edit/task/MCP excluded. |
| Other modes | Bypass disables native Auto-review while retaining explicit tools and SDK sandbox; default, acceptEdits and dontAsk fail. |
| Tool/settings policy | Conservative capability intersection; whole-tool rules, CLI restrictions and discovered plugin policy translate; unsupported restrictions and unknown workers reject admission. Files rechecked before dispatch. |
| Platforms | Native settings admission supports Linux without WSL; Linux managed settings/fragments support narrow policy translation; unsupported controls and other platforms reject. |
| Continuation | Persistent SDK agent and disk resume; changed mode/tools resume with the new whitelist. Once a session has a prior response, only the newest turn (everything after the last assistant message) is forwarded; a request whose history ends with an assistant message, or that has no new user message after it, fails explicitly. If the outer history no longer contains the previous response, the gateway streams a notice and continues on the native record; native state is never rewound. |
| Retries/failures | Completed identical requests replay output. Cancellation reaches SDK; durable pending run IDs recover terminal results via Agent.getRun; missing identity or ambiguous history preserves state and fails. |
| Delegation | Native Cursor task and MCP capabilities disabled; no Cursor children or Cursor-originated cross-provider delegation. |

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

Final integrated `npm run check` passes 248 tests, Biome, Knip and TypeScript,
with no DEP0190 warnings. Lock tests cover owner crashes, contention and descriptor
cleanup; workspace tests cover canonical worktree routing and shutdown.

Latest buildout checks passed real Composer saved-run recovery without inference,
recall after removing outer history, and a GPT-5.6 Luna parent delegating a native
edit to Grok 4.6 at low effort. These used three non-Fast Cursor inference turns.
The unmodified Claude hook check also verified worktree-specific worker cwd with
local fake replies and no provider usage. Native workspace routing now uses that
cwd for both SDK execution and policy checks.

Run `npm run check` for offline verification. `npm run test:live:cursor` and its
`test:live:cursor-harness` alias exercise bounded native SDK tools, continuation and
resume. `-- --compact --recover` additionally checks outer-history continuation and
recovery of the first actual SDK result without another inference turn. These are
test capabilities, not a claim that the latest combined run passed.
`npm run test:live:mode-hooks` uses the unmodified Claude CLI with fake local
responses and no provider inference. Paid tests must use explicit non-Fast selections.

Integrated live checks passed a real Claude-parent Composer 2.5 worker edit,
persisted SDK resume, cached retry, follow-up recall and read-only Plan. These used
four non-Fast Cursor inference turns in total. The unmodified-Claude hook check
also passed without provider inference. No broad feature-parity or native
compaction claim follows from these bounded checks or earlier callback tests.
