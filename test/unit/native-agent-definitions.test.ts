import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { loadWorkerPermissions } from '../../plugins/multi-core/src/gateway/agent-definitions.ts';
import { cursorPermissionPolicy } from '../../plugins/multi-cursor/src/permissions.ts';

async function writeAgent(directory: string, name: string, source: string) {
  const agents = path.join(directory, '.claude', 'agents');
  await mkdir(agents, { recursive: true });
  await writeFile(path.join(agents, `${name}.md`), source);
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

test('loads configured user and nested project definitions in precedence order, then CLI definitions', async (t) => {
  const previousConfig = process.env.CLAUDE_CONFIG_DIR;
  const home = await mkdtemp(path.join(os.tmpdir(), 'agent-home-'));
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-project-'));
  const cwd = path.join(root, 'nested');
  process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
  t.after(() => {
    process.env.CLAUDE_CONFIG_DIR = previousConfig;
  });
  await mkdir(path.join(root, '.git'));
  await mkdir(cwd);
  await writeAgent(
    home,
    'worker',
    '---\nname: worker\ndescription: user\npermissionMode: plan\ntools: Read, Grep\n---\n',
  );
  await writeAgent(
    root,
    'worker',
    '---\nname: worker\ndescription: root\npermissionMode: auto\ndisallowedTools: [Write, Edit]\n---\n',
  );
  await writeAgent(
    cwd,
    'worker',
    '---\nname: worker\ndescription: nested\npermissionMode: dontAsk\ntools: [Read, Glob]\n---\n',
  );
  await writeAgent(
    cwd,
    'nested',
    '---\nname: nested\ndescription: nested\ntools: Read, Bash\n---\n',
  );
  const definitions = await loadWorkerPermissions(cwd, { worker: { permissionMode: 'plan' } });
  assert.deepEqual(definitions.worker, { permissionMode: 'plan' });
  assert.deepEqual(definitions.nested, {
    tools: ['Read', 'Bash'],
    disallowedTools: undefined,
    permissionMode: undefined,
  });
  assert.deepEqual(definitions.Explore, { disallowedTools: ['Write', 'Edit'] });
  assert.deepEqual(definitions.Plan, { disallowedTools: ['Write', 'Edit'] });
  assert.deepEqual(definitions['general-purpose'], {});
});

test('rejects malformed relevant agent frontmatter', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-project-'));
  await mkdir(path.join(root, '.git'));
  await writeAgent(root, 'bad', '---\nname: bad\ndescription: bad\npermissionMode: unsafe\n---\n');
  await assert.rejects(loadWorkerPermissions(root, {}), /invalid permissionMode/);
});

test('keeps an agent named __proto__ as data', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-project-'));
  await mkdir(path.join(root, '.git'));
  await writeAgent(root, 'proto', '---\nname: __proto__\ndescription: data\ntools: Read\n---\n');
  const definitions = await loadWorkerPermissions(root, {});
  assert.equal(Object.getPrototypeOf(definitions), null);
  assert.deepEqual(Object.getOwnPropertyDescriptor(definitions, '__proto__')?.value, {
    tools: ['Read'],
    disallowedTools: undefined,
    permissionMode: undefined,
  });
});

test('discovers scoped plugin workers, manifest replacement paths and inherited project scope', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'plugin-agents-'));
  const cwd = path.join(root, 'nested');
  await mkdir(cwd);
  await mkdir(path.join(root, '.claude-plugin'));
  await mkdir(path.join(root, 'agents'));
  await writeFile(
    path.join(root, 'agents', 'ignored.md'),
    '---\nname: ignored\ndescription: ignored\n---\n',
  );
  await writeFile(
    path.join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'fixture', agents: ['./reader.md'] }),
  );
  await writeFile(
    path.join(root, 'reader.md'),
    '---\nname: reader\ndescription: reader\ntools: Read, Grep\npermissionMode: bypassPermissions\n---\n',
  );
  inventory = [
    { id: 'fixture@inline', enabled: true, installPath: root, projectPath: root },
    { id: 'disabled@test', enabled: false, installPath: '/does-not-exist' },
    {
      id: 'elsewhere@test',
      enabled: true,
      installPath: '/does-not-exist',
      projectPath: '/elsewhere',
    },
  ];
  const definitions = await loadWorkerPermissions(cwd, {}, ['--plugin-dir', root]);
  assert.deepEqual(definitions['fixture:reader'], {
    tools: ['Read', 'Grep'],
    disallowedTools: undefined,
  });
  assert.equal(definitions['fixture:ignored'], undefined);
  await writeFile(path.join(root, 'reader.md'), '---\ntools: [Read\n---\n');
  await assert.rejects(loadWorkerPermissions(cwd, {}), /Malformed plugin agent/);
});

test('rejects enabled plugin permission hooks instead of bypassing their policy', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'plugin-hooks-'));
  await mkdir(path.join(root, 'hooks'));
  await writeFile(
    path.join(root, 'hooks', 'hooks.json'),
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [] }] } }),
  );
  inventory = [{ id: 'guard@test', enabled: true, installPath: root }];
  await assert.rejects(loadWorkerPermissions(root, {}), /cannot enforce Claude hooks.PreToolUse/);
});

test('worker permission hooks mark only their own definition unavailable to native execution', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'worker-hooks-'));
  await writeAgent(
    root,
    'guarded',
    '---\nname: guarded\ndescription: guarded\nhooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks: []\n---\n',
  );
  await writeAgent(
    root,
    'ordinary',
    '---\nname: ordinary\ndescription: ordinary\ntools: Read\n---\n',
  );
  const definitions = await loadWorkerPermissions(root, {});
  assert.match(
    definitions.guarded.nativePermissionError ?? '',
    /cannot honor worker hooks.*guarded.md/,
  );
  assert.equal(definitions.ordinary.nativePermissionError, undefined);
  assert.deepEqual(definitions.ordinary.tools, ['Read']);
  assert.equal(definitions['general-purpose'].nativePermissionError, undefined);
  assert.throws(
    () => cursorPermissionPolicy({ ...definitions.guarded, permissionMode: 'auto' }),
    /cannot honor worker hooks/,
  );
  assert.doesNotThrow(() =>
    cursorPermissionPolicy({ ...definitions.ordinary, permissionMode: 'auto' }),
  );
});
