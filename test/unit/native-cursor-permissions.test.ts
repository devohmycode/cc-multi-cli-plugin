import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertCursorClaudeSettings,
  cursorNativePermissions,
  cursorPermissionMode,
  cursorPermissionPolicy,
  mergeCursorPermissions,
} from '../../plugins/multi/src/providers/cursor/permissions.ts';

test('native Cursor permissions retain SDK review and sandbox defaults without ambient tools', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cursor-permissions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.method(os, 'homedir', () => root);
  const options = await cursorNativePermissions(root);
  assert.deepEqual(options.tools, ['shell', 'read', 'edit', 'grep', 'glob', 'ls']);
  assert.deepEqual(options.agents, {});
  assert.deepEqual(options.mcpServers, {});
  assert.deepEqual(options.local, {
    cwd: await realpath(root),
    settingSources: [],
    autoReview: true,
    enableAgentRetries: false,
  });
  // A configured sandbox remains SDK-owned; this helper does not disable or replace it.
  await mkdir(path.join(root, '.cursor'));
  await writeFile(path.join(root, '.cursor', 'sandbox.json'), '{"type":"workspace_readonly"}');
  assert.equal((await cursorNativePermissions(root)).local?.sandboxOptions, undefined);
  await assert.rejects(cursorNativePermissions('relative'), /absolute workspace/);
});

test('native Cursor Plan removes shell and edit regardless of requested tools', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cursor-plan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.method(os, 'homedir', () => root);
  const context = { permissionMode: 'plan' as const };
  const policy = cursorPermissionPolicy(context);
  assert.equal(policy.mode, 'plan');
  assert.deepEqual(policy.tools, ['read', 'grep', 'glob', 'ls']);
  const options = await cursorNativePermissions(root, context);
  assert.deepEqual(options.tools, policy.tools);
  assert.deepEqual(options.agents, {});
  assert.deepEqual(options.mcpServers, {});
});

test('native Cursor intersects worker restrictions without widening grouped capabilities', () => {
  const policy = (tools?: string[], disallowedTools?: string[]) =>
    cursorPermissionPolicy({ permissionMode: 'auto', tools, disallowedTools });
  assert.deepEqual(policy([]).tools, []);
  assert.deepEqual(policy(['Read', 'Grep', 'Edit']).tools, ['read', 'grep', 'ls']);
  assert.deepEqual(policy(['Edit', 'Write']).tools, ['edit']);
  assert.deepEqual(policy(['Edit', 'Write'], ['Write']).tools, []);
  assert.deepEqual(policy(undefined, ['Bash', 'Edit', 'Read']).tools, ['grep', 'glob']);
  assert.deepEqual(policy(['Agent', 'Task']).tools, []);
  for (const rule of ['Bash(git:*)', 'Read(src/**)', 'mcp__server__tool', '*', 'Unknown']) {
    assert.throws(() => policy([rule]), /unsupported policy/);
    assert.throws(() => policy(undefined, [rule]), /unsupported policy/);
  }
});

test('native Cursor policy identity follows effective mode and tools', () => {
  const policy = cursorPermissionPolicy({ permissionMode: 'auto', tools: ['Read', 'Grep'] });
  assert.equal(
    policy.identity,
    cursorPermissionPolicy({ permissionMode: 'auto', tools: ['Grep', 'Read', 'Read'] }).identity,
  );
  assert.notEqual(
    policy.identity,
    cursorPermissionPolicy({ permissionMode: 'plan', tools: ['Read', 'Grep'] }).identity,
  );
  assert.notEqual(
    policy.identity,
    cursorPermissionPolicy({ permissionMode: 'auto', tools: ['Read'] }).identity,
  );
});

