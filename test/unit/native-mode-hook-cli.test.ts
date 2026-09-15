import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PermissionModes } from '../../plugins/multi-core/src/gateway/mode-hook.ts';
import { createNativeGateway } from '../../plugins/multi-core/src/gateway/server.ts';

const hook = fileURLToPath(
  new URL('../../plugins/multi-core/src/gateway/mode-hook.ts', import.meta.url),
);
const snapshot = {
  hook_event_name: 'UserPromptSubmit',
  session_id: 'fixture',
  permission_mode: 'plan',
  prompt: 'PRIVATE_PROMPT',
};

async function invoke(
  endpoint?: string,
  token = 'fixture-secret',
  input: unknown = snapshot,
  pendingDirectory?: string,
) {
  const directory =
    pendingDirectory ?? (await mkdtemp(path.join(os.tmpdir(), 'mode-pending-test-')));
  const child = spawn(process.execPath, [hook, endpoint ?? '', directory], {
    env: {
      PATH: process.env.PATH,
      MULTI_GATEWAY_TOKEN: token,
      ANTHROPIC_BASE_URL: 'https://invalid.example/PRIVATE_URL',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(JSON.stringify(input));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (!pendingDirectory) {
    await rm(directory, { recursive: true, force: true });
  }
  assert.doesNotMatch(stderr, /PRIVATE_PROMPT|PRIVATE_URL|fixture-secret/);
  if (code !== 0) {
    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /Relaunch through the updated Multi launcher/);
  }
  return { code, stdout, stderr };
}

test('mode hook validates control address and token without leaking input or API overrides', async () => {
  for (const endpoint of [
    undefined,
    'https://127.0.0.1:1234/multi/mode',
    'http://localhost:1234/multi/mode',
    'http://127.0.0.1:1234/multi/mode?PRIVATE_URL',
    'http://user:fixture-secret@127.0.0.1:1234/multi/mode',
    'http://127.0.0.1:0/multi/mode',
    'http://127.0.0.1:99999/multi/mode',
  ]) {
    const result = await invoke(endpoint);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /endpoint=\(invalid or missing\)/);
  }
  for (const token of ['', 'invalid\nsecret']) {
    assert.match(
      (await invoke('http://127.0.0.1:1234/multi/mode', token)).stderr,
      /invalid gateway token/,
    );
  }
});

test('mode hook posts repeated authenticated snapshots and reports HTTP validation failures', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mode-sync-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const run = (endpoint?: string, token?: string, input?: unknown) =>
    invoke(endpoint, token, input, directory);
  const modes = new PermissionModes(async () => ({ worker: { tools: ['Read'] } }), directory);
  const server = createNativeGateway({
    token: 'fixture-secret',
    authFile: 'unused',
    permissionModes: modes,
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}/multi/mode`;
  for (const permission_mode of ['plan', 'auto', 'plan']) {
    assert.deepEqual(await run(endpoint, undefined, { ...snapshot, permission_mode }), {
      code: 0,
      stdout: '{}\n',
      stderr: '',
    });
    assert.equal(modes.resolve('fixture').permissionMode, permission_mode);
  }
  assert.match((await run(endpoint, 'wrong')).stderr, /event=UserPromptSubmit.*HTTP 403/);
  assert.throws(
    () => modes.resolve('fixture'),
    /sync is incomplete/,
    'An older Plan snapshot cannot survive a failed update',
  );
  assert.match(
    (await run(endpoint, undefined, { ...snapshot, permission_mode: 'PRIVATE_PROMPT' })).stderr,
    /HTTP 400/,
  );
  assert.throws(() => modes.resolve('fixture'), /sync is incomplete/);
  assert.equal((await run(endpoint)).code, 0);
  assert.equal(
    (
      await run(endpoint, undefined, {
        ...snapshot,
        hook_event_name: 'PreCompact',
        cwd: '/fixture',
        trigger: 'manual',
      })
    ).code,
    0,
  );
  assert(modes.resolve('fixture').compaction);
  assert.equal(
    (
      await run(endpoint, undefined, {
        ...snapshot,
        hook_event_name: 'SubagentStart',
        agent_id: 'child',
        agent_type: 'worker',
        cwd: '/fixture',
      })
    ).code,
    0,
  );
  assert.deepEqual(modes.resolve('fixture', 'child').tools, ['Read']);
  await run(endpoint, 'wrong', {
    ...snapshot,
    hook_event_name: 'SubagentStart',
    agent_id: 'child',
  });
  assert.throws(() => modes.resolve('fixture', 'child'), /sync is incomplete/);
  assert.equal(
    modes.resolve('fixture').permissionMode,
    'plan',
    'Worker failures do not invalidate the parent',
  );
});

test('mode hook rejects redirects, times out and identifies refused connections', async (t) => {
  let status = 302;
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    if (status === 0) {
      return;
    }
    response.writeHead(status, { location: 'http://127.0.0.1:1/PRIVATE_URL' });
    response.end('PRIVATE_PROMPT fixture-secret');
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}/multi/mode`;
  assert.match((await invoke(endpoint)).stderr, /HTTP 302 \(redirect rejected\)/);
  assert.equal(requests, 1);
  status = 0;
  assert.match((await invoke(endpoint)).stderr, /timeout after 5000ms/);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.match((await invoke(endpoint)).stderr, /transport ECONNREFUSED/);
});
