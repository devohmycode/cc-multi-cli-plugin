import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { checkCursorSettings } from '../../plugins/multi-core/src/gateway/cursor-settings.ts';

async function temporaryDirectory(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cursor-settings-'));
}

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
    checkCursorSettings(
      await temporaryDirectory(),
      ['--setting-sources=', '--tools=Bash(git:*)'],
      {},
    ),
    /unsupported policy/,
  );
  for (const args of [['--setting-sources'], ['--setting-sources=managed']]) {
    await assert.rejects(
      checkCursorSettings(await temporaryDirectory(), args, {}),
      /setting-sources/,
    );
  }
  await checkCursorSettings(
    await temporaryDirectory(),
    ['--setting-sources=', '--allowedTools', 'Bash'],
    {
      permissions: { allow: ['Bash'] },
    },
  );
  // Claude hooks never run for native tools, so they must not block admission.
  await checkCursorSettings(await temporaryDirectory(), ['--setting-sources='], {
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
    (await checkCursorSettings(await temporaryDirectory(), ['--setting-sources='], {}))
      .disallowedTools,
    ['Bash'],
  );
  policy = JSON.stringify({ policyHelper: '/tmp/policy' });
  await assert.rejects(
    checkCursorSettings(await temporaryDirectory(), ['--setting-sources='], {}),
    /cannot enforce managed policy/,
  );
});

test('native CLI tool policy accepts empty/default lists and variadic names', async () => {
  assert.deepEqual(
    (
      await checkCursorSettings(
        await temporaryDirectory(),
        ['--setting-sources', '', '--tools', ''],
        {},
      )
    ).tools,
    [],
  );
  assert.equal(
    (
      await checkCursorSettings(
        await temporaryDirectory(),
        ['--setting-sources=', '--tools', 'default'],
        {},
      )
    ).tools,
    undefined,
  );
  assert.deepEqual(
    (
      await checkCursorSettings(
        await temporaryDirectory(),
        ['--setting-sources=', '--tools', 'Read', 'Grep'],
        {},
      )
    ).tools,
    ['Read', 'Grep'],
  );
});

test('native settings admission discovers macOS managed preferences', async () => {
  const commands: string[][] = [];
  const policy = await checkCursorSettings(
    '/workspace',
    ['--setting-sources='],
    {},
    {
      platform: 'darwin',
      runCommand: async (command, args) => {
        commands.push([command, ...args]);
        return JSON.stringify({ permissions: { deny: ['Bash'] } });
      },
      readDir: async () => {
        const error = new Error('missing') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      },
      readFile: (async () => {
        const error = new Error('missing') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }) as unknown as typeof fs.readFile,
    },
  );
  assert.deepEqual(policy.disallowedTools, ['Bash']);
  assert.deepEqual(commands, [['defaults', 'read', 'com.anthropic.claudecode']]);
});

test('native settings admission discovers Windows HKLM and HKCU registry policies', async () => {
  const commands: string[][] = [];
  const policy = await checkCursorSettings(
    'C:\\workspace',
    ['--setting-sources='],
    {},
    {
      platform: 'win32',
      runCommand: async (command, args) => {
        commands.push([command, ...args]);
        if (args[0] === 'query' && args[1]?.startsWith('HKLM')) {
          return 'HKEY_LOCAL_MACHINE\\\\SOFTWARE\\\\Policies\\\\ClaudeCode\\n    Settings    REG_SZ    {"permissions":{"deny":["Write"]}}';
        }
        return '';
      },
      readDir: async () => {
        const error = new Error('missing') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      },
      readFile: (async () => {
        const error = new Error('missing') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }) as unknown as typeof fs.readFile,
    },
  );
  assert.deepEqual(policy.disallowedTools, ['Write']);
  assert.equal(commands.length, 2);
  assert.match(commands[0].join(' '), /HKLM.*ClaudeCode/);
  assert.match(commands[1].join(' '), /HKCU.*ClaudeCode/);
});

test('native settings admission treats WSL as Linux managed file discovery', async () => {
  const files = new Map([
    ['/etc/claude-code/managed-settings.json', '{"permissions":{"deny":["Read"]}}'],
  ]);
  const policy = await checkCursorSettings(
    '/workspace',
    ['--setting-sources='],
    {},
    {
      platform: 'linux',
      osRelease: '6.1.0-microsoft-standard-WSL2',
      readDir: async () => {
        const error = new Error('missing') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      },
      readFile: (async (file: Parameters<typeof fs.readFile>[0]) => {
        const value = files.get(String(file));
        if (value !== undefined) {
          return value;
        }
        const error = new Error('missing') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }) as unknown as typeof fs.readFile,
    },
  );
  assert.deepEqual(policy.disallowedTools, ['Read']);
});
