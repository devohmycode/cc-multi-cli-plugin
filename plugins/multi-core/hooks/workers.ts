import type { EngineInterface, Register } from 'claude-code';
import {
  ensureHarnessPolicy,
  type PolicyClient,
  type PolicyResponse,
  type PolicyState,
} from './policy.ts';
import { isHarnessModel } from './provider.ts';

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

type GatewayResponse = PolicyResponse & {
  accepted?: boolean;
  error?: string;
  isOffered?: boolean;
  execution?: 'claude' | 'harness';
  known?: boolean;
  model?: string;
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
  return {
    refused: true,
    httpStatus: status,
    error: reason ?? (detail ? `gateway ${status}: ${detail}` : `gateway ${status}`),
  };
}

export const register = (
  on: Parameters<Register>[0],
  _options: Parameters<Register>[1],
  agentModels: Map<string, string> = new Map(),
  policyState: PolicyState = {},
) => {
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
        parentModel: await $.session.model(),
      },
      '/multi/mod/offer',
    );
    // Claude owns its own catalog. Only a positively identified harness worker
    // is subject to Multi's settings-translation compatibility filter.
    return response?.execution === 'harness' && response.isOffered === false
      ? { isOffered: false }
      : next(event);
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
    if (response?.accepted && response.model) {
      agentModels.set(event.agent_id, response.model);
    }
    // Registration is observational for Claude-loop workers. An unregistered
    // harness worker still cannot dispatch: resolveHarness rejects its scope.
    return next(event);
  });
  on('agent.spawn', async ($, event, next) => {
    if (!(await active($))) {
      return next(event);
    }
    const payload = {
      sessionId: await $.session.id(),
      parentAgentId: event.parentAgentId,
      permissionMode: event.permissionMode,
      subagentType: event.subagentType,
      cwd: event.cwd ?? (await $.session.cwd()),
      model: event.model,
      parentModel: event.parentModel,
      fork: event.fork,
      background: event.background,
    };
    const selection = await request($, payload, '/multi/mod/worker-model');
    const harness = harnessSpawn(event, selection);
    if (harness) {
      await prepareHarness($, policyState);
      const mode = await request(
        $,
        {},
        `/multi/mod/mode?sessionId=${encodeURIComponent(payload.sessionId)}`,
      );
      const response = await request($, { ...payload, generation: mode?.generation });
      if (!response?.accepted) {
        return {
          deny: reportable(response?.error ?? 'Multi harness worker policy was not acknowledged.'),
        };
      }
    } else {
      // Keep context for a possible later harness child, but never veto the
      // engine's native worker because Multi could not reconstruct its policy.
      await request($, payload);
    }
    const result = await next(event);
    if (result.agentId && result.model) {
      agentModels.set(result.agentId, result.model);
    }
    return result;
  });
};

function harnessSpawn(
  event: { fork?: boolean; model?: string; parentModel?: string },
  selection: GatewayResponse | undefined,
): boolean {
  const inferred = event.fork ? event.parentModel : (event.model ?? event.parentModel);
  return selection?.execution === 'harness' || (!selection?.known && isHarnessModel(inferred));
}

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

async function policyClient($: EngineInterface): Promise<PolicyClient> {
  return {
    model: await $.session.model(),
    request: (route, payload) => request($, payload, route),
  };
}

async function prepareHarness($: EngineInterface, state: PolicyState) {
  if (state.prompt && !state.harnessReady) {
    await ensureHarnessPolicy(await policyClient($), state);
  }
}
