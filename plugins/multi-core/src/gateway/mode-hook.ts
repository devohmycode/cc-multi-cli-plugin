import { randomUUID } from 'node:crypto';
import { mergeCursorPermissions } from '../../../multi-cursor/src/permissions.ts';
import type { WorkerPermissions } from './agent-definitions.ts';
import { ModPolicies } from './mod-policy.ts';

const MODES = ['default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions', 'plan'] as const;
type PermissionMode = (typeof MODES)[number];
export interface PermissionContext extends WorkerPermissions {
  permissionMode: PermissionMode;
  cwd?: string;
  model?: string;
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
  readonly policies: ModPolicies;
  private readonly compactions = new Map<string, { id: string; previous: PermissionContext }>();
  private readonly parents = new Map<string, PermissionContext>();
  private readonly workers = new Map<
    string,
    WorkerPermissions & { cwd: string; compaction?: string }
  >();
  private readonly pendingWorkers = new Map<
    string,
    WorkerPermissions & { cwd: string; type: string; expiresAt: number }
  >();
  private readonly catalogs = new Map<string, Record<string, WorkerPermissions>>();
  private readonly definitions: (cwd: string) => Promise<Record<string, WorkerPermissions>>;

  constructor(
    definitions: (cwd: string) => Promise<Record<string, WorkerPermissions>>,
    restrictions: (cwd: string) => Promise<WorkerPermissions> = async () => ({}),
  ) {
    this.definitions = definitions;
    this.policies = new ModPolicies(async (cwd) => ({
      cwd,
      workers: await definitions(cwd),
      restrictions: await restrictions(cwd),
    }));
  }

  beginPolicy(session: string, cwd: string) {
    this.parents.delete(session);
    for (const key of this.compactions.keys()) {
      if (JSON.parse(key)[0] === session) {
        this.compactions.delete(key);
      }
    }
    for (const key of this.pendingWorkers.keys()) {
      if (JSON.parse(key)[0] === session) {
        this.pendingWorkers.delete(key);
      }
    }
    return this.policies.begin(session, cwd);
  }

  admitPolicy(session: string, generation: string, context: PermissionContext) {
    const policy = this.policies.consume(session, generation, requiredString(context.cwd, 'cwd'));
    remember(this.catalogs, policy.cwd, policy.workers);
    this.recordModSession(session, {
      ...mergeCursorPermissions(context, policy.restrictions),
      nativePermissionError: policy.restrictions.nativePermissionError,
    });
  }

  async precompute(cwd: string): Promise<void> {
    const catalog = await this.definitions(cwd);
    remember(this.catalogs, cwd, structuredClone(catalog));
  }

  offered(cwd: string, type: string): boolean {
    const catalog = this.catalogs.get(cwd);
    return Boolean(catalog && Object.hasOwn(catalog, type) && !catalog[type].nativePermissionError);
  }

  recordModSession(session: string, context: PermissionContext): void {
    this.parents.delete(session);
    permissionMode(context.permissionMode);
    remember(this.parents, session, structuredClone(context));
  }

