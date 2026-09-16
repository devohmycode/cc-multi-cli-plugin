import assert from 'node:assert/strict';
import test from 'node:test';
import { formatZenQuota, readZenQuota } from '../../plugins/multi-zen/src/usage.ts';

const payload = {
  usage: {
    rolling: { status: 'ok', percent: 12, resetsAt: '2030-01-01T00:00:00.000Z' },
    weekly: { status: 'ok', percent: 34, resetsAt: '2030-01-02T00:00:00.000Z' },
    monthly: { status: 'rate-limited', percent: 100, resetsAt: '2030-02-01T00:00:00.000Z' },
  },
};

test('Zen Go quota sends the API key and parses provider windows', async () => {
  let request: Request | undefined;
  const result = await readZenQuota({
    apiKey: 'test-key',
    endpoint: 'https://example.test/usage',
    fetch: async (input, init) => {
      request = new Request(input, init);
      return Response.json(payload);
    },
  });
  assert.equal(result.status, 'available');
  assert.equal(result.quota.monthly.percent, 100);
  assert.equal(request?.headers.get('authorization'), 'Bearer test-key');
  assert.equal(request?.redirect, 'error');
  const view = formatZenQuota(result);
  assert.equal(view.status, 'ready');
  assert.match(view.summary, /weekly: 34% used/);
  assert(view.details.some((line) => line.includes('limit reached')));
});

test('Zen Go quota distinguishes missing key and missing entitlement', async () => {
  assert.deepEqual(await readZenQuota({ apiKey: '' }), {
    status: 'unavailable',
    reason: 'missing-key',
  });
  const result = await readZenQuota({
    apiKey: 'test-key',
    fetch: async () => Response.json({ error: { type: 'EntitlementError' } }, { status: 403 }),
  });
  assert.deepEqual(result, { status: 'unavailable', reason: 'not-go-entitled' });
  assert.equal(formatZenQuota(result).status, 'unavailable');
  const forbidden = await readZenQuota({
    apiKey: 'test-key',
    fetch: async () => Response.json({ error: { type: 'AuthError' } }, { status: 403 }),
  });
  assert.deepEqual(forbidden, { status: 'unavailable', reason: 'unauthorized' });
  assert.equal(formatZenQuota(forbidden).status, 'error');
});

test('Zen quota rejects invalid credentials before fetch and malformed reset times', async () => {
  await assert.rejects(
    readZenQuota({
      apiKey: 'bad\nkey',
      fetch: async () => {
        throw new Error('must not fetch');
      },
    }),
    /Invalid OpenCode Zen API key/,
  );
  const result = await readZenQuota({
    apiKey: 'test-key',
    fetch: async () =>
      Response.json({
        usage: {
          ...payload.usage,
          weekly: { ...payload.usage.weekly, resetsAt: 'unknown' },
        },
      }),
  });
  assert.deepEqual(result, { status: 'unavailable', reason: 'malformed' });
});

test('Zen Go quota rejects malformed, unauthorized and timed out responses', async () => {
  const malformed = await readZenQuota({
    apiKey: 'key',
    fetch: async () => Response.json({ usage: {} }),
  });
  assert.deepEqual(malformed, { status: 'unavailable', reason: 'malformed' });
  const unauthorized = await readZenQuota({
    apiKey: 'key',
    fetch: async () => new Response('{}', { status: 401 }),
  });
  assert.deepEqual(unauthorized, { status: 'unavailable', reason: 'unauthorized' });
  const timeout = await readZenQuota({
    apiKey: 'key',
    timeoutMs: 1,
    fetch: async (_input, init) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      }),
  });
  assert.deepEqual(timeout, { status: 'unavailable', reason: 'network' });
});
