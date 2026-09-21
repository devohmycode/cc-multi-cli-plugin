# Permissions

Claude Code's permission mode reaches every provider. Select it before the prompt or worker starts.

## One permission control

Claude Code's permission mode is the single control at prompt boundaries. Auto and the default mode preserve ordinary automatic review and permission behavior. Plan restricts the available work to the plan capabilities exposed by the provider. Bypass disables automatic review where the provider supports that setting while retaining explicit capability restrictions. Claude ask rules remain part of Claude's permission checks.

The mode snapshot applies at the next prompt. Direct Claude, OpenAI, and Zen
workers record prompt identity and resolve tool permissions in Claude's loop.
Cursor, Antigravity and Grok load the full settings-policy snapshot at their prompts,
or lazily when a direct-model conversation requests a harness worker. Worker modes inherit or resolve from the parent
context according to the worker definition. A missing or unsupported mode fails
explicitly.

## Provider enforcement

| Provider or action | What enforces the permission |
| --- | --- |
| OpenAI direct models | Claude Code's Read, Grep, Glob, Bash, Edit, and Write tools run the tool loop. The originating OpenAI account supplies GPT review for GPT actions when automatic review is requested. |
| Zen direct models | Claude Code runs and authorizes the tools. Zen has no independent reviewer and never uses the OpenAI reviewer. |
| Cursor native harness | Native review belongs to the originating Cursor account and run. Cursor receives the prompt-boundary mode and capability restrictions. See [docs/cursor.md](cursor.md). |
| Antigravity native harness | A namespaced global pre-tool hook enforces Claude's denials while the native CLI runs. See [docs/antigravity.md](antigravity.md). |
| Grok native harness | Each run carries Claude's mode, a bounded native toolset and deny rules that outrank every mode; the announced toolset is checked against the policy. See [docs/grok.md](grok.md). |
| Claude tools | Claude's native permission checks and Anthropic classification apply. |

Claude `PreToolUse` and `PermissionRequest` hooks observe native harness
activity. Native harness admission and provider policy enforce those actions;
the hooks do not replay native actions as Claude tools. The launcher keeps
Claude's agent view limitation required for its supervisor-owned worker setup.

The launcher enables Claude's on-demand tool discovery through the local
gateway. Direct adapters omit deferred schemas until their names appear in a
tool reference, previous tool use, or an explicit named choice, and translate
tool references into provider-compatible context.

## Explicit failures

Cursor, Antigravity and Grok admission fails explicitly for unsupported modes, unknown workers, untranslatable policies, and unavailable permission context. Multi does not apply these harness checks to Claude, OpenAI, or Zen workers. OpenAI automatic review also fails when the originating OpenAI account has no GPT reviewer, when the action origin is ambiguous, or when review evidence is malformed or unavailable. The gateway does not substitute Claude or the working model for a missing GPT reviewer.

## Managed policy sources

Native dispatch re-reads the selected settings and managed policy sources. Managed settings use the following locations.

| Platform | Managed sources |
| --- | --- |
| Linux | `/etc/claude-code/managed-settings.json` and JSON files in `/etc/claude-code/managed-settings.d/` |
| WSL | The Linux source: `/etc/claude-code/managed-settings.json` and `/etc/claude-code/managed-settings.d/` |
| macOS | `/Library/Application Support/ClaudeCode/managed-settings.json`, JSON files in `managed-settings.d`, and `defaults read com.anthropic.claudecode` |
| Windows | `C:\Program Files\ClaudeCode\managed-settings.json`, JSON files in `managed-settings.d`, and `HKLM` plus `HKCU` under `SOFTWARE\Policies\ClaudeCode`, value `Settings` |

Managed policies accept supported permissions, hooks, and sandbox settings. Unsupported controls, argument or path rules, ask rules, sandbox policy, and ignored policy files fail admission when the native provider cannot enforce them. The provider that will run the request supplies that judgement, so a Claude tool rule one harness maps natively is enforced rather than refused because another harness could not map it.
