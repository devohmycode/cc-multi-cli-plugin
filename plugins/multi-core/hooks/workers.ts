import type { EngineInterface, Register } from 'claude-code';

const maxBody = 32000;
const issues =
  'https://github.com/greenpolo/cc-multi-cli-plugin/issues/new?template=bug_report.yml';

/**
 * A refusal the agent reads, with the invitation to report it.
 *
 * Most refusals are the plugin working: a mode the user chose, a worker their
 * settings do not offer. The invitation is conditional so an ordinary denial
 * does not become an issue, and it never files anything on the user's behalf.
 */
function reportable(reason: string) {
  return `${reason}\n\nIf this reads like a defect in the multi-cli plugin rather than a permission the user chose, tell them so and offer to open an issue at ${issues}, quoting the reason above.`;
}

type GatewayResponse = {
  accepted?: boolean;
  error?: string;
  generation?: number;
  isOffered?: boolean;
};

// A refused reply keeps only the reason: a non-2xx status never carries an
// acknowledgement, so every caller still fails closed on the HTTP status alone.
function refusal(text: string, status: number): GatewayResponse {
  let reason: string | undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      const value = (parsed as { error?: unknown }).error;
      reason = typeof value === 'string' && value ? value : undefined;
    }
  } catch {
    // A non-JSON body still names the status below.
  }
  const detail = text.trim().slice(0, 200);
  return { error: reason ?? (detail ? `gateway ${status}: ${detail}` : `gateway ${status}`) };
}

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
      return { block: reportable(response?.error ?? 'Multi worker start was not acknowledged.') };
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
      return { deny: reportable(snapshot?.error ?? 'Multi worker policy was not acknowledged.') };
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
    return result.ok
      ? (JSON.parse(result.text) as GatewayResponse)
      : refusal(result.text, result.status);
  } catch {
    return undefined;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
