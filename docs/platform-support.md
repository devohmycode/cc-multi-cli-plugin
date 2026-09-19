# Platform support

Offline checks run in CI on Linux, macOS and Windows for every commit. Live
provider checks need a real login on the host and are run by hand.

## Support matrix

| Provider | Linux | WSL | macOS | Windows |
| --- | --- | --- | --- | --- |
| OpenAI | Live-verified | As Linux | CI offline | Live-verified |
| Cursor SDK | Live-verified | As Linux | CI offline | Live-verified |
| OpenCode Zen | Live-verified | As Linux | CI offline | CI offline |
| Antigravity | Live-verified | As Linux | CI offline | Live-verified |

"Live-verified" means the live checks for that provider have passed on that
platform. "CI offline" means the unit suite passes there and live checks are
still to run. WSL reads the Linux policy and config paths, so it behaves as Linux.

Windows results on a real host (Windows 11, PowerShell 7, Node 24, Claude Code
2.1.273): the unit suite, live install, Cursor, OpenAI reviewer, OpenAI
approval worker and Antigravity checks pass. The permissions check skips its
PTY cases, and the provider-approval check skips its dialog proof; its direct
non-PTY path still needs its expectations adapted. The previously reported Zen, auto-mode and compaction failures also reproduced
on Linux. The fixes cover Zen terminal reasoning reconciliation, native Auto
policy propagation, and compaction before the first restored prompt. Linux
validation now covers manual/repeated compaction and fresh-process resume. Saved
live Zen traces pass the corrected tool, usage, resume, and cache assertions;
saved OpenAI worker Auto traces pass the corrected allow/deny and handback checks.
The automatic compaction case and Windows live reruns remain pending; these Linux
results do not establish Windows live support.

## Live checklist

Run from a fresh checkout after `npm ci`.

| Command | Coverage | Required setup |
| --- | --- | --- |
| `npm run test:live:compaction` | Claude/OpenAI compaction, edits, and resume | Claude and Codex login |
| `npm run test:live:zen` | Zen tools, cache usage, and resume | `OPENCODE_API_KEY` or OpenCode `/connect` |
| `npm run test:live:cursor` | Cursor tools, continuation, disk resume, non-Fast execution | Cursor SDK login and `--cursor-login` |
| `npm run test:live:auto-mode` | OpenAI Auto review and routing | Claude and Codex login |
| `npm run test:live:provider-approval -- --launcher` | Provider review and Claude terminal approval | Codex, Claude, Python 3 on POSIX |
| `npm run test:live:reviewer` | OpenAI review allow/deny behavior | Codex login |
| `npm run test:live:approval-worker` | OpenAI worker permissions | Codex login and Claude launcher |
| `npm run test:live:permissions` | Modes, denials, effects, and attribution | Provider login, Python 3, Node 24 |
| `npm run test:live:antigravity` | `agy` tools, continuation, and saved resume | `agy` login, `--antigravity-setup`, advertised model |
| `npm run test:live:install` | Plugin install, startup, wrappers, and uninstall | Claude executable |

On Windows, PTY checks require ConPTY and skip with an explicit message. The
remaining checks run from PowerShell or cmd when Node, Claude, Codex, `agy`, and
the provider tools resolve through `PATH` and `PATHEXT`. The `agy` login is
visible only to interactive logon sessions on Windows: a check started over SSH
reports "not logged in" even when the desktop session is signed in. Run the
Antigravity check from the desktop session, or through a scheduled task
registered with the interactive logon type.

## Fresh-host procedures

### macOS

1. Install Node 24.12+, Claude Code, Codex CLI, the Cursor SDK, OpenCode, and `agy` as needed. Sign in to the providers used below.
2. Run:

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

### Windows native

1. Install Node 24.12+, Claude Code, Codex CLI, PowerShell or cmd, the Cursor SDK, OpenCode, and `agy` as needed. Sign in to the providers used below.
2. In PowerShell or cmd, run the same commands listed for macOS. Use `npm.cmd` when the shell requires it.

Managed Claude policy comes from `/etc/claude-code` on Linux and WSL,
`/Library/Application Support/ClaudeCode` and macOS preferences on macOS, and
`C:\Program Files\ClaudeCode` and the Windows policy keys on Windows. Windows
policy keys are read with `reg query`; when `reg.exe` reports a localized
failure, Windows PowerShell classifies the key as absent or failed.
