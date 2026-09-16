import assert from 'node:assert/strict';
import test from 'node:test';
import { ReceiptLedger } from '../../plugins/multi-core/src/gateway/receipts.ts';
import type { GatewayEvent } from '../../plugins/multi-core/src/gateway/server.ts';

const completion: GatewayEvent = {
  route: 'openai',
  endpoint: 'responses',
  session: 'session-1',
  agentId: 'worker-7',
  model: 'gpt-6-astra',
  effort: 'high',
  stopReason: 'end_turn',
  tools: ['Read'],
  usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 100 },
};

test('ledger aggregates an invocation and ignores replayed usage', async () => {
  const lines: string[] = [];
  const ledger = new ReceiptLedger({
    now: () => new Date(0),
    writer: async (line) => {
      lines.push(line);
    },
  });
  ledger.observe({ ...completion, invocationId: 'turn-1' });
  ledger.observe({
    ...completion,
    invocationId: 'turn-1',
    route: 'zen',
    endpoint: 'chat/completions',
    model: 'zen-model',
    effort: 'low',
    usage: { input_tokens: 2, output_tokens: 3 },
    usageMetadata: { source: 'provider', replayed: true },
  });
  const before = ledger.snapshot();
  assert.equal(before.requests, 1);
  assert.equal(before.totals.output_tokens, 30);
  assert.equal(before.byModel['gpt-6-astra']?.output_tokens, 30);
  const receipt = ledger.complete(
    { session: 'session-1', agentId: 'worker-7', invocationId: 'turn-1' },
    'completed',
  );
  assert.ok(receipt);
  await ledger.drain();
  assert.equal(lines.length, 1);
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.provenance, 'gateway');
  assert.equal(receipt.byEndpoint.responses?.input_tokens, 120);
  assert.equal(JSON.parse(lines[0]).outcome, 'completed');
  assert.equal(ledger.snapshot().requests, 1);
});

test('ledger emits zero usage for failed or cancelled invocations', async () => {
  const lines: string[] = [];
  const ledger = new ReceiptLedger({
    writer: async (line) => {
      lines.push(line);
    },
  });
  ledger.start({ session: 's', agentId: 'a' });
  ledger.complete({ session: 's', agentId: 'a', invocationId: 'cancelled' }, 'cancelled');
  await ledger.drain();
  const receipt = JSON.parse(lines[0]);
  assert.equal(receipt.outcome, 'cancelled');
  assert.deepEqual(receipt.usage, {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  });
});

test('session totals survive receipt history eviction and returned records are isolated', () => {
  const ledger = new ReceiptLedger({ maxRecent: 1 });
  for (const invocationId of ['one', 'two']) {
    ledger.observe(completion);
    ledger.complete({ ...completion, invocationId }, 'completed');
  }
  ledger.observe({ ...completion, session: 'other' });
  assert.equal(ledger.snapshot('session-1').requests, 2);
  assert.equal(ledger.snapshot('other').requests, 1);
  assert.equal(ledger.recent('session-1').length, 1);
  const recent = ledger.recent('session-1')[0];
  recent.byModel['gpt-6-astra'].input_tokens = 9000;
  assert.equal(ledger.recent('session-1')[0].byModel['gpt-6-astra'].input_tokens, 120);
});

test('receipts retain correlated sources and count each request and completion once', async () => {
  const lines: string[] = [];
  const ledger = new ReceiptLedger({
    writer: async (line) => {
      lines.push(line);
    },
  });
  const event = {
    ...completion,
    requestId: 'request',
    usageMetadata: {
      source: 'provider' as const,
      reasoning_tokens: 10,
      total_tokens: 250,
    },
  };
  ledger.observe(event);
  ledger.observe(event);
  ledger.observe({ ...event, requestId: 'second' });
  ledger.observe({ ...completion, usageMetadata: { source: 'estimate' } });
  const ref = { ...completion, invocationId: 'turn' };
  ledger.complete(ref, 'completed');
  assert.equal(ledger.complete(ref, 'completed'), undefined);
  ledger.observe(event);
  await ledger.drain();
  assert.equal(lines.length, 1);
  const receipt = JSON.parse(lines[0]);
  assert.equal(receipt.requests, 3);
  assert.equal(receipt.entries.length, 2);
  assert.equal(receipt.entries[0].requests, 2);
  assert.equal(receipt.entries[0].usage.reasoning_tokens, 20);
  assert.equal(receipt.entries[0].usage.total_tokens, 500);
  assert.equal(ledger.snapshot().requests, 3);
});

test('capacity and shutdown preserve incomplete receipts and failed writes do not block later ones', async () => {
  const errors: unknown[] = [];
  const lines: string[] = [];
  let attempts = 0;
  const ledger = new ReceiptLedger({
    maxInvocations: 1,
    onError: (error) => errors.push(error),
    writer: async (line) => {
      if (++attempts === 1) {
        throw new Error('disk full');
      }
      lines.push(line);
    },
  });
  ledger.start({ session: 's', agentId: 'first' });
  ledger.start({ session: 's', agentId: 'second' });
  ledger.finishAll();
  await ledger.drain();
  assert.equal(errors.length, 1);
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).incomplete, true);
  assert.equal(JSON.parse(lines[0]).agentId, 'second');
  assert.equal(ledger.complete({ session: 's', agentId: 'unknown' }, 'completed'), undefined);
});
