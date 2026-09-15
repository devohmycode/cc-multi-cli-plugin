import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import {
  antigravityCompactionDenyList,
  antigravityPermissionPolicy,
} from '../../plugins/multi-antigravity/src/permissions.ts';
import {
  ModCompactions,
  type SummaryRequest,
} from '../../plugins/multi-core/src/gateway/mod-compaction.ts';

const input = {
  session: 's',
  generation: 1,
  messages: [{ role: 'user', text: 'task', handle: 'one' }],
};
const context = { permissionMode: 'bypassPermissions' as const, cwd: '/workspace' };

async function ready() {
  const store = new ModCompactions(async () => 'Preserved task');
  const prepared = store.prepare(input);
  store.run(input, prepared.precomputeId, context);
  await setImmediate();
  return store;
}

test('compaction consumes only a matching prefix and preserves the appended tail', async () => {
  const store = await ready();
  const tail = { role: 'assistant', text: 'new', handle: 'two' };
  const result = store.authorize({ ...input, messages: [...input.messages, tail] });
  assert.equal(result.messages?.[0].text, 'Conversation summary:\nPreserved task');
  assert.deepEqual(result.messages?.[1], tail);
  assert.deepEqual(store.authorize(input), { allow: true }, 'summary is single-use');
});

test('compaction rejects edited leading transcript, instructions, generation and worker scope', async () => {
  for (const changed of [
    { ...input, messages: [{ ...input.messages[0], text: 'edited' }] },
    { ...input, instructions: 'different instructions' },
    { ...input, generation: 2 },
    { ...input, agent: 'other' },
  ]) {
    const store = await ready();
    assert.deepEqual(store.authorize(changed), { allow: true });
  }
});

test('detaching cancels speculative summaries and discards late completions', async () => {
  let complete: ((value: string) => void) | undefined;
  let signal: AbortSignal | undefined;
  const store = new ModCompactions((request) => {
    signal = request.signal;
    return new Promise((resolve) => {
      complete = resolve;
    });
  });
  const prepared = store.prepare(input);
  store.run(input, prepared.precomputeId, context);
  store.cancel(input.session);
  assert.equal(signal?.aborted, true);
  complete?.('late result');
  await setImmediate();
  assert.deepEqual(store.authorize(input), { allow: true });
  assert.throws(() => store.run(input, prepared.precomputeId, context), /unknown or stale/);
});

test('summary work receives zero native tool capabilities even under Bypass', async () => {
  let captured: SummaryRequest | undefined;
  const store = new ModCompactions(async (request) => {
    captured = request;
    return 'summary';
  });
  const prepared = store.prepare(input);
  store.run(input, prepared.precomputeId, context);
  assert(captured);
  assert.deepEqual(captured.context.tools, []);
  assert.equal(captured.context.compaction, prepared.precomputeId);
  const policy = antigravityPermissionPolicy(captured.context);
  assert.deepEqual(new Set(policy.denied), new Set(antigravityCompactionDenyList()));
  await setImmediate();
});

test('unknown generation cannot start work and duplicate run never repeats inference', async () => {
  let calls = 0;
  const store = new ModCompactions(async () => {
    calls++;
    return 'summary';
  });
  const prepared = store.prepare(input);
  assert.throws(
    () => store.run({ ...input, generation: 2 }, prepared.precomputeId, context),
    /unknown or stale/,
  );
  store.run(input, prepared.precomputeId, context);
  store.run(input, prepared.precomputeId, context);
  await setImmediate();
  assert.equal(calls, 1);
});
