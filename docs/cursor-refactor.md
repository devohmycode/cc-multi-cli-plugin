# Cursor native integration status

Updated 2026-09-11. [ARCHITECTURE.md](../ARCHITECTURE.md) owns product direction;
[README.md](../README.md) explains usage. Earlier migration waves, source-patch
experiments and callback proofs are historical research under `.agent/`.

## Current runtime

The launcher selects the official Cursor SDK harness. The callback bridge and
separate source-patched Bash reviewer are removed. Cursor owns native tools,
persistent state and native review; Claude Code supplies the session and outer
worker interface. External actions produce attributed display-only text/status by
default, with optional MCP display rows described below. Observed actions never
become executable Claude filesystem or shell calls.

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
| Retries/failures | Completed identical requests replay output. Cancellation reaches SDK; a durable run ID recovers a readable terminal result via Agent.getRun and persists it. When recovery is impossible or the run did not finish, the session stays interrupted and the next request dispatches fresh work with a notice instead of refusing; a non-finished run is never cached, so an identical retry simply runs again. |
| Delegation | Native Cursor task and MCP capabilities disabled; no Cursor children or Cursor-originated cross-provider delegation. |

## Optional live action rows

Launch with `MULTI_CURSOR_TOOL_ROWS=1` to enable live Cursor rows. The default is off.
The launcher registers a session-private authenticated HTTP MCP server and adds its
exact display tool names to Cursor worker definitions and session allow rules.
Existing user deny/ask rules remain in force. Missing display tools fall back to
ordinary attributed text; they never expand native Cursor capabilities. The native
SDK still owns execution and review, Fast remains disabled, and prompt hooks still
supply the effective mode and tool restrictions.

Read, Grep, Edit, Bash, Action and Message rows arrive as content blocks close inside
one open Messages SSE response. Waiters expose only a description and an observed
outcome; they have no filesystem, shell or SDK executor. Narration is coalesced every
750ms or at an action boundary. Claude receives one terminal follow-up locally,
without another SDK prompt; native usage is reported on the original response and
this acknowledgement has zero additional usage. These are MCP cards, so Claude
counts them as other tools rather than built-in read/edit/shell statistics. Model
text becomes Message rows, including in the background worker panel.

The original Messages connection owns cancellation throughout. Disconnecting a
pending MCP waiter also cancels that originating run. Completed exchanges persist
privately under `~/.cursor/multi-native-rows` and replay after gateway restart without
calling the SDK. Exact interrupted display retries return an interruption error;
a fresh prompt continues on retained native state. A crash between native completion
and display persistence can lose the final display, but does not authorize replay.
Missing records produce an interruption notice. Display tool denials are acknowledged
locally and cannot undo native actions. Display calls/results are removed from later
Cursor history and replaced with its original native response anchor, even after the
flag is switched off. Sidecar records currently require manual retention management.

Descriptions are bounded to 160 characters (1,200 for narration), results to 4,096,
and exchanges to 2,048 rows. Additional rows are suppressed after the cap; the final
answer still completes. Long narration chunks may be truncated. Control sequences
and common bearer-key patterns are removed; this is not a general secret detector.
Do not treat an absent per-action outcome as proof of success. Antigravity remains
on text progress: its DONE event can accompany a denied action and requires separate
terminal-outcome correlation before adopting this protocol.

Offline fake SDK tests cover live waiters, cancellation, durable replay, forged
callbacks, unavailable tools, denied history and terminal text deltas. Local probes
with the real Claude 2.1.267 binary and the production gateway/fake SDK completed in
main, named foreground and named background sessions. They used no provider inference.
The earlier 57-action fixture needed only two Messages requests. Interactive styling,
MCP progress-notification rendering and very long interactive sessions remain unverified.

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