  recordModWorker(
    session: string,
    agent: string,
    context: WorkerPermissions & { cwd?: string; compaction?: string },
  ): void {
    remember(this.workers, JSON.stringify([session, agent]), {
      cwd: context.cwd ?? process.cwd(),
      model: context.model,
      compaction: context.compaction,
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
    const parent = this.resolve(
      session,
      typeof input.parentAgentId === 'string' ? input.parentAgentId : undefined,
    );
    if (permissionMode(input.permissionMode) !== parent.permissionMode) {
      throw new Error('Worker parent permission mode is inconsistent');
    }
    if (parent.model && input.parentModel !== parent.model) {
      throw new Error('Worker parent model is inconsistent');
    }
    if (parent.cwd && parent.cwd !== cwd) {
      throw new Error('Worker workspace has no acknowledged policy');
    }
    const definitions = this.catalogs.get(cwd);
    if (!definitions) {
      throw new Error('Worker catalog has not been precomputed for this workspace');
    }
    const definition = Object.hasOwn(definitions, type) ? definitions[type] : undefined;
    if (!definition) {
      throw new Error(`Cannot resolve permissions for Claude worker ${type}`);
    }
    if (definition.nativePermissionError) {
      throw new Error(definition.nativePermissionError);
    }
    if (
      definition.model &&
      definition.model !== 'inherit' &&
      input.model !== undefined &&
      input.model !== definition.model
    ) {
      throw new Error('Worker model is inconsistent with its catalog definition');
    }
    this.prunePendingWorkers();
    const token = randomUUID();
    remember(this.pendingWorkers, JSON.stringify([session, token]), {
      cwd,
      type,
      expiresAt: Date.now() + 15000,
      model: definition.model === 'inherit' ? parent.model : (definition.model ?? parent.model),
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

  private prunePendingWorkers() {
    for (const [key, pending] of this.pendingWorkers) {
      if (pending.expiresAt <= Date.now()) {
        this.pendingWorkers.delete(key);
      }
    }
  }

  startPreparedModWorker(session: string, agent: string, type: string, cwd: string): void {
    const candidates = [...this.pendingWorkers].filter(
      ([key, value]) =>
        JSON.parse(key)[0] === session &&
        value.type === type &&
        value.cwd === cwd &&
        value.expiresAt > Date.now(),
    );
    if (candidates.length !== 1) {
      throw new Error('Worker start has no unique acknowledged spawn');
    }
    const [key] = candidates[0];
    this.recordPreparedModWorker(session, agent, JSON.parse(key)[1]);
  }

  recordPreparedModWorker(session: string, agent: string, token: unknown): void {
    requiredString(agent, 'agentId');
    if (this.workers.has(JSON.stringify([session, agent]))) {
      throw new Error('Worker identity is already registered');
    }
    const workerToken = requiredString(token, 'workerToken');
    const key = JSON.stringify([session, workerToken]);
    const context = this.pendingWorkers.get(key);
    this.pendingWorkers.delete(key);
    if (!context || context.expiresAt <= Date.now()) {
      throw new Error('Worker policy acknowledgement is unavailable');
    }
    this.recordModWorker(session, agent, context);
  }

  authorizeModCompaction(session: string, agent?: string): void {
    const current = this.resolve(session, agent);
    const key = JSON.stringify([session, agent ?? 'main']);
    const previous = this.compactions.get(key)?.previous ?? current;
    const context = { ...current, tools: [], compaction: randomUUID() };
    remember(this.compactions, key, { id: context.compaction, previous });
    if (agent) {
      this.recordModWorker(session, agent, context);
    } else {
      this.recordModSession(session, context);
    }
  }

  finishModCompaction(session: string, agent: string | undefined, id: string | undefined): void {
    const key = JSON.stringify([session, agent ?? 'main']);
    const saved = this.compactions.get(key);
    if (!id || saved?.id !== id) {
      return;
    }
    this.compactions.delete(key);
    if (this.resolve(session, agent).compaction !== id) {
      return;
    }
    if (agent) {
      this.recordModWorker(session, agent, saved.previous);
    } else {
      this.recordModSession(session, saved.previous);
    }
  }

  async record(input: Record<string, unknown>): Promise<void> {
    const session = requiredString(input.session_id, 'session_id');
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

  forgetSession(session: string): void {
    this.parents.delete(session);
    this.policies.forget(session);
    for (const entries of [this.workers, this.pendingWorkers, this.compactions]) {
      for (const key of entries.keys()) {
        if (JSON.parse(key)[0] === session) {
          entries.delete(key);
        }
      }
    }
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
    return mergeCursorPermissions(
      {
        ...worker,
        nativePermissionError: worker.nativePermissionError ?? parent.nativePermissionError,
        ...(parent.compaction ? { compaction: parent.compaction } : {}),
        permissionMode: inherited
          ? parent.permissionMode
          : permissionMode(worker.permissionMode ?? parent.permissionMode),
      },
      parent,
    );
  }
}

function remember<T>(entries: Map<string, T>, key: string, value: T): void {
  // ponytail: cap lifetime identities; add lifecycle cleanup if long sessions reach this limit.
  if (!entries.has(key) && entries.size >= 4096) {
    throw new Error('Claude permission context limit reached; restart the gateway');
  }
  entries.set(key, value);
}
