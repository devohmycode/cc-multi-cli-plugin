import { isHarnessModel } from './provider.ts';

export type PolicyResponse = {
  refused?: true;
  httpStatus?: number;
  error?: string;
  generation?: number | string;
  status?: string;
  accepted?: boolean;
};
export type PolicyClient = {
  model: string;
  request: (route: string, payload: Record<string, unknown>) => Promise<PolicyResponse | undefined>;
};
export type PromptSnapshot = { sessionId: string; cwd: string; permissionMode: unknown };
export type PolicyState = {
  generation?: number;
  prompt?: PromptSnapshot;
  harnessReady?: boolean;
  preparing?: Promise<number | undefined>;
};

/** Share one admission across helpers spawned from the same prompt. */
export async function ensureHarnessPolicy(client: PolicyClient, state: PolicyState) {
  const snapshot = state.prompt;
  if (!snapshot || state.harnessReady) {
    return;
  }
  const preparing = state.preparing ?? admitPrompt(client, snapshot, state.generation);
  state.preparing = preparing;
  const generation = await preparing;
  if (state.prompt === snapshot) {
    state.generation = generation;
    state.harnessReady = generation !== undefined;
    state.preparing = undefined;
  }
}

/** Prepare translated settings only for a harness prompt or a requested harness worker. */
export async function admitPrompt(
  client: PolicyClient,
  snapshot: PromptSnapshot,
  sourceGeneration: number | undefined,
): Promise<number | undefined> {
  const prepared = await preparePolicy(client, snapshot.sessionId, snapshot.cwd, sourceGeneration);
  if (!prepared) {
    return undefined;
  }
  const response = await client.request('/multi/mod/session', {
    policyGeneration: prepared.policyGeneration,
    sessionId: snapshot.sessionId,
    cwd: snapshot.cwd,
    model: client.model,
    event: 'prompt',
    generation: prepared.generation,
    permissionMode: snapshot.permissionMode,
  });
  if (!response?.accepted || typeof response.generation !== 'number') {
    return undefined;
  }
  return response.generation;
}

/** Only an actual harness prompt waits for translated settings policy. */
export async function recordPrompt(
  client: PolicyClient,
  snapshot: PromptSnapshot,
  generation: number | undefined,
): Promise<number | undefined> {
  const model = client.model;
  if (isHarnessModel(model)) {
    return admitPrompt(client, snapshot, generation);
  }
  const response = await client.request('/multi/mod/session', {
    ...snapshot,
    model,
    event: 'prompt',
  });
  return response?.accepted && typeof response.generation === 'number'
    ? response.generation
    : undefined;
}

type PolicyHandoff = { policyGeneration: string; generation: number | undefined };

/** Exported for offline coverage of the stale-generation resync. */
export async function preparePolicy(
  client: PolicyClient,
  sessionId: string,
  cwd: string,
  sourceGeneration: number | undefined,
): Promise<PolicyHandoff | undefined> {
  let generation = sourceGeneration;
  let started = await client.request('/multi/mod/policy', { sessionId, cwd, sourceGeneration });
  if (started?.refused) {
    // A reloaded hooks module keeps a mode generation the gateway no longer agrees
    // with, and `/clear` detaches the session so the gateway holds none at all;
    // either way every later prompt reads stale. Adopt the gateway's own value once,
    // including the absence of one, which begins a fresh session.
    const resynced = await modeGeneration(client, sessionId);
    if (!resynced || resynced.generation === generation) {
      return undefined;
    }
    generation = resynced.generation;
    started = await client.request('/multi/mod/policy', {
      sessionId,
      cwd,
      sourceGeneration: generation,
    });
  }
  if (started?.refused || typeof started?.generation !== 'string') {
    return undefined;
  }
  const policyGeneration = await awaitPolicy(client, sessionId, started.generation);
  return policyGeneration === undefined ? undefined : { policyGeneration, generation };
}

async function awaitPolicy(client: PolicyClient, sessionId: string, generation: string) {
  // Policy discovery runs `claude plugin list` and settings admission; on a
  // cold Windows start that takes several seconds. Stay under the 10 s hook budget.
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const result = await client.request('/multi/mod/policy', { sessionId, generation });
    if (result?.status === 'ready') {
      return generation;
    }
    if (!result || result.refused || result.status === 'failed') {
      return undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return undefined;
}

/** The gateway's own mode generation, or `{ generation: undefined }` when it holds none. */
async function modeGeneration(client: PolicyClient, sessionId: string) {
  const mode = await client.request(
    `/multi/mod/mode?sessionId=${encodeURIComponent(sessionId)}`,
    {},
  );
  if (typeof mode?.generation === 'number') {
    return { generation: mode.generation };
  }
  // A 409 is the gateway answering that it holds no mode for this session, as after
  // `/clear` detaches it. An unreachable gateway leaves the truth unknown instead.
  if (mode && (!mode.refused || mode.httpStatus === 409)) {
    return { generation: undefined };
  }
  return undefined;
}
