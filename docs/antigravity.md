# Antigravity native CLI integration

Antigravity runs through the official `agy` CLI and its native account login.
The gateway does not read OAuth tokens or call Antigravity model endpoints.
The integration is experimental and explicitly enabled per launcher session.

## Setup

Use Node 24.12 or newer and Linux without WSL. Install and sign in to the official
Antigravity CLI interactively, then run from this checkout:

```sh
node plugins/multi/src/native-model-gateway.ts --antigravity-models
node plugins/multi/src/native-model-gateway.ts --antigravity-setup
MULTI_ANTIGRAVITY=1 node plugins/multi/src/native-model-gateway.ts
```

The setup command installs one `multi-cli-antigravity` entry in
`~/.gemini/config/hooks.json`, preserving other entries. Ordinary CLI sessions
skip the hook entirely. Gateway-launched processes carry a fixed tool policy in
`MULTI_ANTIGRAVITY_TOOLS`. The native hook can deny tools; permitted tools continue
through Antigravity's own permission checks. Re-run setup after moving the checkout
or changing Node installations. Remove only this namespaced entry to uninstall it.
Other active global or workspace PreToolUse hooks currently reject admission because their
combined decision precedence has not been established.

Select `multi/antigravity/<advertised-model>` in `/model`, or delegate to a named
`antigravity-<advertised-model>` worker. Effort selects a matching advertised native
model variant. Models without effort suffixes receive the official `--effort`
flag and retain native validation; unsupported combinations fail explicitly. Catalog
listing is not a guarantee of subscription entitlement or quota availability.

## Permissions and execution

| Claude mode | Antigravity behavior |
| --- | --- |
| Auto | Native accept-edits; commands still follow native policy. No reviewer model. |
| acceptEdits | Same native behavior as Auto. |
| Plan | Native plan prompting plus enforced denial of shell and edits. |
| Bypass | Native permission bypass; the pre-tool hook still denies excluded capabilities. |
| default / dontAsk | Unsupported; select a supported mode. |

Claude's existing prompt/worker hooks determine the mode at prompt boundaries.
An authenticated `PreCompact` hook supplies the main-session compaction boundary;
summary requests run with every native tool denied and retain native history.
Whole-tool restrictions intersect the native capability list. Richer unsupported
Claude policy rejects admission rather than being silently ignored. The bridge
currently reuses the conservative Cursor-side Claude settings admission checks;
this does not invoke Cursor or its reviewer.

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
The gateway retains native conversation IDs and sends incremental messages after
initial context. Returning to Antigravity resumes its state; changing the selected
native model takes effect on the next prompt. A fresh authenticated prompt or a
unique response anchor admits continuation after outer history changes. Ambiguous
history changes fail without rewinding or reconstructing native history.

Completed identical requests replay persisted output without another native run.
Interrupted requests with uncertain completion preserve state and fail instead of
repeating actions. Linux kernel locks serialize native ownership. Cancellation
signals the owned CLI process group; a killed process alone does not prove that
unrelated or externally managed provider work has stopped.

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
npm run test:live:antigravity -- --compact --switch gemini-3.8-flash-low --children
```

The default check uses two native turns for a workspace write and read, with a
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

Claude 2.1.265 also passed a real manual `/compact` boundary and the following
Antigravity turn through the production launcher with a fixture CLI. This caught
and fixed omitted PreCompact mode fields, changing billing attribution metadata,
and merged command-output/user-prompt blocks. Worker outer compaction and native
automatic compaction remain unverified.

## Upstream evidence

- [Official headless CLI](https://www.antigravity.google/docs/cli/headless/)
- [Native permissions](https://www.antigravity.google/docs/cli/permissions/)
- [Native hooks](https://www.antigravity.google/docs/hooks/)

Local CLI 1.1.27 probes established that subprocess cwd alone does not register
a native workspace. Customizations in an unmounted workspace did not enforce
restrictions; execution must select the native workspace explicitly. Global native PreToolUse deny
hooks did block execution, including under native bypass. An empty JSON decision
is a denial; a successful hook with no stdout preserves the native decision path.
