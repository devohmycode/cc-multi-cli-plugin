import assert from 'node:assert/strict';
import test from 'node:test';
import type { PermissionContext } from '../../plugins/multi-core/src/gateway/mode-hook.ts';
import {
  type GrokPolicy,
  grokCompactionPolicy,
  grokPermissionPolicy,
} from '../../plugins/multi-grok/src/permissions.ts';

function context(overrides: Partial<PermissionContext> = {}): PermissionContext {
  return { permissionMode: 'auto', ...overrides };
}

test('Auto grants the mapped native tools and denies MCP execution', () => {
  const policy: GrokPolicy = grokPermissionPolicy(context());
  assert.equal(policy.mode, 'auto');
  assert.deepEqual(policy.tools, [
    'run_terminal_command',
    'read_file',
    'search_replace',
    'list_dir',
    'grep',
    'kill_command_or_subagent',
    'todo_write',
    'get_command_or_subagent_output',
    'monitor',
    'web_search',
    'web_fetch',
    'write',
  ]);
  // MCP tools join the toolset when their servers connect, so only a rule stops them.
  assert.deepEqual(policy.deny, ['MCPTool(*)']);
  // Measured: `--tools` alone left nineteen tools for a twelve-tool allowlist, so
  // everything ungranted is also removed by name.
  assert.equal(policy.disallowedTools[0], 'Agent');
  assert.equal(policy.disallowedTools.includes('search_tool'), true);
  assert.equal(policy.disallowedTools.includes('image_gen'), true);
  assert.equal(policy.disallowedTools.includes('run_terminal_cmd'), false);
  for (const tool of ['spawn_subagent', 'ask_user_question', 'search_tool', 'use_tool']) {
    assert.equal(policy.forbidden.includes(tool), true, tool);
  }
  assert.match(policy.notice, /MCP execution is denied/);
});

test('Plan removes shell, edits and writes while keeping the native plan flow', () => {
  const policy = grokPermissionPolicy(context({ permissionMode: 'plan' }));
  assert.equal(policy.mode, 'plan');
  assert.deepEqual(policy.tools, [
    'read_file',
    'list_dir',
    'grep',
    'todo_write',
    'enter_plan_mode',
    'exit_plan_mode',
    'web_search',
    'web_fetch',
  ]);
  // Measured: `--permission-mode plan` alone removes nothing, so rules carry Plan.
  assert.deepEqual(policy.deny, ['Bash(*)', 'Edit(*)', 'Write(*)', 'MCPTool(*)']);
  assert.equal(policy.forbidden.includes('run_terminal_command'), true);
  assert.equal(policy.forbidden.includes('write'), true);
  assert.match(policy.notice, /Plan/);
});

test('a Claude allowlist narrows the native toolset and the rules together', () => {
  const policy = grokPermissionPolicy(context({ tools: ['Read', 'Grep'] }));
  assert.deepEqual(policy.tools, ['read_file', 'list_dir', 'grep', 'todo_write']);
  assert.deepEqual(policy.deny, ['Bash(*)', 'Edit(*)', 'Write(*)', 'WebFetch(*)', 'MCPTool(*)']);
  assert.equal(policy.deny.includes('Read(*)'), false);
  assert.equal(policy.deny.includes('Grep(*)'), false);
  for (const tool of ['run_terminal_command', 'search_replace', 'write', 'web_search']) {
    assert.equal(policy.forbidden.includes(tool), true, tool);
  }
  // The shell is the one tool whose removal id differs from the announced name;
  // passing the announced one is accepted in silence and changes nothing.
  assert.equal(policy.disallowedTools.includes('run_terminal_cmd'), true);
  assert.equal(policy.disallowedTools.includes('run_terminal_command'), false);
});

test('every tool the policy forbids is also removed by name', () => {
  for (const policy of [
    grokPermissionPolicy(context()),
    grokPermissionPolicy(context({ permissionMode: 'plan' })),
    grokCompactionPolicy(),
  ]) {
    const removals = new Set(policy.disallowedTools);
    for (const tool of policy.forbidden) {
      const expected = tool === 'run_terminal_command' ? 'run_terminal_cmd' : tool;
      assert.equal(removals.has(expected), true, expected);
    }
  }
});

test('a granted tool is never contradicted by a coarser deny genre', () => {
  // Live run: `Edit(*)` refused the `write` tool, so granting Write must not emit
  // an Edit denial. The allowlist, checked against the announced toolset, keeps
  // search_replace out instead.
  const policy = grokPermissionPolicy(context({ tools: ['Read', 'Write'] }));
  assert.deepEqual(policy.tools, ['read_file', 'list_dir', 'todo_write', 'write']);
  assert.deepEqual(policy.deny, ['Bash(*)', 'Grep(*)', 'WebFetch(*)', 'MCPTool(*)']);
  assert.equal(policy.forbidden.includes('search_replace'), true);
});

test('an excluded tool stays denied under Bypass', () => {
  const policy = grokPermissionPolicy(
    context({ permissionMode: 'bypassPermissions', disallowedTools: ['Bash'] }),
  );
  assert.equal(policy.mode, 'bypassPermissions');
  assert.equal(policy.tools.includes('run_terminal_command'), false);
  // Deny rules outrank every mode, which is what makes Bypass restrictable at all.
  assert.equal(policy.deny.includes('Bash(*)'), true);
  assert.equal(policy.forbidden.includes('kill_command_or_subagent'), true);
});

test('unsupported modes, restrictions and native errors fail explicitly', () => {
  assert.throws(() => grokPermissionPolicy(context({ permissionMode: 'default' })), /unsupported/);
  assert.throws(() => grokPermissionPolicy(context({ permissionMode: 'dontAsk' })), /unsupported/);
  assert.throws(
    () => grokPermissionPolicy(context({ tools: ['Computer'] })),
    /cannot enforce this Claude tool restriction/,
  );
  assert.throws(
    () => grokPermissionPolicy(context({ nativePermissionError: 'worker policy is unreadable' })),
    /worker policy is unreadable/,
  );
});

test('a compaction turn keeps planning state and nothing else', () => {
  const policy = grokCompactionPolicy();
  assert.equal(policy.mode, 'plan');
  assert.deepEqual(policy.tools, ['todo_write']);
  assert.deepEqual(policy.deny, [
    'Bash(*)',
    'Edit(*)',
    'Write(*)',
    'Read(*)',
    'Grep(*)',
    'WebFetch(*)',
    'MCPTool(*)',
  ]);
  assert.match(policy.notice, /Compaction/);
});

test('every native tool is either granted or watched for', () => {
  for (const policy of [
    grokPermissionPolicy(context()),
    grokPermissionPolicy(context({ permissionMode: 'plan' })),
    grokPermissionPolicy(context({ tools: ['Read'] })),
    grokCompactionPolicy(),
  ]) {
    const overlap = policy.tools.filter((tool) => policy.forbidden.includes(tool));
    assert.deepEqual(overlap, []);
    // The forbidden list is what the announced toolset is checked against, so the
    // two halves must cover the catalog exactly.
    assert.equal(policy.tools.length + policy.forbidden.length, 27);
  }
});
