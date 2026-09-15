import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import {
  ModPolicies,
  type PreparedPolicy,
} from '../../plugins/multi-core/src/gateway/mod-policy.ts';
import { PermissionModes } from '../../plugins/multi-core/src/gateway/mode-hook.ts';

const policy: PreparedPolicy = {
  cwd: '/workspace',
  workers: { cursor: { model: 'multi/cursor/auto', tools: ['Read'] } },
  restrictions: { disallowedTools: ['Bash'] },
};

test('policy discovery returns immediately and admits only the ready generation and workspace', async () => {
  let finish: ((value: PreparedPolicy) => void) | undefined;
  const store = new ModPolicies(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = store.begin('s', '/workspace');
  assert.equal(pending.status, 'pending');
  assert.throws(() => store.consume('s', pending.generation, '/workspace'), /not ready/);
  finish?.(policy);
  await setImmediate();
  assert.deepEqual(store.consume('s', pending.generation, '/workspace'), policy);
  assert.throws(() => store.consume('s', pending.generation, '/elsewhere'), /not ready/);
  store.forget('s');
  assert.throws(() => store.consume('s', pending.generation, '/workspace'), /stale/);
});

test('late policy discovery cannot overwrite a newer prompt generation', async () => {
  const finishes: Array<(value: PreparedPolicy) => void> = [];
  const store = new ModPolicies(
    () =>
      new Promise((resolve) => {
        finishes.push(resolve);
      }),
  );
  const old = store.begin('s', '/old');
  const latest = store.begin('s', '/workspace');
  finishes[1](policy);
  finishes[0]({ ...policy, cwd: '/old' });
  await setImmediate();
  assert.throws(() => store.consume('s', old.generation, '/old'), /stale/);
  assert.deepEqual(store.consume('s', latest.generation, '/workspace'), policy);
});

test('worker admission rejects inconsistent identity and native dispatch awaits child acknowledgement', async () => {
  const modes = new PermissionModes(async () => policy.workers);
  await modes.precompute('/workspace');
  modes.recordModSession('s', { permissionMode: 'plan', cwd: '/workspace', model: 'parent' });
  const spawn = {
    subagentType: 'cursor',
    cwd: '/workspace',
    permissionMode: 'plan',
    parentModel: 'parent',
  };
  for (const change of [
    { subagentType: 'unknown' },
    { model: 'wrong' },
    { parentModel: 'wrong' },
    { parentAgentId: 'unknown' },
    { permissionMode: 'bypassPermissions' },
    { cwd: '/other' },
  ]) {
    await assert.rejects(modes.prepareModWorker('s', { ...spawn, ...change }));
  }
  await modes.prepareModWorker('s', spawn);
  assert.throws(() => modes.resolve('s', 'worker'), /unavailable/);
  modes.startPreparedModWorker('s', 'worker', 'cursor', '/workspace');
  assert.deepEqual(modes.resolve('s', 'worker').tools, ['Read']);
  assert.throws(() => modes.startPreparedModWorker('s', 'other', 'cursor', '/workspace'), /unique/);
});

test('ambiguous simultaneous worker starts fail closed and catalog filtering preserves known workers', async () => {
  const modes = new PermissionModes(async () => ({
    ...policy.workers,
    unsupported: { nativePermissionError: 'unsupported' },
  }));
  await modes.precompute('/workspace');
  modes.recordModSession('s', { permissionMode: 'auto', cwd: '/workspace' });
  const spawn = { subagentType: 'cursor', cwd: '/workspace', permissionMode: 'auto' };
  await modes.prepareModWorker('s', spawn);
  await modes.prepareModWorker('s', spawn);
  assert.throws(
    () => modes.startPreparedModWorker('s', 'worker', 'cursor', '/workspace'),
    /unique/,
  );
  assert.equal(modes.offered('/workspace', 'cursor'), true);
  assert.equal(modes.offered('/workspace', 'unsupported'), false);
  assert.equal(modes.offered('/workspace', 'unknown'), false);
});

test('worker contexts retain the authenticated compaction deny marker and parent restrictions', async () => {
  const modes = new PermissionModes(async () => policy.workers);
  await modes.precompute('/workspace');
  modes.recordModSession('s', {
    permissionMode: 'auto',
    cwd: '/workspace',
    disallowedTools: ['Bash'],
  });
  await modes.prepareModWorker('s', {
    subagentType: 'cursor',
    cwd: '/workspace',
    permissionMode: 'auto',
  });
  modes.startPreparedModWorker('s', 'worker', 'cursor', '/workspace');
  modes.authorizeModCompaction('s');
  assert.equal(modes.resolve('s', 'worker').compaction, modes.resolve('s').compaction);
  assert.deepEqual(modes.resolve('s', 'worker').disallowedTools, ['Bash']);
  modes.forgetSession('s');
  assert.throws(() => modes.resolve('s', 'worker'), /unavailable/);
});

test('a policy discovery that outlasts the hook is reused on retry until admitted', async () => {
  let finish: ((value: PreparedPolicy) => void) | undefined;
  let discoveries = 0;
  const store = new ModPolicies(() => {
    discoveries++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const first = store.begin('s', '/workspace');
  assert.equal(store.begin('s', '/workspace').generation, first.generation);
  finish?.(policy);
  await setImmediate();
  assert.equal(store.begin('s', '/workspace').generation, first.generation);
  store.consume('s', first.generation, '/workspace');
  assert.notEqual(store.begin('s', '/workspace').generation, first.generation);
  assert.equal(discoveries, 2);
  finish?.(policy);
});

test('successful worker compaction restores ordinary restrictions without restoring a stale prompt', async () => {
  const modes = new PermissionModes(async () => policy.workers);
  await modes.precompute('/workspace');
  modes.recordModSession('s', { permissionMode: 'plan', cwd: '/workspace' });
  await modes.prepareModWorker('s', {
    subagentType: 'cursor',
    cwd: '/workspace',
    permissionMode: 'plan',
  });
  modes.startPreparedModWorker('s', 'worker', 'cursor', '/workspace');
  modes.authorizeModCompaction('s', 'worker');
  const id = modes.resolve('s', 'worker').compaction;
  assert.deepEqual(modes.resolve('s', 'worker').tools, []);
  modes.finishModCompaction('s', 'worker', id);
  assert.deepEqual(modes.resolve('s', 'worker').tools, ['Read']);
  assert.equal(modes.resolve('s', 'worker').compaction, undefined);
  modes.authorizeModCompaction('s');
  const parentId = modes.resolve('s').compaction;
  modes.recordModSession('s', { permissionMode: 'auto', cwd: '/workspace' });
  modes.finishModCompaction('s', undefined, parentId);
  assert.equal(modes.resolve('s').permissionMode, 'auto');
});
