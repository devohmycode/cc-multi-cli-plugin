# Platform support

This page records the cross-platform port in the current `platform-support` branch.
“Offline-verified” means the platform behavior is covered by deterministic unit tests;
CI confirms that status for all three operating systems only when its `npm run check`
matrix passes. “Live-pending” means the path needs a real provider login and host
validation. No macOS or Windows host has yet supplied live evidence.

## Support matrix

| Provider | Linux | WSL | macOS | Windows native |
| --- | --- | --- | --- | --- |
| OpenAI/Codex | offline-verified; live-pending | offline-verified; live-pending | offline-verified; live-pending | offline-verified; live-pending |
| Cursor SDK | offline-verified; live-pending | offline-verified; live-pending | offline-verified; live-pending | offline-verified; live-pending |
| Zen | offline-verified; live-pending | offline-verified; live-pending | offline-verified; live-pending | offline-verified; live-pending |
| Antigravity | offline-verified; live-pending | offline-verified; live-pending | offline-verified; live-pending | offline-verified; live-pending; Windows hook runner unverified |

The matrix describes the provider routes, not every feature. OpenAI uses Codex
authentication and Claude's tool loop. Cursor uses the official SDK's native tools,
state, and review. Zen uses its API key and Claude's tool loop. Antigravity uses the
real `agy` CLI, native authentication, and the installed scoped hook. See
`plugins/multi-core/src/gateway/cursor-settings.ts` for managed policy sources,
`plugins/multi-antigravity/src/hooks.ts` for Antigravity paths and hook commands, and
`plugins/multi-cursor/src/harness.ts` / `plugins/multi-zen/src/auth.ts` for state roots.

Managed policy sources are `/etc/claude-code` for Linux and WSL,
`/Library/Application Support/ClaudeCode` plus `defaults read com.anthropic.claudecode`
for macOS, and `C:\Program Files\ClaudeCode` plus `HKLM`/`HKCU\SOFTWARE\Policies\ClaudeCode`
for Windows. Windows native state falls under `LOCALAPPDATA` for Cursor and Zen.

Unsupported combinations fail explicitly. These are feature or policy combinations,
not whole operating systems:

- An unsupported managed-policy platform fails with `Native Cursor managed-policy admission does not support <platform>`.
- Cursor mode must be Auto, Plan, or Bypass. The exact error is: `Native Cursor supports only Claude auto, plan or bypassPermissions permission mode; the selected mode is unsupported.`
- Cursor cannot translate unsupported tool rules: `Native Cursor cannot enforce Claude tool rule <rule>; unsupported policy.`
- Cursor rejects unsupported ask, sandbox, or ignored permission policy with the exact messages `Native Cursor cannot enforce Claude permissions.ask; native execution is unavailable.`, `Native Cursor cannot enforce Claude sandbox settings; native execution is unavailable.`, and `Native Cursor cannot honor <path> with isolated SDK settings. This permission configuration is unsupported.`
- Cursor managed files reject unsupported settings with `Native Cursor cannot enforce managed policy <file>; unsupported settings.` or `Native Cursor cannot enforce managed permission controls in <file>`.
- Antigravity accepts Auto, acceptEdits, Bypass, and Plan. Other modes fail with `Antigravity currently supports Auto, acceptEdits, Bypass and Plan; this mode is unsupported.` Unsupported Claude tool restrictions fail with `Antigravity cannot enforce this Claude tool restriction.`
- Antigravity requires its native hook. If it is absent or stale, the exact message is `Antigravity requires its native permission hook. Run the launcher with --antigravity-setup.` Custom provider settings fail with `Antigravity requires native account authentication and models; custom provider settings are unsupported.`
- Native Cursor and Antigravity never replay uncertain native actions. Their state errors are `Cursor session has invalid state; refusing to replay native actions` and `Antigravity session has invalid state; refusing native replay`.

## Manual pre-release live checklist

Run these from a fresh checkout after `npm ci`. They are opt-in, use real provider
accounts, and may consume provider usage. Run the platform-independent checks on each
release candidate; repeat the native checks on every supported host before claiming live
support for that host.

| Command | What it proves | Login or setup needed | Release gate |
| --- | --- | --- | --- |
| `npm run test:live:compaction` | Claude/OpenAI manual, repeated, automatic compaction, native edit, and saved-session resume. | Claude and Codex/OpenAI login. | Required for changes to history, reasoning, usage, or compaction; otherwise recommended. |
| `npm run test:live:zen` | Zen Responses/Chat tools, cache usage, saved resume; optional switching, compaction, and cancellation. | `OPENCODE_API_KEY` or OpenCode Zen `/connect`. | Required for a Zen release. |
| `npm run test:live:cursor` | Cursor SDK native tools, continuation, disk resume, and non-Fast execution. | Cursor SDK browser login; run launcher with `--cursor-login` first. | Required for a Cursor release on each host. |
| `npm run test:live:cursor-harness` | Alias of the native Cursor harness check. | Cursor SDK login. | Use the canonical `test:live:cursor` command; this alias must remain green if run. |
| `npm run test:live:auto-mode` | Claude/OpenAI native Auto review control and provider routing. | Claude and Codex/OpenAI login. | Required when approval or Auto routing changes. |
| `npm run test:live:provider-approval -- --launcher` | OpenAI provider review plus Claude terminal approval through the launcher. | Codex/OpenAI and Claude; Python 3 on POSIX for PTY proof. | Required when provider approval changes; Windows lacks the ConPTY proof. |
| `npm run test:live:provider-approval -- --launcher --claude-auth-fixture` | Authenticated launcher branch without copying a real Claude credential. | Codex/OpenAI login; no usable Claude token is required for this fixture. | Required when credential isolation or launcher approval changes. |
| `npm run test:live:reviewer` | OpenAI allow/deny review and read-only investigation without executing proposed commands. | Codex/OpenAI login. | Required when the OpenAI reviewer changes. |
| `npm run test:live:approval-worker` | OpenAI worker permission behavior and one temporary canary effect. | Codex/OpenAI login and Claude launcher. | Required when worker approval or permissions changes. |
| `npm run test:live:permissions` | Native permission modes, exact-once effects, denials, and provider attribution. | Claude, provider login, Python 3, and Node 24. | Required for permission changes; Windows uses non-PTY checks. |
| `npm run test:live:antigravity` | `agy` native tools, continuation, saved replay, and optional compaction/cancellation/children checks. | `agy` login, `--antigravity-setup`, and an advertised model. | Required for an Antigravity release on each host; Windows hook execution remains unverified. |
| `npm run test:live:install` | Real Claude plugin-manager install, cached startup, enablement, wrappers, and uninstall in a temporary home. | Claude executable; no provider inference or login. | Required for an installation release on each OS. |

