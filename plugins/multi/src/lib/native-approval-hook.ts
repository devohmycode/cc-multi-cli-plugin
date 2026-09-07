import { pathToFileURL } from 'node:url';

export interface PendingApprovalTool { session: string; model: string; name: string; input: unknown; scope?: string }
/** Capability guard only: no command parsing, model review, or permission grants. */
export function approvalCapabilityGuard(input: any, pending: PendingApprovalTool | undefined, openaiAvailable: boolean) {
  if (input?.permission_mode !== 'auto') return {};
  // Native tool parsing can add defaults (e.g. Edit.replace_all). This lookup
  // identifies the provider, not an approval: Claude still checks the final input.
  const known = pending && pending.session === input.session_id && pending.name === input.tool_name;
  if (known && openaiAvailable && pending.model.startsWith('multi/openai/')) return {};
  if (known) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
    permissionDecisionReason: 'Auto mode is unavailable for this provider. Select a supported provider or change the permission mode before continuing.' } };
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
    permissionDecisionReason: 'Cannot establish automatic-review capability; action blocked.' } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let permissionMode: string | undefined;
  try {
    let raw = '';
    for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 1048576) throw new Error('Hook input too large'); }
    const input = JSON.parse(raw);
    permissionMode = input.permission_mode;
    // Record context in every mode: native plan mode can inherit automatic review.
    // Only an actual classifier request invokes the reviewer.
    const response = await fetch(new URL('/multi/permission', process.env.ANTHROPIC_BASE_URL), { method: 'POST',
      headers: { 'x-multi-gateway-token': process.env.MULTI_GATEWAY_TOKEN ?? '' }, body: raw, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Capability lookup failed');
    console.log(JSON.stringify(await response.json()));
  } catch {
    console.log(JSON.stringify(permissionMode && permissionMode !== 'auto' ? {} : {
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
        permissionDecisionReason: 'Cannot establish automatic-review capability; action blocked.' } }));
  }
}
