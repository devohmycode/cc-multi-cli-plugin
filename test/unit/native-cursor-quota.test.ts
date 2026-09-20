import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { formatCursorQuota, readCursorQuota } from '../../plugins/multi-cursor/src/quota.ts';
import { removeTemporary } from '../temporary.ts';

test('exchanges stored Cursor SDK key and reads current period usage', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cursor-quota-'));
  t.after(() => removeTemporary(dir));
  const authFile = path.join(dir, 'auth.json');
  await writeFile(
    authFile,
    JSON.stringify({ apiKey: 'fixture-key', backendUrl: 'https://cursor.test' }),
  );
  const requests: Request[] = [];
  const fetchImpl = async (input: string | Request | URL, init?: RequestInit) => {
    requests.push(new Request(input, init));
    const url = String(input);
    const body = url.includes('exchange')
      ? { accessToken: 'fixture-token' }
      : {
          billingCycleStart: '1700000000000',
          billingCycleEnd: '1702592000000',
          plan: 'Pro',
          displayMessage: 'Usage refreshes soon',
          enabled: true,
          spendLimitUsage: { remaining: 1995 },
          planUsage: {
            remaining: 1995,
            limit: 2000,
            autoPercentUsed: 0.111111,
            apiPercentUsed: 0,
            totalPercentUsed: 0.055555,
          },
        };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const result = await readCursorQuota({
    env: {},
    authFile,
    backendUrl: 'https://cursor.test',
    fetchImpl,
  });
  assert.equal(result.planUsage.totalPercentUsed, 0.055555);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].headers.get('authorization'), 'Bearer fixture-key');
  assert.equal(requests[1].headers.get('authorization'), 'Bearer fixture-token');
  assert.equal(requests[0].redirect, 'error');
  assert.equal(requests[1].redirect, 'error');
  assert.match(formatCursorQuota(result).details.join(' '), /0\.11%/);
});

test('rejects malformed usage and mismatched selected backend', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cursor-quota-invalid-'));
  t.after(() => removeTemporary(dir));
  const authFile = path.join(dir, 'auth.json');
  await writeFile(
    authFile,
    JSON.stringify({ apiKey: 'fixture-key', backendUrl: 'https://one.test' }),
  );
  const fetchImpl = async () => new Response('{}', { status: 200 });
  await assert.rejects(
    readCursorQuota({ env: {}, authFile, backendUrl: 'https://two.test', fetchImpl }),
    /Cursor quota is unavailable/,
  );
  await writeFile(authFile, JSON.stringify({ apiKey: 'fixture-key' }));
  await assert.rejects(
    readCursorQuota({ env: {}, authFile, fetchImpl }),
    /Cursor quota is unavailable/,
  );
});

test('environment key takes precedence over stored credentials', async () => {
  const requests: Request[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push(new Request(input, init));
    const body = String(input).includes('exchange')
      ? { accessToken: 'token' }
      : { planUsage: { totalPercentUsed: 0 } };
    return Response.json(body);
  };
  await readCursorQuota({
    env: { CURSOR_API_KEY: 'environment-key', CURSOR_BACKEND_URL: 'https://env.test' },
    authFile: '/does-not-exist',
    fetchImpl,
  });
  assert.equal(new URL(requests[0].url).origin, 'https://env.test');
  assert.equal(requests[0].headers.get('authorization'), 'Bearer environment-key');
});

test('quota failures redact provider errors and reject invalid payloads', async () => {
  for (const value of [null, [], {}, { planUsage: null }]) {
    let calls = 0;
    await assert.rejects(
      readCursorQuota({
        env: { CURSOR_API_KEY: 'test' },
        fetchImpl: async () => Response.json(++calls === 1 ? { accessToken: 'test' } : value),
      }),
      /^Error: Cursor quota is unavailable$/,
    );
  }
  await assert.rejects(
    readCursorQuota({
      env: { CURSOR_API_KEY: 'test' },
      fetchImpl: async () => {
        throw new Error('secret key');
      },
    }),
    /^Error: Cursor quota is unavailable$/,
  );
  assert.throws(() => formatCursorQuota({ planUsage: {} }), /unavailable/);
  assert.match(formatCursorQuota({ planUsage: { totalPercentUsed: 12.5 } }).summary, /12.50% used/);
});
