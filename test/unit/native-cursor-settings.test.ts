import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { checkCursorSettings } from '../../plugins/multi-core/src/gateway/cursor-settings.ts';

let inventory: unknown[] = [];
test.beforeEach(() => {
  mock.restoreAll();
  inventory = [];
  mock.method(childProcess, 'execFile', (...args: unknown[]) => {
    const callback = args.at(-1);
    if (typeof callback === 'function') {
      callback(null, JSON.stringify(inventory), '');
    }
  });
});

test('native settings admission respects source selection and rechecks changed ancestor policies', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-settings-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = path.join(root, 'user');
  const cwd = path.join(root, 'project', 'nested');
  await fs.mkdir(config);
  await fs.mkdir(cwd, { recursive: true });
  t.mock.property(process, 'env', { ...process.env, CLAUDE_CONFIG_DIR: config });
  await fs.writeFile(
    path.join(config, 'settings.json'),
    JSON.stringify({ permissions: { ask: ['Bash'] } }),
  );
  await assert.rejects(checkCursorSettings(cwd, [], {}), /permissions.ask/);
  await checkCursorSettings(cwd, ['--setting-sources=project,local'], {});
  const project = path.join(root, 'project', '.claude');
  await fs.mkdir(project);
  await fs.writeFile(
    path.join(project, 'settings.local.json'),
    JSON.stringify({ permissions: { deny: ['Read'] } }),
  );
  assert.deepEqual(
    (await checkCursorSettings(cwd, ['--setting-sources', 'local'], {})).disallowedTools,
    ['Read'],
  );
  await checkCursorSettings(cwd, ['--setting-sources', 'project'], {});
  await fs.writeFile(path.join(project, 'settings.json'), '{invalid');
  await assert.rejects(
    checkCursorSettings(cwd, ['--setting-sources=project'], {}),
    /admission failed/,
  );
  await checkCursorSettings(cwd, ['--setting-sources='], {});
});

test('native settings admission refuses CLI restrictions and caller hooks but accepts grants', async () => {
  const policy = await checkCursorSettings(
    '/tmp',
    ['--setting-sources=', '--tools=Read,Bash', '--tools=Read,Edit', '--disallowedTools=Bash'],
    { permissions: { deny: ['Write'] } },
  );
  assert.deepEqual(policy.tools, ['Read']);
  assert.deepEqual(policy.disallowedTools, ['Bash', 'Write']);
  await assert.rejects(
    checkCursorSettings('/tmp', ['--setting-sources=', '--tools=Bash(git:*)'], {}),
    /unsupported policy/,
  );
  for (const args of [['--setting-sources'], ['--setting-sources=managed']]) {
    await assert.rejects(checkCursorSettings('/tmp', args, {}), /setting-sources/);
  }
  await checkCursorSettings('/tmp', ['--setting-sources=', '--allowedTools', 'Bash'], {
    permissions: { allow: ['Bash'] },
  });
  // Claude hooks never run for native tools, so they must not block admission.
  await checkCursorSettings('/tmp', ['--setting-sources='], {
    hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'log' }] }] },
  });
});

test('native settings admission translates managed deny and refuses unknown controls', async (t) => {
  const original = fs.readFile;
  let policy = JSON.stringify({ permissions: { deny: ['Bash'] } });
  t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
    if (String(args[0]) === '/etc/claude-code/managed-settings.json') {
      return policy;
    }
    return original(...args);
  });
  assert.deepEqual(
    (await checkCursorSettings('/tmp', ['--setting-sources='], {})).disallowedTools,
    ['Bash'],
  );
  policy = JSON.stringify({ policyHelper: '/tmp/policy' });
  await assert.rejects(
    checkCursorSettings('/tmp', ['--setting-sources='], {}),
    /cannot enforce managed policy/,
  );
});

test('native CLI tool policy accepts empty/default lists and variadic names', async () => {
  assert.deepEqual(
    (await checkCursorSettings('/tmp', ['--setting-sources', '', '--tools', ''], {})).tools,
    [],
  );
  assert.equal(
    (await checkCursorSettings('/tmp', ['--setting-sources=', '--tools', 'default'], {})).tools,
    undefined,
  );
  assert.deepEqual(
    (await checkCursorSettings('/tmp', ['--setting-sources=', '--tools', 'Read', 'Grep'], {}))
      .tools,
    ['Read', 'Grep'],
  );
});
