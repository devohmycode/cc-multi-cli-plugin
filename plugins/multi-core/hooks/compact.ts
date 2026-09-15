import type { EngineInterface, Register } from 'claude-code';

const maxBody = 32000;

type GatewayResponse = { accepted?: boolean; error?: string };

export const register: Register = (on) => {
  on('classic.PreCompact', async ($, event, next) => {
    if (!(await active($))) {
      return next(event);
    }
    const response = await request($, {
      sessionId: event.session_id,
      event: 'compact',
      trigger: event.trigger,
      cwd: event.cwd,
      ...(event.permission_mode === undefined ? {} : { permissionMode: event.permission_mode }),
    });
    if (!response?.accepted) {
      return { block: response?.error ?? 'Multi compaction policy was not acknowledged.' };
    }
    return next(event);
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
    const response = $.http.fetch(`${base}/multi/mod/session`, {
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
