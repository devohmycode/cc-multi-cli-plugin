import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCodexUsage, readCodexUsage } from '../../plugins/multi-openai/src/usage.ts';

test('normalizes every primary and secondary Codex quota bucket', () => {
  const result = normalizeCodexUsage({
    rateLimitsByLimitId: {
      standard: {
        limitName: '5 hours',
        planType: 'pro',
        credits: { balance: '4.00', unlimited: false },
        primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_900_000_000 },
        secondary: { usedPercent: 48, windowDurationMins: 10080, resetsAt: 1_900_100_000 },
      },
      premium: { limitName: 'premium', primary: { usedPercent: 101, windowDurationMins: 60 } },
    },
  });
  assert.equal(result.plan, 'pro');
  assert.deepEqual(result.credits, { balance: '4.00', unlimited: false });
  assert.deepEqual(result.windows, [
    { label: '5 hours · 5 hours', usedPercent: 12, resetsAt: '2030-03-17T17:46:40.000Z' },
    { label: '5 hours · weekly', usedPercent: 48, resetsAt: '2030-03-18T21:33:20.000Z' },
    { label: 'premium · 1 hours', usedPercent: 101 },
  ]);
});

test('does not double count legacy aliases when bucketed limits exist', () => {
  const result = normalizeCodexUsage({
    rateLimits: { primary: { usedPercent: 1 } },
    rateLimitsByLimitId: { one: { primary: { usedPercent: 2 } } },
  });
  assert.deepEqual(result.windows, [{ label: 'one · primary', usedPercent: 2 }]);
});

test('rejects invalid quota percentages', () => {
  assert.throws(
    () => normalizeCodexUsage({ rateLimits: { primary: { usedPercent: -1 } } }),
    /unavailable/,
  );
  assert.throws(
    () => normalizeCodexUsage({ rateLimits: { primary: { usedPercent: Number.NaN } } }),
    /unavailable/,
  );
});

test('pre-aborted usage read does not launch a Codex process', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    readCodexUsage('/tmp/does-not-exist/auth.json', {
      executable: '/tmp/does-not-exist/codex',
      signal: controller.signal,
    }),
    /aborted/i,
  );
});
