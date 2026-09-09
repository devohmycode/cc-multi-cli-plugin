/** Real plugin-manager smoke in a temporary home. Downloads npm packages, no inference. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  access,
  cp,
  constants as fsConstants,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const repository = fileURLToPath(new URL('../../', import.meta.url));
const directory = await mkdtemp(path.join(os.tmpdir(), 'multi-installed-'));
const source = path.join(directory, 'marketplace');
const home = path.join(directory, 'home');
console.log(`Installation artifacts: ${directory}`);
await mkdir(source);
await mkdir(home);
for (const entry of [
  '.claude-plugin',
  'plugins',
  'package.json',
  'package-lock.json',
  'LICENSE',
  'NOTICE',
]) {
  await cp(path.join(repository, entry), path.join(source, entry), { recursive: true });
}
const env = {
  PATH: process.env.PATH,
  HOME: home,
  CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
  SHELL: '/bin/bash',
  npm_config_omit: 'dev',
};
async function native(args: string[]) {
  return execute('claude', args, {
    cwd: directory,
    env,
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
  });
}
await native(['plugin', 'marketplace', 'add', source]);
const installation = await native([
  'plugin',
  'install',
  'multi-zen@cc-multi-cli-plugin',
  '--scope',
  'user',
]);
console.log(installation.stdout.trim());
const listing = await native(['plugin', 'list', '--json']);
await writeFile(path.join(directory, 'installed.json'), listing.stdout);
const plugins: { id: string; enabled: boolean; installPath: string }[] = JSON.parse(listing.stdout);
const core = plugins.find((plugin) => plugin.id === 'multi-core@cc-multi-cli-plugin');
assert(core?.enabled, 'Provider installation must install and enable core');
const launcher = path.join(core.installPath, 'plugins/multi-core/src/launcher.ts');
await rename(source, `${source}-removed`);
const catalog = await execute(process.execPath, [launcher, '--zen-models'], {
  cwd: directory,
  env,
  timeout: 30000,
});
assert(JSON.parse(catalog.stdout).some((model: { id: string }) => model.id === 'kimi-k3'));
await rename(`${source}-removed`, source);

// Exercise the real cached gateway and picker, replacing only the outer Claude UI.
const fake = path.join(directory, 'claude-fixture');
await writeFile(
  fake,
  `#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2);
if(args[0]==='auth'){console.log(JSON.stringify({loggedIn:false}));process.exitCode=1}else{
const settings=JSON.parse(fs.readFileSync(args[args.indexOf('--settings')+1],'utf8'));
console.log(JSON.stringify(settings.modelPicker.options.map(x=>x.model)));}
`,
  { mode: 0o755 },
);
const launched = await execute(process.execPath, [launcher], {
  cwd: directory,
  timeout: 30000,
  env: {
    ...env,
    MULTI_REAL_CLAUDE: fake,
    MULTI_ENABLED_PROVIDERS: 'zen',
    OPENCODE_API_KEY: 'fixture-key',
  },
});
const models: string[] = JSON.parse(launched.stdout);
assert(models.length > 0 && models.every((model) => model.startsWith('multi/zen/')));

await execute(process.execPath, [path.join(core.installPath, 'plugins/multi-core/src/setup.ts')], {
  env,
  cwd: directory,
});
const bin = path.join(home, '.local/share/multi-cli/bin');
await access(path.join(bin, 'claude-multi'), fsConstants.X_OK);
// Setup must never write a bin/claude that would shadow the real claude command.
await assert.rejects(access(path.join(bin, 'claude'), fsConstants.X_OK));
const multi = path.join(bin, 'multi');
const status = await execute(multi, ['status'], { env, cwd: directory });
assert.deepEqual(JSON.parse(status.stdout).providers, ['zen']);
const disabled = await execute(
  multi,
  [
    'status',
    '--settings',
    JSON.stringify({ enabledPlugins: { 'multi-zen@cc-multi-cli-plugin': false } }),
  ],
  { env, cwd: directory },
);
assert.deepEqual(JSON.parse(disabled.stdout).providers, []);
await execute(multi, ['uninstall'], { env, cwd: directory });
assert.equal(await readFile(path.join(home, '.bashrc'), 'utf8'), '');
console.log(
  'PASS: core dependency, isolated cache, gateway picker, native enablement, claude-multi without shadowing claude, setup and uninstall. No inference requests.',
);
