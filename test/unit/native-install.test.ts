import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  providerSelection,
  settingsArguments,
} from '../../plugins/multi-core/src/install/plugins.ts';

const execute = promisify(execFile);
const setup = fileURLToPath(new URL('../../plugins/multi-core/src/setup.ts', import.meta.url));
const marketplace = 'cc-multi-cli-plugin';

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'multi-install-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, "home with spaces and 'quotes'");
  await mkdir(home);
  const shell = path.join(home, '.bashrc');
  await writeFile(shell, '# user settings\nexport EXISTING=retained\n');
  const listing = path.join(directory, 'plugins.json');
  await writeFile(listing, '[]');
  const real = path.join(directory, 'real-claude');
  await writeFile(
    real,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('plugin') && args.includes('list')) {
  console.log(fs.readFileSync(process.env.TEST_PLUGIN_LIST, 'utf8'));
} else {
  console.log(JSON.stringify({native:true,args}));
  process.exitCode = Number(process.env.TEST_EXIT || 0);
}
`,
    { mode: 0o755 },
  );
  const env = { PATH: process.env.PATH, HOME: home, SHELL: '/bin/bash', TEST_PLUGIN_LIST: listing };
  const install = () => execute(process.execPath, [setup, '--claude', real], { env });
  const bin = path.join(home, '.local/share/multi-cli/bin');
  const invoke = (name: string, args: string[], extra: Record<string, string> = {}) =>
    execute(path.join(bin, name), args, { env: { ...env, ...extra }, timeout: 20000 });
  return { directory, home, shell, listing, real, env, install, invoke };
}

async function core(directory: string, name: string) {
  const root = path.join(directory, name);
  await mkdir(path.join(root, '.claude-plugin'), { recursive: true });
  await writeFile(
    path.join(root, '.claude-plugin/plugin.json'),
    JSON.stringify({ name: 'multi-core' }),
  );
  const src = path.join(root, 'plugins/multi-core/src');
  await mkdir(src, { recursive: true });
  await writeFile(
    path.join(src, 'launcher.ts'),
    `console.log(JSON.stringify({root:import.meta.url,args:process.argv.slice(2),providers:process.env.MULTI_ENABLED_PROVIDERS,claude:process.env.MULTI_REAL_CLAUDE}));`,
  );
  return root;
}

function plugins(root: string, zen = true) {
  return [
    { id: `multi-core@${marketplace}`, enabled: true, scope: 'user', installPath: root },
    {
      id: `multi-zen@${marketplace}`,
      enabled: zen,
      scope: 'user',
      installPath: path.join(root, 'zen'),
    },
    {
      id: `multi-cursor@${marketplace}`,
      enabled: false,
      scope: 'user',
      installPath: path.join(root, 'cursor'),
    },
  ];
}

test('setup preserves shell content, is repeatable, and uninstall survives plugin removal', async (t) => {
  const f = await fixture(t);
  await f.install();
  const once = await readFile(f.shell, 'utf8');
  await f.install();
  assert.equal(await readFile(f.shell, 'utf8'), once);
  await writeFile(f.shell, `${once}# later user edit\n`);
  const reply = JSON.parse((await f.invoke('claude-multi', ['hello world'])).stdout);
  assert.deepEqual(reply, { native: true, args: ['hello world'] });
  await f.invoke('multi', ['uninstall']);
  assert.equal(
    await readFile(f.shell, 'utf8'),
    '# user settings\nexport EXISTING=retained\n# later user edit\n',
  );
  await assert.rejects(f.invoke('claude-multi', []), /ENOENT/);
  await f.install();
  assert.equal(JSON.parse((await f.invoke('claude-multi', [])).stdout).native, true);
});

test('wrapper follows installed core updates and enables only selected providers', async (t) => {
  const f = await fixture(t);
  await f.install();
  const old = await core(f.directory, 'core-v1');
  await writeFile(f.listing, JSON.stringify(plugins(old)));
  const args = ['--settings', '{"model":"sonnet"}', '--', 'literal $() and spaces'];
  const first = JSON.parse((await f.invoke('claude-multi', args)).stdout);
  assert.deepEqual(first.args, args);
  assert.equal(first.providers, 'zen');
  assert.equal(first.claude, f.real);
  const next = path.join(f.directory, 'core-v2');
  await cp(old, next, { recursive: true });
  await rm(old, { recursive: true });
  await writeFile(f.listing, JSON.stringify(plugins(next)));
  assert.match(JSON.parse((await f.invoke('claude-multi', [])).stdout).root, /core-v2/);
  await writeFile(f.listing, JSON.stringify(plugins(next, false)));
  assert.equal(JSON.parse((await f.invoke('claude-multi', [])).stdout).native, true);
});

test('edited shell blocks and project-only executable cores fail explicitly', async (t) => {
  const f = await fixture(t);
  await f.install();
  const current = await readFile(f.shell, 'utf8');
  await writeFile(f.shell, current.replace('export PATH=', '# changed PATH='));
  await assert.rejects(f.invoke('multi', ['uninstall']), /was edited/);
  await assert.rejects(f.install(), /was edited/);
  const entries = plugins(await core(f.directory, 'project-core'));
  entries[0].scope = 'project';
  await writeFile(f.listing, JSON.stringify(entries));
  await assert.rejects(f.invoke('claude-multi', []), /user scope/);
});

test('provider selection and native settings arguments preserve explicit disablement', () => {
  assert.equal(providerSelection(undefined), undefined);
  assert.deepEqual(providerSelection(''), []);
  assert.deepEqual(providerSelection('zen,zen,openai'), ['zen', 'openai']);
  assert.throws(() => providerSelection('typo'), /Unknown Multi provider/);
  assert.deepEqual(
    settingsArguments([
      '--model',
      'sonnet',
      '--settings={"enabledPlugins":{}}',
      '--setting-sources',
      'user',
      '--',
      '--settings=x',
    ]),
    ['--settings={"enabledPlugins":{}}', '--setting-sources', 'user'],
  );
  assert.throws(() => settingsArguments(['--settings']), /requires a value/);
});
