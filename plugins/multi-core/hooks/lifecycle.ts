import type { EngineInterface, Register } from 'claude-code';
import { isHarnessModel } from './provider.ts';
import { forgetUsageSession } from './usage.ts';

type Status = {
  model?: string;
  state?: string;
  detail?: string;
  elapsedMs?: number;
  startedAt?: number;
};

export const register = (
  on: Parameters<Register>[0],
  _options: Parameters<Register>[1],
  onDetach: () => void = () => {},
  models: Map<string, string> = new Map(),
) => {
  const running = new Map<string, object>();
  on('turn.step', async function* ($, event, next) {
    // Observability only: forward every core chunk unchanged, without serving inference.
    const key = event.agentId ?? 'main';
    models.set(key, event.model);
    const native = isHarnessModel(event.model);
    if (native && !running.has(key) && running.size < 128) {
      const token = {};
      running.set(key, token);
      void poll($, event.agentId, () => running.get(key) === token);
    }
    void postStep($, event);
    return yield* next(event);
  });
  on('turn.complete', async ($, event, next) => {
    const key = event.agentId ?? 'main';
    const model = models.get(key);
    if (model?.startsWith('multi/')) {
      await request($, '/multi/mod/usage/complete', {
        sessionId: await $.session.id(),
        agentId: event.agentId,
        turnId: event.turnId,
        outcome: event.reason,
      });
    }
    const wasRunning = running.delete(key);
    // Retain a child's identity between turns: compaction can precede its next step.
    if (event.isAborted && isHarnessModel(model)) {
      void cancelCompaction($, event.agentId);
    }
    if (wasRunning && running.size === 0) {
      void $.ui.status(undefined);
    }
    return next(event);
  });
  on('session.detach', async ($, event, next) => {
    onDetach();
    forgetUsageSession(await $.session.id());
    running.clear();
    models.clear();
    void detach($);
    return next(event);
  });
};

async function postStep($: EngineInterface, event: object) {
  await request($, '/multi/mod/telemetry', { ...event, sessionId: await $.session.id() });
}

async function detach($: EngineInterface) {
  await request($, '/multi/mod/detach', { sessionId: await $.session.id() });
}

async function poll($: EngineInterface, agentId: string | undefined, active: () => boolean) {
  const since = Date.now();
  const sessionId = await $.session.id();
  const query = `sessionId=${encodeURIComponent(sessionId)}&agentId=${encodeURIComponent(agentId ?? 'main')}`;
  let failures = 0;
  while (active() && failures < 5) {
    const status = await request($, `/multi/mod/lifecycle?${query}`);
    if (!active()) {
      return;
    }
    failures = status ? 0 : failures + 1;
    if (status?.state && (status.startedAt ?? 0) >= since) {
      await $.ui.status(statusText(status, agentId));
      if (status.state !== 'running') {
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function request(
  $: EngineInterface,
  route: string,
  payload?: object,
): Promise<Status | undefined> {
  const base = await $.env.get('MULTI_MOD_GATEWAY_URL');
  const token = await $.env.get('MULTI_GATEWAY_TOKEN');
  if (!base || !token) {
    return undefined;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      $.http.fetch(`${base}${route}`, {
        method: payload ? 'POST' : 'GET',
        headers: { 'content-type': 'application/json', 'x-multi-gateway-token': token },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Gateway timeout')), 1500);
      }),
    ]);
    return response.ok ? (JSON.parse(response.text) as Status) : undefined;
  } catch {
    return undefined;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function statusText(status: Status, agentId: string | undefined) {
  const elapsed = Math.floor((status.elapsedMs ?? 0) / 1000);
  return `${status.model} · ${agentId ?? 'main'} · ${status.state} · ${elapsed}s ${status.detail ?? ''}`;
}
async function cancelCompaction($: EngineInterface, agentId?: string) {
  await request($, '/multi/mod/compact/cancel', { sessionId: await $.session.id(), agentId });
}
