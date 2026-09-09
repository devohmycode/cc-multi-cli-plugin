import type { PermissionContext } from '../../gateway/mode-hook.ts';

const CAPABILITIES = [
  ['view_file', ['Read']],
  ['list_dir', ['Read']],
  ['grep_search', ['Grep']],
  ['find_by_name', ['Glob']],
  ['run_command', ['Bash']],
  ['command_status', ['Bash']],
  ['send_command_input', ['Bash']],
  ['write_to_file', ['Write']],
  ['replace_file_content', ['Edit']],
  ['multi_replace_file_content', ['Edit']],
] as const;

export interface AntigravityPolicy {
  tools: string[];
  mode: 'plan' | 'accept-edits';
  notice: string;
  bypass: boolean;
}

/** This restricts native tools; it never grants permission in place of native policy. */
export function antigravityPermissionPolicy(context: PermissionContext): AntigravityPolicy {
  if (context.nativePermissionError) {
    throw new Error(context.nativePermissionError);
  }
  if (!['auto', 'acceptEdits', 'plan', 'bypassPermissions'].includes(context.permissionMode)) {
    throw new Error(
      'Antigravity currently supports Auto, acceptEdits, Bypass and Plan; this mode is unsupported.',
    );
  }
  const allowed = toolRules(context.tools);
  const denied = toolRules(context.disallowedTools);
  const plan = context.permissionMode === 'plan';
  const tools = CAPABILITIES.filter(([, names]) => {
    if (plan && names.some((name) => ['Bash', 'Edit', 'Write'].includes(name))) {
      return false;
    }
    return names.every((name) => (!allowed || allowed.has(name)) && !denied?.has(name));
  }).map(([name]) => name);
  return {
    tools,
    mode: plan ? 'plan' : 'accept-edits',
    bypass: context.permissionMode === 'bypassPermissions',
    notice: policyNotice(context.permissionMode),
  };
}

function policyNotice(mode: PermissionContext['permissionMode']): string {
  if (mode === 'plan') {
    return 'Plan: native shell, edits and delegation are blocked.';
  }
  if (mode === 'bypassPermissions') {
    return 'Bypass: native approval disabled; explicit tool restrictions remain enforced.';
  }
  return 'Native permissions: edits allowed; approval-dependent actions may be denied. No automatic reviewer.';
}

function toolRules(rules: string[] | undefined): Set<string> | undefined {
  if (rules === undefined) {
    return undefined;
  }
  const supported = new Set(['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write', 'Agent', 'Task']);
  if (!Array.isArray(rules) || rules.some((rule) => !supported.has(rule))) {
    throw new Error('Antigravity cannot enforce this Claude tool restriction.');
  }
  return new Set(rules);
}

/** No policy means an ordinary native CLI session, outside this gateway. */
export function antigravityToolDecision(input: unknown, serializedPolicy?: string) {
  if (serializedPolicy === undefined) {
    return undefined;
  }
  try {
    const policy: unknown = JSON.parse(serializedPolicy);
    if (!Array.isArray(policy) || policy.some((tool) => typeof tool !== 'string')) {
      throw new Error('Invalid native tool policy');
    }
    if (!input || typeof input !== 'object' || !('toolCall' in input)) {
      throw new Error('Missing native tool call');
    }
    const call = input.toolCall;
    if (!call || typeof call !== 'object' || !('name' in call) || typeof call.name !== 'string') {
      throw new Error('Invalid native tool call');
    }
    if (policy.includes(call.name) && CAPABILITIES.some(([name]) => name === call.name)) {
      return undefined;
    }
    return {
      decision: 'deny',
      reason: 'Claude session policy excludes this native Antigravity tool.',
    };
  } catch {
    return { decision: 'deny', reason: 'Antigravity gateway permission context is invalid.' };
  }
}
