import assert from 'node:assert/strict';
import test from 'node:test';
import { ModBridge } from '../../plugins/multi-core/src/gateway/mod-bridge.ts';
import { PermissionModes } from '../../plugins/multi-core/src/gateway/mode-hook.ts';
import { createNativeGateway } from '../../plugins/multi-core/src/gateway/server.ts';

async function start(t: test.TestContext) {
  const server = createNativeGateway({
    token: 'mod-token',
    authFile: 'unused',
    modBridge: new ModBridge(),
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

async function request(base: string, route: string, body?: unknown, method = 'POST') {
  const response = await fetch(base + route, {
    method,
    headers: { 'x-multi-gateway-token': 'mod-token', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

test('mod mode snapshots acknowledge generations and reject stale updates', async (t) => {
  const base = await start(t);
  const first = await request(base, '/multi/mod/session', {
    sessionId: 's',
    permissionMode: 'plan',
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.accepted, true);
  const stale = await request(base, '/multi/mod/session', {
    sessionId: 's',
    permissionMode: 'bypassPermissions',
    generation: 999,
  });
  assert.equal(stale.status, 409);
  const mode = await request(base, '/multi/mod/mode?sessionId=s', undefined, 'GET');
  assert.deepEqual(mode.body.effective, { permissionMode: 'plan' });
});

test('mod routes reject unauthenticated requests', async (t) => {
  const base = await start(t);
  const response = await fetch(`${base}/multi/mod/mode?sessionId=s`);
  assert.equal(response.status, 401);
});

test('PermissionModes refuses native resolution until an acknowledged prompt snapshot', () => {
  const modes = new PermissionModes(async () => ({}));
  assert.throws(() => modes.resolve('missing'), /permission mode is unavailable/);
  modes.recordModSession('session', { permissionMode: 'plan', cwd: '/tmp' });
  assert.equal(modes.resolve('session').permissionMode, 'plan');
});

test('PermissionModes retains a tool-free compaction boundary and acknowledges workers', async () => {
  const modes = new PermissionModes(async () => ({
    cursor: {
      permissionMode: 'plan',
      tools: ['Read'],
      disallowedTools: ['Bash'],
    },
  }));
  modes.recordModSession('session', { permissionMode: 'auto', cwd: '/workspace' });
  modes.recordModCompaction('session', { trigger: 'manual', cwd: '/workspace' });
  const compact = modes.resolve('session');
  assert.equal(compact.permissionMode, 'auto');
  assert.equal(typeof compact.compaction, 'string');
  const workerToken = await modes.prepareModWorker('session', {
    subagentType: 'cursor',
    permissionMode: 'auto',
    cwd: '/workspace',
  });
  modes.recordPreparedModWorker('session', 'worker', workerToken);
  assert.deepEqual(modes.resolve('session', 'worker').disallowedTools, ['Bash']);
  assert.throws(
    () => modes.recordPreparedModWorker('session', 'other', workerToken),
    /Worker policy acknowledgement is unavailable/,
  );
});
