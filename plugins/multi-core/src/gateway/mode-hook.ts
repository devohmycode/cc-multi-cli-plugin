import { randomUUID } from 'node:crypto';
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

  constructor(definitions: (cwd: string) => Promise<Record<string, WorkerPermissions>>) {
    this.definitions = definitions;
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

function remember<T>(entries: Map<string, T>, key: string, value: T): void {
  // ponytail: cap lifetime identities; add lifecycle cleanup if long sessions reach this limit.
  if (!entries.has(key) && entries.size >= 4096) {
    throw new Error('Claude permission context limit reached; restart the gateway');
  }
  entries.set(key, value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let raw = '';
    for await (const chunk of process.stdin) {
      raw += chunk;
      if (raw.length > 1048576) {
        throw new Error('Mode hook input too large');
      }
    }
    const response = await fetch(new URL('/multi/mode', process.env.ANTHROPIC_BASE_URL), {
      method: 'POST',
      headers: { 'x-multi-gateway-token': process.env.MULTI_GATEWAY_TOKEN ?? '' },
      body: raw,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      throw new Error(
        `Could not record Claude permission context: ${(await response.text()).slice(0, 1000)}`,
      );
    }
    console.log('{}');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Mode hook failed');
    process.exitCode = 2;
  }
}
