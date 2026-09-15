# Antigravity native CLI integration

Antigravity runs through the official `agy` CLI and its native account login.
The gateway does not read OAuth tokens or call Antigravity model endpoints.
The integration is experimental and explicitly enabled per launcher session.

## Setup

Use Node 24.12 or newer and Linux without WSL. Install and sign in to the official
Antigravity CLI interactively, then run from this checkout:

```sh
node plugins/multi-core/src/launcher.ts --antigravity-models
node plugins/multi-core/src/launcher.ts --antigravity-setup
MULTI_ANTIGRAVITY=1 node plugins/multi-core/src/launcher.ts
```

The setup command installs one `multi-cli-antigravity` entry in
`~/.gemini/config/hooks.json`, preserving other entries. Ordinary CLI sessions
skip the hook entirely. Gateway-launched processes always run `agy` with
`--dangerously-skip-permissions`; native Ask/Deny config is bypassed on purpose,
since headless Ask is a denial and nobody using this gateway maintains native
config. Claude's tool rules take precedence instead: each run carries a fixed
denylist of native tool names in `MULTI_ANTIGRAVITY_DENY`, and the hook denies
exactly those calls, leaving every other call's native decision path untouched
(no stdout). Re-run setup after moving the checkout or changing Node
installations. Remove only this namespaced entry to uninstall it. Other active
global PreToolUse hooks may coexist; a deny from any hook wins regardless of
hook order (see Upstream evidence).

The picker groups advertised `-low`, `-medium` and `-high` variants into one base
route, for example `multi/antigravity/gemini-3.8-flash`. Use native `/effort low`,
`/effort medium` or `/effort high` without changing that route. The gateway resolves
only an advertised native variant. With no request effort, it prefers medium, then
high, then low; Claude can supply an inherited effort even when you have not set one.
Unavailable effort fails explicitly rather than substituting another native model.

Each base row has a matching `antigravity-<base>` worker. Explicit native variant
routes and workers such as `antigravity-gemini-3.8-flash-low` remain callable, but
are not separately advertised when their family is grouped. Distinct thinking
identities stay separate. If the CLI advertises an independent unsuffixed model,
it is preserved along with its suffixed routes rather than shadowed by a synthetic
base. Unsuffixed native models receive the official `--effort` flag and retain
native validation. Catalog listing is not a guarantee of subscription entitlement
or quota availability.

## Permissions and execution

| Claude mode | Antigravity behavior |
| --- | --- |
| Auto | Native permissions skipped (`--dangerously-skip-permissions`); the hook denies whatever Claude's tool rules exclude. No reviewer model. |
| acceptEdits | Same behavior as Auto. |
| Bypass | Same behavior as Auto; explicit Claude tool restrictions are still enforced by the hook. |
| Plan | Native permissions skipped plus `--mode plan`; the hook also denies shell, write, edit, notebook-edit and delegation tools. |
| default / dontAsk | Unsupported; select a supported mode. |

Claude Code's permission mode and tool rules take precedence over native
Antigravity settings; there is no reviewer in any mode. The bundled Claude Mod is
the permission synchronization path. It posts mode, worker and compaction snapshots
through authenticated loopback `/multi/mod/*` routes, with generation
acknowledgements that fail closed when stale or unavailable. Compaction summary
requests run with every mapped native tool denied and retain native history. The
global native Antigravity `PreToolUse` hook remains the enforcement point for those
denials. The classic `PreCompact` mode transport has been removed. Core fallback now
requires generation-scoped tool-free authorization from `session.compact`.

The mod's two-phase outer compaction path first authenticates a bounded transcript
and policy generation, then starts a detached, tool-free summary in a separate
native record. It never rewinds the originating native history. A later compaction
uses that summary only if the same transcript prefix, instructions, worker and
generation still match. New prompts, interruption and detach cancel speculative
work; late results cannot be consumed. Summaries expire after two minutes. Payloads
above 32 KiB and missing/stale summaries use core compaction only after a separate,
small tool-free authorization is acknowledged. Unknown generations or unavailable
authorization skip compaction. Offline tests cover prefix changes,
cancellation and the all-tools-denied policy; no new live compaction fidelity is
claimed.

Settings and worker definitions are refreshed in detached gateway policy jobs and
admitted by generation. Workers require catalog validation and a child-start
acknowledgement before native dispatch. Whole-tool restrictions intersect the native
capability list. Richer unsupported Claude policy rejects admission rather than being silently ignored. The
bridge currently reuses the conservative Cursor-side Claude settings admission
checks; this does not invoke Cursor or its reviewer.

Native child delegation and MCP tools are denied. Claude/OpenAI parents coordinate
incoming Antigravity workers. Every external tool event is display-only text;
Claude never receives an executable replay of a native edit or command. Headless
permission denials can accompany successful CLI responses and are reported to the
user separately. Text is supported; images, documents, forced tools, strict output
schemas and stop sequences are rejected instead of silently discarded.

