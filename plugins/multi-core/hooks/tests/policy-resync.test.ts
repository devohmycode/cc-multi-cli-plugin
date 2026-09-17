import type { EngineInterface } from 'claude-code';
import { expect, test } from 'claude-code/testing';
import { admitPrompt, preparePolicy } from '../register.ts';

type Call = { url: string; body: Record<string, unknown> };

/** A gateway holding `held` as its mode generation, refusing every other source. */
function gateway(held: number | undefined, calls: Call[]) {
  return {
    session: { model: async () => 'multi/cursor/auto' },
    env: {
      get: async (name: string) =>
        name === 'MULTI_MOD_GATEWAY_URL' ? 'http://127.0.0.1:4000' : 'test-token',
    },
    http: {
      fetch: async (url: string, init: { body?: string }) => {
        const route = url.replace('http://127.0.0.1:4000', '');
        const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
        calls.push({ url: route, body });
        const ok = (value: unknown) => ({ ok: true, status: 200, text: JSON.stringify(value) });
        if (route.startsWith('/multi/mod/mode?')) {
          // The real route answers 409 when it holds no snapshot for the session.
          return held === undefined
            ? { ok: false, status: 409, text: JSON.stringify({ accepted: false, stale: true }) }
            : ok({ generation: held });
        }
        if (route === '/multi/mod/session') {
          return ok({ accepted: true, generation: 11 });
        }
        if (body.generation !== undefined) {
          return ok({ generation: body.generation, status: 'ready' });
        }
        if (body.sourceGeneration !== held) {
          return {
            ok: false,
            status: 400,
            text: JSON.stringify({ error: 'Policy source generation is stale' }),
          };
        }
        return ok({ generation: 'policy-1', status: 'pending' });
      },
    },
  } as unknown as EngineInterface;
}

/** A gateway that answers nothing, so no generation can be adopted. */
function unreachable() {
  return {
    session: { model: async () => 'multi/cursor/auto' },
    env: {
      get: async (name: string) =>
        name === 'MULTI_MOD_GATEWAY_URL' ? 'http://127.0.0.1:4000' : 'test-token',
    },
    http: {
      fetch: async () => {
        throw new Error('connection refused');
      },
    },
  } as unknown as EngineInterface;
}

test('a reloaded hooks module adopts the mode generation the gateway still holds', async () => {
  const calls: Call[] = [];
  const prepared = await preparePolicy(gateway(7, calls), 'session', '/workspace', undefined);
  expect(prepared).toEqual({ policyGeneration: 'policy-1', generation: 7 });
  expect(calls.some((call) => call.url.startsWith('/multi/mod/mode?'))).toBe(true);
});

test('a detached session adopts the absence of a generation instead of blocking forever', async () => {
  const calls: Call[] = [];
  const prepared = await preparePolicy(gateway(undefined, calls), 'session', '/workspace', 3);
  expect(prepared).toEqual({ policyGeneration: 'policy-1', generation: undefined });
  const begins = calls.filter((call) => call.url === '/multi/mod/policy' && !call.body.generation);
  expect(begins.at(-1)?.body.sourceGeneration).toBe(undefined);
});

test('policy admission still fails when the gateway answers nothing to adopt', async () => {
  expect(await preparePolicy(unreachable(), 'session', '/workspace', 3)).toBe(undefined);
});

test('a matching source generation never re-reads the gateway mode', async () => {
  const calls: Call[] = [];
  const prepared = await preparePolicy(gateway(4, calls), 'session', '/workspace', 4);
  expect(prepared).toEqual({ policyGeneration: 'policy-1', generation: 4 });
  expect(calls.some((call) => call.url.startsWith('/multi/mod/mode?'))).toBe(false);
});

test('a session that already holds no generation is not resynced in a loop', async () => {
  const calls: Call[] = [];
  expect(
    await preparePolicy(gateway(undefined, calls), 'session', '/workspace', undefined),
  ).toEqual({ policyGeneration: 'policy-1', generation: undefined });
  expect(calls.some((call) => call.url.startsWith('/multi/mod/mode?'))).toBe(false);
});

test('a prompt whose policy cannot be admitted carries no generation and is never blocked', async () => {
  const calls: Call[] = [];
  const snapshot = { sessionId: 'session', cwd: '/workspace', permissionMode: 'default' };
  // The mode route answers nothing, so no generation can be adopted or recorded.
  expect(await admitPrompt(unreachable(), snapshot, 3)).toBe(undefined);
  // A detached session recovers on its own and records the new snapshot.
  expect(await admitPrompt(gateway(undefined, calls), snapshot, 3)).toBe(11);
  expect(calls.some((call) => call.url === '/multi/mod/session')).toBe(true);
});
