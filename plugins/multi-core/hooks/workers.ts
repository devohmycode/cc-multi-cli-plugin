import type { EngineInterface, Register } from 'claude-code';

const maxBody = 32000;

type GatewayResponse = { accepted?: boolean; error?: string; workerToken?: string };

export const register: Register = (on) => {
  on('agent.spawn', async ($, event, next) => {
    if (!(await active($))) {
      return next(event);
    }
    const sessionId = await $.session.id();
    const snapshot = await request($, {
      sessionId,
      parentAgentId: event.parentAgentId,
      permissionMode: event.permissionMode,
      subagentType: event.subagentType,
      cwd: event.cwd ?? (await $.session.cwd()),
      model: event.model,
      parentModel: event.parentModel,
      background: event.background,
    });
    if (!snapshot?.accepted) {
      return { deny: snapshot?.error ?? 'Multi worker policy was not acknowledged.' };
    }
    const result = await next(event);
    if ('deny' in result || !result.agentId) {
      return result;
    }
    const started = await request($, {
      sessionId,
      agentId: result.agentId,
      workerToken: snapshot.workerToken,
    });
    if (!started?.accepted) {
      return { deny: started?.error ?? 'Multi worker policy could not be correlated.' };
    }
    return result;
  });
};

async function active($: EngineInterface): Promise<boolean> {
  const base = await $.env.get('MULTI_MOD_GATEWAY_URL');
  const token = await $.env.get('MULTI_GATEWAY_TOKEN');
  return Boolean(base && token);
}

async function request($: EngineInterface, payload: Record<string, unknown>) {
  const base = await $.env.get('MULTI_MOD_GATEWAY_URL');
  const token = await $.env.get('MULTI_GATEWAY_TOKEN');
  if (!base || !token) {
    return undefined;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = $.http.fetch(`${base}/multi/mod/worker`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-multi-gateway-token': token },
      body: JSON.stringify(payload).slice(0, maxBody),
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