The scripts and their argument contracts are defined in `package.json` and the
corresponding `test/live/native-*.ts` files. On Windows, the PTY helper reports the
exact skip message `SKIP: native PTY proof requires ConPTY, which is not implemented yet.` `npm run test:live:compaction` is an
OpenAI/Claude check, not native Cursor compaction. `npm run test:live:provider-approval`
and the PTY helper currently skip the ConPTY terminal proof on Windows.

## Platform validation on a fresh host

### macOS

1. Install Node 24.12 or newer, Claude Code, Codex CLI, the official Cursor SDK login
   flow, OpenCode if using Zen, and the official `agy` CLI if using Antigravity. Sign
   into the provider accounts required by the checks.
2. Clone the repository, enter it, and run, in order:

   ```sh
   npm ci
   npm run check
   node plugins/multi-core/src/launcher.ts --cursor-login
   node plugins/multi-core/src/launcher.ts --cursor-models
   npm run test:live:install
   npm run test:live:cursor
   npm run test:live:zen
   npm run test:live:compaction
   npm run test:live:auto-mode
   npm run test:live:provider-approval -- --launcher
   npm run test:live:reviewer
   npm run test:live:approval-worker
   npm run test:live:permissions
   node plugins/multi-core/src/launcher.ts --antigravity-setup
   npm run test:live:antigravity
   ```

3. Record the OS version, Node/Claude/Codex/Cursor/Zen/agy versions, exact command,
   exit status, elapsed time, selected model, and the live script's artifact/report
   path. Preserve sanitized stdout/stderr and screenshots of `/model`, worker rows,
   hook admission, cancellation, and completion. Do not record credentials or tokens.

Expect native macOS managed preferences to be read with `defaults`; the POSIX
Antigravity hook uses its shell guard. ConPTY is irrelevant on macOS, but the PTY
checks still require Python 3. The PID-aware state lock has a PID-reuse caveat: a stale
owner PID can be indistinguishable from a new process in the narrow reuse window.

### Windows native

1. Install Node 24.12 or newer, Claude Code, Codex CLI, PowerShell or cmd, the official
   Cursor SDK login flow, OpenCode if using Zen, and the official `agy` CLI if using
   Antigravity. Sign into the provider accounts required by the checks. Ensure `claude`,
   `codex`, `agy`, and Node resolve through `PATH`/`PATHEXT`.
2. Clone the repository in PowerShell or cmd and run, in order:

   ```powershell
   npm ci
   npm run check
   node plugins/multi-core/src/launcher.ts --cursor-login
   node plugins/multi-core/src/launcher.ts --cursor-models
   npm run test:live:install
   npm run test:live:cursor
   npm run test:live:zen
   npm run test:live:compaction
   npm run test:live:auto-mode
   npm run test:live:provider-approval -- --launcher
   npm run test:live:reviewer
   npm run test:live:approval-worker
   npm run test:live:permissions
   node plugins/multi-core/src/launcher.ts --antigravity-setup
   npm run test:live:antigravity
   ```

3. Record the same evidence as on macOS, including whether each command ran from
   PowerShell or cmd and whether the wrapper used `.ps1` or `.cmd`. Capture the
   Windows build, Node/CLI versions, exit status, timing, sanitized logs, reports,
   `/model` and worker lifecycle output, cancellation behavior, and hook results.

Windows uses direct Node invocation for the Antigravity hook because a POSIX shell
cannot be assumed. Cursor managed policy comes from `C:\Program Files\ClaudeCode`
and the `HKLM`/`HKCU` policy keys. ConPTY support is currently unsupported, so PTY
terminal proofs may skip; run and record the available non-PTY checks. The PID-aware
state lock has the same PID-reuse caveat. The Antigravity Windows hook runner is
unverified and must be recorded as pending until a real Windows run passes.

For all hosts, consult `README.md` for provider setup and limitations,
`plugins/multi-core/src/launcher.ts` for launcher flags, and `.github/workflows/ci.yml`
for the offline CI matrix. A green CI job establishes the offline check on Ubuntu,
macOS, and Windows; it does not establish live provider, hook, TTY, or native harness
support.
