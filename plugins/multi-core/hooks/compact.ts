import type { EngineInterface, Register } from 'claude-code';
import { isHarnessModel } from './provider.ts';

const maxBody = 32000;

type GatewayResponse = {
  accepted?: boolean;
  error?: string;
  generation?: number;
  precomputeId?: string;
  allow?: boolean;
  messages?: readonly import('claude-code').SessionMessage[];
};

export const register = (
  on: Parameters<Register>[0],
  _options: Parameters<Register>[1],
  agentModels: ReadonlyMap<string, string> = new Map(),
) => {
  on('session.compact', async ($, event, next) => {
    // session.model() describes only the main loop. A Claude child must never
    // inherit its external parent's compaction policy (or the reverse).
    const model = await compactionModel($, event.agentId, agentModels);
    if (!isHarnessModel(model)) {
      return next(event);
    }
    if (!(await active($))) {
      return next(event);
    }
    const sessionId = await $.session.id();
    const mode = await request($, {}, `/multi/mod/mode?sessionId=${encodeURIComponent(sessionId)}`);
    if (mode?.generation === undefined) {
      return { skip: 'Multi compaction policy generation is unavailable.' };
    }
    const payload = {
      sessionId,
      agentId: event.agentId,
      generation: mode.generation,
      trigger: event.trigger,
      messages: event.messages,
      instructions: event.instructions,
    };
    if (event.trigger === 'precompute') {
      await precompute($, payload);
      return { skip: 'Multi summary preparation runs outside the hook budget.' };
    }
    const result = await request($, payload, '/multi/mod/compact/authorize');
    if (result?.messages) {
      return { messages: result.messages };
    }
    if (result?.allow) {
      return next(event);
    }
    // Oversized transcripts still require a separate, small tool-free authorization.
    const fallback = await request(
      $,
      {
        sessionId,
        agentId: event.agentId,
        generation: mode.generation,
      },
      '/multi/mod/compact/authorize',
    );
    if (!fallback?.allow) {
      return { skip: 'Multi tool-free compaction authorization was not acknowledged.' };
    }
    return next(event);
  });
};

async function precompute($: EngineInterface, payload: Record<string, unknown>) {
  const prepared = await request($, payload, '/multi/mod/compact/precompute');
  if (prepared?.accepted && prepared.precomputeId) {
    void request(
      $,
      {
        sessionId: payload.sessionId,
        agentId: payload.agentId,
        generation: payload.generation,
        precomputeId: prepared.precomputeId,
      },
      '/multi/mod/compact/run',
    );
  }
}

async function active($: EngineInterface): Promise<boolean> {
  const base = await $.env.get('MULTI_MOD_GATEWAY_URL');
  const token = await $.env.get('MULTI_GATEWAY_TOKEN');
  return Boolean(base && token);
}

async function request(
  $: EngineInterface,
  payload: Record<string, unknown>,
  route = '/multi/mod/session',
) {
  const base = await $.env.get('MULTI_MOD_GATEWAY_URL');
  const token = await $.env.get('MULTI_GATEWAY_TOKEN');
  if (!base || !token) {
    return undefined;
  }
  const body = JSON.stringify(payload);
  if (encodeURIComponent(body).replace(/%[A-F\d]{2}/gi, 'x').length > maxBody) {
    return undefined;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = $.http.fetch(`${base}${route}`, {
      method: route.includes('?') ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-multi-gateway-token': token },
      ...(route.includes('?') ? {} : { body }),
    });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('gateway request timeout')), 1500);
    });
    const result = await Promise.race([response, timeout]);
    return result.ok ? (JSON.parse(result.text) as GatewayResponse) : undefined;
  } catch {
    return undefined;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/** The main model is never evidence of a child's provider. */
export async function compactionModel(
  $: EngineInterface,
  agentId: string | undefined,
  agentModels: ReadonlyMap<string, string>,
): Promise<string | undefined> {
  return agentId ? agentModels.get(agentId) : $.session.model();
}
