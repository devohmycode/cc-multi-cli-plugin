import type { EngineInterface } from 'claude-code';
import { expect, test } from 'claude-code/testing';
import { preparePolicy } from '../register.ts';

type Call = { url: string; body: Record<string, unknown> };

/** A gateway holding `held` as its mode generation, refusing every other source. */
function gateway(held: number | undefined, calls: Call[]) {
  return {
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
          return held === undefined ? ok({}) : ok({ generation: held });
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

test('a reloaded hooks module adopts the mode generation the gateway still holds', async () => {
  const calls: Call[] = [];
  const prepared = await preparePolicy(gateway(7, calls), 'session', '/workspace', undefined);
  expect(prepared).toEqual({ policyGeneration: 'policy-1', generation: 7 });
  expect(calls.some((call) => call.url.startsWith('/multi/mod/mode?'))).toBe(true);
});

test('policy admission still fails when the gateway holds no generation to adopt', async () => {
  const calls: Call[] = [];
  expect(await preparePolicy(gateway(undefined, calls), 'session', '/workspace', 3)).toBe(
    undefined,
  );
});

test('a matching source generation never re-reads the gateway mode', async () => {
  const calls: Call[] = [];
  const prepared = await preparePolicy(gateway(4, calls), 'session', '/workspace', 4);
  expect(prepared).toEqual({ policyGeneration: 'policy-1', generation: 4 });
  expect(calls.some((call) => call.url.startsWith('/multi/mod/mode?'))).toBe(false);
});
