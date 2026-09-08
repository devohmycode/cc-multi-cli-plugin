import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

test('launcher preserves native auth, disables unavailable auto mode, and merges caller settings', {
  skip: process.platform === 'win32',
}, async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'launcher-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(path.join(cwd, 'bin'));
  await writeFile(
    path.join(cwd, 'bin', 'claude'),
    `#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2);
if(args[0]==='auth'){if(process.env.TEST_AUTH==='malformed'){console.log('not-json');process.exit(0)}if(process.env.TEST_AUTH==='error'){process.exit(2)}if(process.env.TEST_AUTH==='missing'){console.log('{}');process.exit(0)}process.stdout.write(JSON.stringify({loggedIn:process.env.TEST_AUTH==='yes'}));process.exitCode=process.env.TEST_AUTH==='yes'?0:1}else{
const settings=JSON.parse(fs.readFileSync(args[args.indexOf('--settings')+1],'utf8'));
 console.log(JSON.stringify({settings,models:args.filter(x=>x.startsWith('multi/')),settingsCount:args.filter(x=>x==='--settings').length,hasLocalToken:!!process.env.MULTI_GATEWAY_TOKEN,auth:process.env.ANTHROPIC_API_KEY?'api':process.env.ANTHROPIC_AUTH_TOKEN?'local':'native'}));}
`,
    { mode: 0o755 },
  );
  const launcher = fileURLToPath(
    new URL('../../plugins/multi/src/native-model-gateway.ts', import.meta.url),
  );
  for (const auth of ['no', 'yes', 'api']) {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        launcher,
        '--',
        '--model',
        'multi/cursor/auto',
        '--settings',
        JSON.stringify({ permissions: { deny: ['Bash(denied)'] }, hooks: { Stop: [] } }),
      ],
      {
        cwd,
        timeout: 20000,
        env: {
          PATH: path.join(cwd, 'bin') + path.delimiter + process.env.PATH,
          HOME: cwd,
          CLAUDE_CONFIG_DIR: path.join(cwd, 'claude'),
          CODEX_HOME: cwd,
          TEST_AUTH: auth,
          ...(auth === 'api' ? { ANTHROPIC_API_KEY: 'fake-test-key' } : {}),
        },
      },
    );
    const result = JSON.parse(stdout);
    assert.equal(result.settingsCount, 1);
    assert.deepEqual(result.settings.permissions.deny, ['Bash(denied)']);
    assert.equal(
      result.settings.permissions.disableAutoMode,
      auth === 'no' ? 'disable' : undefined,
    );
    assert.equal(result.hasLocalToken, auth === 'no');
    assert.equal(result.auth, { no: 'local', api: 'api', yes: 'native' }[auth]);
    assert.equal(result.settings.hooks.PreToolUse?.length, auth === 'no' ? 1 : undefined);
  }
  for (const auth of ['malformed', 'error', 'missing']) {
    await assert.rejects(
      promisify(execFile)(process.execPath, [launcher, '--', '--model', 'multi/cursor/auto'], {
        cwd,
        timeout: 20000,
        env: {
          PATH: path.join(cwd, 'bin') + path.delimiter + process.env.PATH,
          HOME: cwd,
          CLAUDE_CONFIG_DIR: path.join(cwd, 'claude'),
          CODEX_HOME: cwd,
          TEST_AUTH: auth,
        },
      }),
      /Claude auth status probe (returned invalid JSON|failed|returned no boolean loggedIn field)/,
    );
  }
  await mkdir(path.join(cwd, 'claude'));
  await writeFile(
    path.join(cwd, 'claude', 'settings.json'),
    JSON.stringify({ model: 'multi/cursor/auto' }),
  );
  const { stdout } = await promisify(execFile)(process.execPath, [launcher], {
    cwd,
    timeout: 20000,
    env: {
      PATH: path.join(cwd, 'bin') + path.delimiter + process.env.PATH,
      HOME: cwd,
      CLAUDE_CONFIG_DIR: path.join(cwd, 'claude'),
      CODEX_HOME: cwd,
    },
  });
  const saved = JSON.parse(stdout);
  assert.deepEqual(
    saved.models,
    [],
    'Keep the native saved model instead of forcing a launcher default',
  );
  assert.equal(saved.settings.permissions.disableAutoMode, 'disable');
});
