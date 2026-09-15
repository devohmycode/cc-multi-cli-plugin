import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WorkerPermissions } from './agent-definitions.ts';

const MODES = ['default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions', 'plan'] as const;
type PermissionMode = (typeof MODES)[number];
export interface PermissionContext extends WorkerPermissions {
  permissionMode: PermissionMode;
  cwd?: string;
  compaction?: string;
}

function permissionMode(value: unknown): PermissionMode {
  if (!MODES.includes(value as PermissionMode)) {
    throw new Error('Missing or unsupported Claude permission mode');
  }
  return value as PermissionMode;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value || value.length > 4096) {
    throw new Error(`Missing or invalid hook ${name}`);
  }
  return value;
}

/** Prompt-time snapshots: the existing selector takes effect at the next prompt. */
export class PermissionModes {
  private readonly parents = new Map<string, PermissionContext>();
  private readonly workers = new Map<string, WorkerPermissions & { cwd: string }>();
  private readonly definitions: (cwd: string) => Promise<Record<string, WorkerPermissions>>;
  private readonly pendingDirectory?: string;

  constructor(
    definitions: (cwd: string) => Promise<Record<string, WorkerPermissions>>,
    pendingDirectory?: string,
  ) {
    this.definitions = definitions;
    this.pendingDirectory = pendingDirectory;
  }

  async record(input: Record<string, unknown>): Promise<void> {
    const session = requiredString(input.session_id, 'session_id');
    if (input.hook_event_name === 'PreCompact') {
      this.recordCompaction(session, input);
      return;
    }
    if (input.hook_event_name === 'UserPromptSubmit') {
      // Clear first: a malformed new snapshot must not retain earlier permissions.
      this.parents.delete(session);
      remember(this.parents, session, { permissionMode: permissionMode(input.permission_mode) });
      return;
    }
    if (input.hook_event_name !== 'SubagentStart') {
      throw new Error('Unsupported mode hook event');
    }
    const agent = requiredString(input.agent_id, 'agent_id');
    const key = JSON.stringify([session, agent]);
    this.workers.delete(key);
    const type = requiredString(input.agent_type, 'agent_type');
    const cwd = requiredString(input.cwd, 'cwd');
    const definitions = await this.definitions(cwd);
    const definition = Object.hasOwn(definitions, type) ? definitions[type] : undefined;
    if (!definition) {
      throw new Error(`Cannot resolve permissions for Claude worker ${type}`);
    }
    remember(this.workers, key, {
      cwd,
      permissionMode: definition.permissionMode,
      tools: definition.tools?.slice(),
      disallowedTools: definition.disallowedTools?.slice(),
      ...(definition.nativePermissionError
        ? { nativePermissionError: definition.nativePermissionError }
        : {}),
    });
  }

  private recordCompaction(session: string, input: Record<string, unknown>): void {
    const previous = this.parents.get(session);
    this.parents.delete(session);
    if (input.trigger !== 'manual' && input.trigger !== 'auto') {
      throw new Error('Unsupported compaction trigger');
    }
    remember(this.parents, session, {
      // Some Claude builds omit mode on PreCompact. Retain the authenticated
      // snapshot, or use Plan for this tool-free summary after a gateway restart.
      permissionMode:
        input.permission_mode === undefined
          ? (previous?.permissionMode ?? 'plan')
          : permissionMode(input.permission_mode),
      cwd: requiredString(input.cwd, 'cwd'),
      compaction: randomUUID(),
    });
  }

  resolve(session: string, agent?: string): PermissionContext {
    if (this.pendingDirectory) {
      assertSynchronized(this.pendingDirectory, session);
      if (agent) {
        assertSynchronized(this.pendingDirectory, session, agent);
      }
    }
    const parent = this.parents.get(session);
    if (!parent) {
      throw new Error('Claude permission mode is unavailable; submit a new prompt');
    }
    if (!agent) {
      return structuredClone(parent);
    }
    const worker = this.workers.get(JSON.stringify([session, agent]));
    if (!worker) {
      throw new Error('Claude worker permission context is unavailable');
    }
    const inherited = ['auto', 'acceptEdits', 'bypassPermissions'].includes(parent.permissionMode);
    return {
      ...worker,
      permissionMode: inherited
        ? parent.permissionMode
        : permissionMode(worker.permissionMode ?? parent.permissionMode),
    };
  }
}

