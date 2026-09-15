import type { EngineInterface, Register } from 'claude-code';

const maxBody = 32000;

type GatewayResponse = {
  accepted?: boolean;
  error?: string;
  generation?: number;
  isOffered?: boolean;
};

export const register: Register = (on) => {
  on('agent.offer', async ($, event, next) => {
    if (!(await active($))) {
      return next(event);
    }
    const response = await request(
      $,
      {
        sessionId: await $.session.id(),
        cwd: await $.session.cwd(),
        agent: event.agent,
      },
      '/multi/mod/offer',
    );
    return response?.isOffered ? next(event) : { isOffered: false };
  });
  on('classic.SubagentStart', async ($, event, next) => {
    if (!(await active($))) {
      return next(event);
    }
    const response = await request($, {
      sessionId: event.session_id,
      agentId: event.agent_id,
      subagentType: event.agent_type,
      cwd: event.cwd,
    });
    if (!response?.accepted) {
      return { block: response?.error ?? 'Multi worker start was not acknowledged.' };
    }
    return next(event);
  });
  on('agent.spawn', async ($, event, next) => {
    if (!(await active($))) {
      return next(event);
    }
    const sessionId = await $.session.id();
    const mode = await request($, {}, `/multi/mod/mode?sessionId=${encodeURIComponent(sessionId)}`);
    const snapshot = await request($, {
      generation: mode?.generation,
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
    // The child-start hook correlates its engine ID before the first native request.
    return next(event);
  });
};

async function active($: EngineInterface): Promise<boolean> {
  const base = await $.env.get('MULTI_MOD_GATEWAY_URL');
  const token = await $.env.get('MULTI_GATEWAY_TOKEN');
  return Boolean(base && token);
}

async function request(
  $: EngineInterface,
  payload: Record<string, unknown>,
  route = '/multi/mod/worker',
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
