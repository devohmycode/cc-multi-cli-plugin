import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ModBridge } from './mod-bridge.ts';
import type { PermissionModes } from './mode-hook.ts';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown, name: string) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}
function reply(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
function sessionKey(sessionId: string, agentId: unknown) {
  return JSON.stringify([sessionId, typeof agentId === 'string' ? agentId : 'main']);
}
function method(req: IncomingMessage, expected: string) {
  if (req.method !== expected) {
    throw new Error(`Mod route requires ${expected}`);
  }
}

export async function handleModRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  parsed: unknown,
  bridge: ModBridge,
  permissionModes?: PermissionModes,
) {
  try {
    switch (url.pathname) {
      case '/multi/mod/mode':
        method(req, 'GET');
        return modeRoute(
          res,
          text(url.searchParams.get('sessionId'), 'sessionId'),
          url.searchParams.get('agentId'),
          bridge,
        );
      default:
        return await handlePostRoute(req, res, url.pathname, parsed, bridge, permissionModes);
    }
  } catch (error) {
    return reply(
      res,
      { error: error instanceof Error ? error.message : 'Invalid mod request' },
      400,
    );
  }
}

async function handlePostRoute(
  req: IncomingMessage,
  res: ServerResponse,
  route: string,
  parsed: unknown,
  bridge: ModBridge,
  permissionModes?: PermissionModes,
) {
  method(req, 'POST');
  if (!record(parsed)) {
    throw new Error('Expected an object');
  }
  const sessionId = text(parsed.sessionId, 'sessionId');
  const key = sessionKey(sessionId, parsed.agentId);
  switch (route) {
    case '/multi/mod/session':
      return sessionRoute(res, parsed, key, bridge, permissionModes);
    case '/multi/mod/worker':
      return await workerRoute(res, parsed, key, bridge, permissionModes);
    default:
      throw new Error('Unknown mod route');
  }
}

function modeRoute(res: ServerResponse, sessionId: string, agentId: unknown, bridge: ModBridge) {
  const snapshot = bridge.mode(sessionKey(sessionId, agentId));
  return snapshot ? reply(res, snapshot) : reply(res, { accepted: false, stale: true }, 409);
}
function sessionRoute(
  res: ServerResponse,
  value: Record<string, unknown>,
  key: string,
  bridge: ModBridge,
  permissionModes?: PermissionModes,
) {
  const session = JSON.parse(key)[0] as string;
  if (value.event === 'compact') {
    if (!permissionModes) {
      throw new Error('Native compaction policy is unavailable');
    }
    permissionModes.recordModCompaction(session, value);
    return reply(res, { accepted: true });
  }
  const effective = effectivePolicy(value);
  const snapshot = bridge.recordSession(key, {
    effective,
    cwd: optionalText(value.cwd),
    generation: optionalGeneration(value),
  });
  if (snapshot && permissionModes && typeof effective.permissionMode === 'string') {
    permissionModes.recordModSession(session, {
      ...effective,
      cwd: optionalText(value.cwd),
    } as never);
  }
  if (snapshot && value.event === 'start') {
    process.emit('multi-mod-session-start');
  }
  return snapshot
    ? reply(res, { accepted: true, ...snapshot })
    : reply(res, { accepted: false, stale: true }, 409);
}
async function workerRoute(
  res: ServerResponse,
  value: Record<string, unknown>,
  key: string,
  _bridge: ModBridge,
  permissionModes?: PermissionModes,
) {
  if (!permissionModes) {
    throw new Error('Native worker policy is unavailable');
  }
  const session = JSON.parse(key)[0] as string;
  if (typeof value.agentId === 'string') {
    permissionModes.recordPreparedModWorker(session, value.agentId, value.workerToken);
    return reply(res, { accepted: true });
  }
  const workerToken = await permissionModes.prepareModWorker(session, value);
  return reply(res, { accepted: true, workerToken });
}
function optionalText(value: unknown) {
  return value === undefined ? undefined : text(value, 'cwd');
}
function optionalGeneration(value: Record<string, unknown>) {
  if (value.generation === undefined) {
    return undefined;
  }
  if (typeof value.generation !== 'number' || !Number.isSafeInteger(value.generation)) {
    throw new Error('Invalid generation');
  }
  return value.generation;
}
function stringArray(value: unknown) {
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    value.length > 256 ||
    value.some((item) => typeof item !== 'string')
  ) {
    throw new Error('Invalid policy tool list');
  }
  return value.slice();
}
function effectivePolicy(value: Record<string, unknown>) {
  const permissionMode =
    value.permissionMode === undefined ? undefined : text(value.permissionMode, 'permissionMode');
  return {
    permissionMode,
    tools: stringArray(value.tools),
    disallowedTools: stringArray(value.disallowedTools),
  };
}