test('native Cursor refuses explicit ancestor and user policies its isolated settings would ignore', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cursor-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace', 'nested');
  const home = path.join(root, 'home');
  t.mock.method(os, 'homedir', () => home);
  await mkdir(workspace, { recursive: true });
  const policy = path.join(root, 'workspace', '.cursor', 'permissions.json');
  await mkdir(path.dirname(policy));
  await writeFile(policy, '{"deny":["Shell(rm)"]}');
  await assert.rejects(cursorNativePermissions(workspace), /permissions.json.*unsupported/);
  await rm(policy);
  const hooks = path.join(home, '.cursor', 'hooks.json');
  await mkdir(path.dirname(hooks), { recursive: true });
  await writeFile(hooks, '{}');
  await assert.rejects(cursorNativePermissions(workspace), /hooks.json.*unsupported/);
});

test('native Cursor rejects Claude restrictions that cannot reach external execution', () => {
  assert.throws(
    () => assertCursorClaudeSettings({ disableAllHooks: true }),
    /requires Claude mode hooks/,
  );
  for (const settings of [
    { permissions: { deny: ['Bash(rm:*)'] } },
    { permissions: { ask: ['Edit'] } },
    { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'check-policy' }] }] } },
    { hooks: { PermissionRequest: [{ hooks: [{ type: 'command', command: 'approve' }] }] } },
    { sandbox: { enabled: true } },
    { sandbox: { network: { deniedDomains: ['example.com'] } } },
  ]) {
    assert.throws(() => assertCursorClaudeSettings(settings), /cannot enforce Claude/);
  }
});

test('native Cursor accepts ordinary UI, grants and unrelated lifecycle hooks', () => {
  assert.doesNotThrow(() => assertCursorClaudeSettings({}));
  assert.doesNotThrow(() =>
    assertCursorClaudeSettings({
      permissions: { allow: ['Read'], deny: [], ask: [], defaultMode: 'acceptEdits' },
      hooks: {
        PreToolUse: [],
        PermissionRequest: [],
        Stop: [{ hooks: [{ type: 'command', command: 'notify' }] }],
      },
      sandbox: { enabled: false },
      statusLine: { type: 'command', command: 'status' },
      theme: 'dark',
    }),
  );
  assert.throws(() => assertCursorClaudeSettings([]), /Invalid Claude settings/);
  assert.throws(() => assertCursorClaudeSettings({ hooks: 'invalid' }), /Invalid Claude settings/);
  assert.throws(
    () => assertCursorClaudeSettings({ permissions: { deny: 'Edit' } }),
    /cannot enforce Claude/,
  );
});

test('native Cursor translates explicit auto and plan modes without weakening other modes', () => {
  assert.equal(cursorPermissionMode('auto'), 'agent');
  assert.equal(cursorPermissionMode('plan'), 'plan');
  for (const mode of ['default', 'acceptEdits', 'dontAsk', 'unknown', undefined, null]) {
    assert.throws(() => cursorPermissionMode(mode), /selected mode is unsupported/);
  }
  assert.doesNotThrow(() => assertCursorClaudeSettings({ permissions: { defaultMode: 'plan' } }));
});

test('native bypass disables review without widening explicit capabilities', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cursor-bypass-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.method(os, 'homedir', () => root);
  const context = { permissionMode: 'bypassPermissions' as const, tools: ['Read'] };
  const policy = cursorPermissionPolicy(context);
  assert.equal(policy.autoReview, false);
  assert.deepEqual(policy.tools, ['read', 'ls']);
  assert.notEqual(
    policy.identity,
    cursorPermissionPolicy({ ...context, permissionMode: 'auto' }).identity,
  );
  assert.equal((await cursorNativePermissions(root, context)).local?.autoReview, false);
});

test('restriction layers intersect tool lists and accumulate denials', () => {
  const context = mergeCursorPermissions(
    { permissionMode: 'auto', tools: ['Read', 'Bash'], disallowedTools: ['Edit'] },
    { tools: ['Read', 'Write'], disallowedTools: ['Write'] },
  );
  assert.deepEqual(context.tools, ['Read']);
  assert.deepEqual(context.disallowedTools, ['Edit', 'Write']);
  assert.deepEqual(cursorPermissionPolicy(context).tools, ['read', 'ls']);
  assert.deepEqual(mergeCursorPermissions(context, { tools: [] }).tools, []);
});
