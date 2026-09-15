import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  setup as installSetup,
  uninstall as installUninstall,
} from '../../plugins/multi-core/src/install/installation.ts';
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
  const platform = process.platform;
  const windows = platform === 'win32';
  const home = path.join(directory, "home with spaces and 'quotes'");
  await mkdir(home);
  const shell = windows
    ? path.join(home, 'profile.ps1')
    : path.join(home, process.platform === 'darwin' ? '.zshrc' : '.bashrc');
  await writeFile(
    shell,
    windows ? '# user settings\r\n' : '# user settings\nexport EXISTING=retained\n',
  );
  const listing = path.join(directory, 'plugins.json');
  await writeFile(listing, '[]');
  const source = path.join(directory, 'real-claude.js');
  const script = `const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('plugin') && args.includes('list')) {
  console.log(fs.readFileSync(process.env.TEST_PLUGIN_LIST, 'utf8'));
} else {
  console.log(JSON.stringify({native:true,args}));
  process.exitCode = Number(process.env.TEST_EXIT || 0);
}
`;
  await writeFile(source, script);
  const real = windows
    ? path.join(directory, 'real-claude.cmd')
    : path.join(directory, 'real-claude');
  if (windows) {
    await writeFile(real, `@"${process.execPath}" "${source}" %*\r\n`);
  } else {
    await writeFile(real, `#!${process.execPath}\n${script}`, { mode: 0o755 });
  }
  const env = windows
    ? {
        PATH: process.env.PATH,
        HOME: home,
        USERPROFILE: home,
        ComSpec: process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe',
        PSModulePath: process.env.PSModulePath ?? path.join(home, 'PowerShell', 'Modules'),
        PROFILE: shell,
        TEST_PLUGIN_LIST: listing,
      }
    : {
        PATH: process.env.PATH,
        HOME: home,
        SHELL: process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash',
        TEST_PLUGIN_LIST: listing,
      };
  const install = () => execute(process.execPath, [setup, '--claude', real], { env });
  const bin = path.join(home, '.local/share/multi-cli/bin');
  const invoke = (name: string, args: string[], extra: Record<string, string> = {}) =>
    execute(path.join(bin, windows ? `${name}.cmd` : name), args, {
      env: { ...env, ...extra },
      shell: windows,
      timeout: 20000,
    });
  return { directory, home, shell, listing, real, env, install, invoke, windows };
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
  const laterEdit = f.windows ? '# later user edit\r\n' : '# later user edit\n';
  await writeFile(f.shell, `${once}${laterEdit}`);
  const reply = JSON.parse((await f.invoke('claude-multi', ['hello world'])).stdout);
  assert.deepEqual(reply, { native: true, args: ['hello world'] });
  await f.invoke('multi', ['uninstall']);
  const original = f.windows
    ? '# user settings\r\n'
    : '# user settings\nexport EXISTING=retained\n';
  assert.equal(await readFile(f.shell, 'utf8'), `${original}${laterEdit}`);
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

test('Windows installation writes quoted PowerShell and cmd shims and uninstalls exactly', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'multi-win-install-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, "home with spaces and 'quotes'");
  await mkdir(home, { recursive: true });
  const profile = path.join(home, 'profile.ps1');
  await writeFile(profile, '# existing profile\r\n');
  const state = await installSetup('powershell', process.execPath, {
    platform: 'win32',
    homedir: home,
    env: { PATH: '', PATHEXT: '.COM;.EXE;.BAT;.CMD', PROFILE: profile },
  });
  const bin = path.join(home, '.local', 'share', 'multi-cli', 'bin');
  const cmd = await readFile(path.join(bin, 'claude-multi.cmd'), 'utf8');
  const ps = await readFile(path.join(bin, 'claude-multi.ps1'), 'utf8');
  assert.match(cmd, /process\\.execPath|node/);
  assert.match(ps, /''quotes''|quotes/);
  assert.match(state.block, /\$env:Path/);
  await installUninstall(path.dirname(bin));
  assert.equal(await readFile(profile, 'utf8'), '# existing profile\r\n');
  await assert.rejects(readFile(path.join(bin, 'claude-multi.cmd')), /ENOENT/);
});

test('Windows executable discovery uses PATHEXT and does not require mode bits', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'multi-win-resolution-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, 'home');
  const bin = path.join(home, 'npm global bin');
  await mkdir(bin, { recursive: true });
  const claude = path.join(bin, 'claude.CMD');
  await writeFile(claude, 'shim');
  const state = await installSetup('pwsh', claude, {
    platform: 'win32',
    homedir: home,
    env: { PATH: bin, PATHEXT: '.CMD', PROFILE: path.join(home, 'profile.ps1') },
  });
  assert.equal(state.claude, claude);
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