function pendingFile(directory: string, session: string, agent?: string): string {
  const key = createHash('sha256')
    .update(JSON.stringify([session, agent ?? null]))
    .digest('hex');
  return path.join(directory, `mode-pending-${key}`);
}

function assertSynchronized(directory: string, session: string, agent?: string): void {
  try {
    readFileSync(pendingFile(directory, session, agent));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
  throw new Error(
    'Native permission sync is incomplete; submit a new prompt or restart the worker',
  );
}

function remember<T>(entries: Map<string, T>, key: string, value: T): void {
  // ponytail: cap lifetime identities; add lifecycle cleanup if long sessions reach this limit.
  if (!entries.has(key) && entries.size >= 4096) {
    throw new Error('Claude permission context limit reached; restart the gateway');
  }
  entries.set(key, value);
}

function controlEndpoint(value: string | undefined): string {
  // Match the launcher's literal loopback address, not DNS or URL-normalized aliases.
  if (!value || !/^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/multi\/mode$/.test(value)) {
    throw new Error('Missing or invalid launcher control endpoint');
  }
  const port = Number(value.slice('http://127.0.0.1:'.length, -'/multi/mode'.length));
  if (port < 1 || port > 65535) {
    throw new Error('Missing or invalid launcher control endpoint');
  }
  return value;
}

function transportFailure(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'transport error';
  }
  if (error.name === 'TimeoutError') {
    return 'timeout after 5000ms';
  }
  const cause = error.cause;
  if (cause && typeof cause === 'object' && 'code' in cause) {
    const codes = [
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'EACCES',
      'EPERM',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_SOCKET',
    ];
    if (typeof cause.code === 'string' && codes.includes(cause.code)) {
      return `transport ${cause.code}`;
    }
  }
  return 'transport error (no recognized cause code)';
}

async function postSnapshot(endpoint: string, token: string, raw: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'x-multi-gateway-token': token },
      body: raw,
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    });
    await response.body?.cancel();
  } catch (error) {
    throw new Error(transportFailure(error));
  }
  if (!response.ok) {
    // Never echo response bodies: validation errors can contain user-controlled input.
    throw new Error(
      `HTTP ${response.status}${response.status >= 300 && response.status < 400 ? ' (redirect rejected)' : ''}`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let endpoint = '(invalid or missing)';
  let event = 'unknown';
  let pending: string | undefined;
  try {
    let raw = '';
    for await (const chunk of process.stdin) {
      raw += chunk;
      if (raw.length > 1048576) {
        throw new Error('Mode hook input too large');
      }
    }
    let input: unknown;
    try {
      input = JSON.parse(raw);
    } catch {
      throw new Error('Invalid hook JSON');
    }
    if (
      input &&
      typeof input === 'object' &&
      'hook_event_name' in input &&
      ['UserPromptSubmit', 'SubagentStart', 'PreCompact'].includes(String(input.hook_event_name))
    ) {
      event = String(input.hook_event_name);
    }
    if (!input || typeof input !== 'object' || !('session_id' in input)) {
      throw new Error('Missing hook session_id');
    }
    const session = requiredString(input.session_id, 'session_id');
    const agent =
      event === 'SubagentStart' && 'agent_id' in input
        ? requiredString(input.agent_id, 'agent_id')
        : undefined;
    const directory = requiredString(process.argv[3], 'pending directory');
    const marker = pendingFile(directory, session, agent);
    // Set before transport: even an interrupted hook cannot leave old native permissions usable.
    writeFileSync(marker, '', { mode: 0o600 });
    pending = marker;
    endpoint = controlEndpoint(process.argv[2]);
    const token = process.env.MULTI_GATEWAY_TOKEN;
    if (!token || !/^[\x21-\x7e]{1,4096}$/.test(token)) {
      throw new Error('Missing or invalid gateway token');
    }
    await postSnapshot(endpoint, token, raw);
    unlinkSync(pending);
    console.log('{}');
  } catch (error) {
    console.error(
      `Multi permission sync failed: event=${event} endpoint=${endpoint}; ${error instanceof Error ? error.message : 'Mode hook failed'}. Relaunch through the updated Multi launcher and submit a new prompt; check that its local gateway is still running.`,
    );
    // Exit 1 reports a hook warning without rejecting prompts/task notifications.
    // If we could not invalidate the old snapshot, blocking remains necessary.
    process.exitCode = pending ? 1 : 2;
  }
}