## Continuation, caching and failures

State is isolated by Claude session, worker, provider and canonical workspace.
New conversations get a fresh native project; every run explicitly selects its
workspace with `--add-dir`. Process cwd alone is insufficient.
The gateway retains native conversation IDs and, once one exists, sends only the
newest turn: everything after the last assistant message, resumed with
`--conversation`. A request whose history ends with an assistant message, or that
has no new user message after it, fails explicitly. Returning to Antigravity
resumes its state; changing the selected native model takes effect on the next
prompt. If the outer history no longer contains the previous turn's response,
the gateway streams a notice and continues anyway on the native conversation's
own record; native state is never rewound.

Completed identical requests replay persisted output without another native run.
A non-`SUCCESS` terminal result is reported as an error and is not persisted; an
identical retry runs again, since `agy` already recorded the failure in its own
conversation history. An abort, kill, or CLI failure that never reaches a
terminal result marks the session interrupted if `agy` reported a conversation
id for that attempt; the next request on that session prepends and streams
"The previous turn was interrupted. Report its state and do not repeat completed
actions." and clears the flag once a terminal result arrives. Linux kernel locks
serialize native ownership. Cancellation signals the owned CLI process group; a
killed process alone does not prove that unrelated or externally managed
provider work has stopped.

Gateway records live under `~/.gemini/antigravity-cli/multi-harness/`; the CLI also
retains its own conversations and logs. These can contain task text and results.
Native counters are reported separately from local prompt-size estimates. Prompt
cache measurements do not establish subscription quota charges. Resumed-process
and persistent-stdin probes both showed substantial cache reads
and occasional cold follow-ups. The production transport therefore uses explicit
conversation resume per process. Experimental availability does not promise cache
reuse or native-compaction fidelity.

## Verification

`npm run check` runs the offline gateway, transport, permission and state tests.
The opt-in live check uses native subscription usage and retains its evidence in
a temporary directory:

```sh
npm run test:live:antigravity -- --compact --switch gemini-3.7-flash-low --children
```

The default check runs Gemini 3.8 Flash (Low) for two native turns for a workspace write and read, with a
disk-backed replay between them. `--compact` adds conversation-only recall after
removing outer history; it does not force Antigravity's own context compaction.
`--children` adds an attempted native child call to verify denial. Every turn has
a two-minute deadline. Select models advertised by your installed CLI.

Local CLI 1.1.27 validation covered a native workspace write exactly once, saved
replay after restart, Gemini 3.7 to 3.8 Flash switching in the same conversation,
native read, conversation-only recall after outer history removal, and an actual
denied child-agent call. Separate native probes verified hook denials under Bypass
and interruption of a delayed sentinel command. Actual Claude parent-to-worker
routing passed through the production launcher with a fixture CLI; an OpenAI Luna
parent also passed the routing fixture. These checks do not establish native
automatic-compaction fidelity or consistent cache reuse.

A historical pre-Mod probe on Claude 2.1.265 passed a real manual `/compact`
boundary and the following Antigravity turn through the production launcher with a
fixture CLI. It is not validation of the current Mods runtime, whose launcher
requires Claude Code 2.1.272 or newer. Worker outer compaction and native automatic
compaction remain unverified.

## Upstream evidence

- [Official headless CLI](https://www.antigravity.google/docs/cli/headless/)
- [Native permissions](https://www.antigravity.google/docs/cli/permissions/)
- [Native hooks](https://www.antigravity.google/docs/hooks/)

Local CLI 1.1.27 probes established that subprocess cwd alone does not register
a native workspace. Customizations in an unmounted workspace did not enforce
restrictions; execution must select the native workspace explicitly. Global native PreToolUse deny
hooks did block execution, including under native bypass. An empty JSON decision
is a denial; a successful hook with no stdout preserves the native decision path.

Local CLI 1.1.28 probes extended this: a PreToolUse hook deny wins regardless of
hook order, against an explicit `{"decision":"allow"}` from another hook in
either file order, and under `--dangerously-skip-permissions`. No configuration
tried got a denied tool to actually execute. This is why the gateway always
passes `--dangerously-skip-permissions` and relies entirely on its own
namespaced hook to enforce Claude's tool rules, and why other active PreToolUse
hooks are no longer treated as a precedence conflict. The full native tool
catalog (`init.tools`) includes `view_file`, `list_dir`, `grep_search`,
`find_by_name`, `write_to_file`, `replace_file_content`,
`multi_replace_file_content`, `sed_file`, `run_command`, `command_status`,
`send_command_input`, `read_url_content`, `search_web`, `invoke_subagent`,
`define_subagent`, `manage_subagents`, `browser_subagent`, `call_mcp_tool`,
`notebook_edit`, `notebook_execution`, and a `browser_*` family, among others
not driven by this gateway.
