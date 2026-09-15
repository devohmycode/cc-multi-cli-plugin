import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

test('launcher discovers GPT review with Claude subscription, API credentials, or no Claude login', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'reviewer-discovery-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const bin = path.join(cwd, 'bin');
  await mkdir(bin);
  await writeFile(
    path.join(cwd, 'auth.json'),
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'codex-fixture', account_id: 'fixture' },
    }),
  );
  await writeFile(
    path.join(bin, 'claude'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('plugin') && args.includes('list')) { console.log('[]'); process.exit(0); }
if (args[0] === '--version') { console.log('2.1.272'); process.exit(0); }
const emit = (value) => {
  const base = process.env.MULTI_MOD_GATEWAY_URL;
  if (!base) { console.log(value); return; }
  const req = require('node:http').request(new URL(base + '/multi/mod/session'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-multi-gateway-token': process.env.MULTI_GATEWAY_TOKEN },
  }, () => console.log(value));
  req.on('error', () => console.log(value));
  req.end(JSON.stringify({ sessionId: 'fixture', event: 'start' }));
};
if (args[0] === 'auth') {
  console.log(JSON.stringify({loggedIn: process.env.TEST_AUTH === 'yes'}));
  process.exit(process.env.TEST_AUTH === 'yes' ? 0 : 1);
}
emit(fs.readFileSync(args[args.indexOf('--settings') + 1], 'utf8'));
`,
    { mode: 0o755 },
  );
  const preload = path.join(cwd, 'preload.mjs');
  const calls = path.join(cwd, 'calls.jsonl');
  await writeFile(
    preload,
    `import {appendFileSync} from 'node:fs';
globalThis.fetch = async (url, init) => {
  if (!String(url).includes('/backend-api/codex/models?')) throw Error('Unexpected upstream request');
  appendFileSync(${JSON.stringify(calls)}, JSON.stringify({url, headers: init.headers}) + '\\n');
  return Response.json({models: process.env.TEST_REVIEW === 'yes' ? [{slug: 'codex-auto-review'}] : []});
};
`,
  );
  const launcher = fileURLToPath(
    new URL('../../plugins/multi-core/src/launcher.ts', import.meta.url),
  );
  for (const auth of ['yes', 'api', 'no']) {
    for (const review of ['yes', 'no']) {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          '--import',
          pathToFileURL(preload).href,
          launcher,
          '--',
          '--model',
          'multi/openai/gpt-6-astra',
        ],
        {
          cwd,
          timeout: 20000,
          env: {
            PATH: `${bin}${path.delimiter}${process.env.PATH}`,
            HOME: cwd,
            CLAUDE_CONFIG_DIR: path.join(cwd, 'claude'),
            CODEX_HOME: cwd,
            MULTI_ENABLED_PROVIDERS: 'openai',
            TEST_AUTH: auth,
            TEST_REVIEW: review,
            ...(auth === 'api' ? { ANTHROPIC_API_KEY: 'anthropic-fixture' } : {}),
          },
        },
      );
      const settings = JSON.parse(stdout);
      assert.equal(settings.permissions?.disableAutoMode, review === 'yes' ? undefined : 'disable');
      assert.equal(settings.hooks.PreToolUse.length, 1);
    }
  }
  const catalogCalls = (await readFile(calls, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(catalogCalls.length, 6);
  for (const call of catalogCalls) {
    assert.equal(call.headers.authorization, 'Bearer codex-fixture');
    assert(!JSON.stringify(call).includes('anthropic-fixture'));
  }
});
