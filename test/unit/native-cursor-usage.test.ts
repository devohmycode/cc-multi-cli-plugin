import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatCursorUsage,
  readCursorAccountUsage,
  readCursorUsage,
} from '../../plugins/multi-cursor/src/usage.ts';

const usage = {
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 120,
};

test('Cursor account quota and worker billing survive independent lookup failures', async () => {
  const fail = async () => {
    throw new Error('secret credential');
  };
  const quota = await readCursorAccountUsage(
    'session',
    async () => ({
      summary: '10% used',
      details: ['Resets tomorrow'],
    }),
    fail,
  );
  assert.equal(quota.status, 'ready');
  assert.equal(quota.summary, '10% used');
  assert(quota.details.includes('Resets tomorrow'));
  const billing = await readCursorAccountUsage('session', fail, async () => [
    {
      agentId: 'agent',
      scope: 'session',
      usage,
      runs: [],
      cost: { rawCostCents: 10, chargedCents: 5 },
    },
  ]);
  assert.equal(billing.status, 'error');
  assert(billing.details.some((line) => line.includes('$0.05 charged')));
  assert(!JSON.stringify([quota, billing]).includes('secret credential'));
});

test('Cursor usage distinguishes pending cost from a reported zero charge', async () => {
  const pending = formatCursorUsage([{ agentId: 'a', scope: 's', usage, runs: [] }]);
  assert.match(pending.summary, /cost pending/);
  const free = formatCursorUsage([
    { agentId: 'a', scope: 's', usage, runs: [], cost: { rawCostCents: 0, chargedCents: 0 } },
  ]);
  assert.match(free.summary, /\$0\.00 charged/);
});

test('Cursor usage deduplicates agent lifetime records and marks partial costs', async () => {
  const result = await readCursorUsage('session', async () => [
    {
      agentId: 'a',
      scope: 'session/main',
      usage,
      runs: [],
      cost: { rawCostCents: 10, chargedCents: 5 },
    },
    { agentId: 'a', scope: 'session/main', usage: { ...usage, totalTokens: 999 }, runs: [] },
    { agentId: 'b', scope: 'session/worker', usage, runs: [] },
  ]);
  assert.match(result.summary, /240 tokens/);
  assert.match(result.summary, /partial/);
  assert.equal(result.details.length, 2);
});

test('reported numbers group the same way on every machine locale', () => {
  // Without an explicit locale these read "12 345" on a French host and "12,345"
  // on an English one, so a contributor's machine decided whether the launcher
  // limit test passed. The receipts view already pins en-US; the rest follows.
  const large = {
    inputTokens: 12000,
    outputTokens: 345,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 12345,
  };
  const result = formatCursorUsage([{ agentId: 'a', scope: 's', usage: large, runs: [] }]);
  assert.match(result.summary, /12,345 tokens/);
  assert.match(result.details[0], /12,345 tokens \(12,000 in, 345 out\)/);
});

test('Cursor usage reports unavailable when there are no agents', async () => {
  const result = await readCursorUsage('session', async () => []);
  assert.match(result.summary, /unavailable/);
  assert.deepEqual(result.details, []);
});
