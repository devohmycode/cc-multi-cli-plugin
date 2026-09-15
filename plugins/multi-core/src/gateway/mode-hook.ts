import { randomUUID } from 'node:crypto';
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
  private readonly pendingWorkers = new Map<string, WorkerPermissions & { cwd: string }>();
  private readonly definitions: (cwd: string) => Promise<Record<string, WorkerPermissions>>;

  constructor(definitions: (cwd: string) => Promise<Record<string, WorkerPermissions>>) {
    this.definitions = definitions;
  }

  recordModSession(session: string, context: PermissionContext): void {
    this.parents.delete(session);
    remember(this.parents, session, structuredClone(context));
  }

  recordModWorker(
    session: string,
    agent: string,
    context: WorkerPermissions & { cwd?: string },
  ): void {
    remember(this.workers, JSON.stringify([session, agent]), {
      cwd: context.cwd ?? process.cwd(),
      permissionMode: context.permissionMode,
      tools: context.tools?.slice(),
      disallowedTools: context.disallowedTools?.slice(),
      ...(context.nativePermissionError
        ? { nativePermissionError: context.nativePermissionError }
        : {}),
    });
  }

  async prepareModWorker(session: string, input: Record<string, unknown>): Promise<string> {
    const type = requiredString(input.subagentType, 'subagentType');
    const cwd = requiredString(input.cwd, 'cwd');
    permissionMode(input.permissionMode);
    const definitions = await this.definitions(cwd);
    const definition = Object.hasOwn(definitions, type) ? definitions[type] : undefined;
    if (!definition) {
      throw new Error(`Cannot resolve permissions for Claude worker ${type}`);
    }
    const token = randomUUID();
    remember(this.pendingWorkers, JSON.stringify([session, token]), {
      cwd,
      // A definition without a mode inherits the parent's at resolve time.
      permissionMode: definition.permissionMode,
      tools: definition.tools?.slice(),
      disallowedTools: definition.disallowedTools?.slice(),
      ...(definition.nativePermissionError
        ? { nativePermissionError: definition.nativePermissionError }
        : {}),
    });
    return token;
  }

  recordPreparedModWorker(session: string, agent: string, token: unknown): void {
    const workerToken = requiredString(token, 'workerToken');
    const key = JSON.stringify([session, workerToken]);
    const context = this.pendingWorkers.get(key);
    this.pendingWorkers.delete(key);
    if (!context) {
      throw new Error('Worker policy acknowledgement is unavailable');
    }
    this.recordModWorker(session, agent, context);
  }

  recordModCompaction(session: string, input: Record<string, unknown>): void {
    this.recordCompaction(session, {
      session_id: session,
      hook_event_name: 'PreCompact',
      trigger: input.trigger,
      cwd: input.cwd,
      permission_mode: input.permissionMode,
    });
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
      // A definition without a mode inherits the parent's at resolve time.
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
