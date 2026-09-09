import assert from 'node:assert/strict';
import test from 'node:test';
import {
  antigravityPermissionPolicy,
  antigravityToolDecision,
} from '../../plugins/multi/src/providers/antigravity/permissions.ts';

test('Antigravity Auto uses native permission fallback and Plan excludes side effects', () => {
  const auto = antigravityPermissionPolicy({ permissionMode: 'auto', disallowedTools: ['Write'] });
  assert.equal(auto.mode, 'accept-edits');
  assert.match(auto.notice, /No automatic reviewer/);
  assert(!auto.tools.includes('write_to_file'));
  assert.equal(antigravityPermissionPolicy({ permissionMode: 'bypassPermissions' }).bypass, true);
  const plan = antigravityPermissionPolicy({ permissionMode: 'plan' });
  assert.deepEqual(plan.tools, ['view_file', 'list_dir', 'grep_search', 'find_by_name']);
  assert.throws(() => antigravityPermissionPolicy({ permissionMode: 'default' }), /unsupported/);
  assert.throws(
    () => antigravityPermissionPolicy({ permissionMode: 'auto', tools: ['Bash(git)'] }),
    /cannot enforce/,
  );
});

test('native gate preserves ordinary CLI policy and only denies excluded capabilities', () => {
  const call = (name: string) => ({ toolCall: { name, args: {} } });
  const policy = JSON.stringify(['view_file']);
  assert.equal(antigravityToolDecision(call('view_file'), policy), undefined);
  assert.equal(antigravityToolDecision(call('run_command'), policy)?.decision, 'deny');
  assert.equal(
    antigravityToolDecision(call('invoke_subagent'), '["invoke_subagent"]')?.decision,
    'deny',
  );
  assert.equal(antigravityToolDecision(call('call_mcp_tool'), policy)?.decision, 'deny');
  assert.equal(antigravityToolDecision(call('run_command')), undefined);
  assert.equal(antigravityToolDecision(call('run_command'), 'invalid')?.decision, 'deny');
  assert.equal(antigravityToolDecision({}, policy)?.decision, 'deny');
});
