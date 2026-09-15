import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AgentOptions, Run, SDKAgent } from '@cursor/sdk';
import type { WorkerPermissions } from '../../multi-core/src/gateway/agent-definitions.ts';
import { atomicWriteFile } from '../../multi-core/src/gateway/atomic-write.ts';
import type {
  Emit,
  MessagesRequest,
  MessagesResponse,
  StreamEventBody,
  StreamEventName,
} from '../../multi-core/src/gateway/messages.ts';
import type { ModDisplayEvent } from '../../multi-core/src/gateway/mod-bridge.ts';
import type { PermissionContext } from '../../multi-core/src/gateway/mode-hook.ts';
import { lockStateFile } from '../../multi-core/src/gateway/state-lock.ts';
import { estimateTextTokens } from '../../multi-core/src/gateway/tokens.ts';
import { CursorProviderError, cursorRunError } from './errors.ts';
import { type CursorModelOption, cursorSelection } from './models.ts';
import {
  cursorNativePermissions,
  cursorPermissionPolicy,
  mergeCursorPermissions,
} from './permissions.ts';
import type { NativeRowObserver } from './progress.ts';
import { cursorRowObservation, formatCursorProgress } from './progress.ts';
import { cursorHistoryHash, cursorTerminalSuffix, prepareCursorRequest } from './request.ts';

type Agent = Pick<SDKAgent, 'agentId' | 'send' | 'close'>;
export type CreateCursorHarnessAgent = (options: AgentOptions) => Promise<Agent>;
type PendingRun = {
  key: string;
  runId?: string;
  model: string;
  inputTokens: number;
};
type SavedSession = {
  version: 2;
  agentId: string;
  response?: MessagesResponse;
  replay?: { key: string; events: Event[] };
  interrupted: boolean;
  pendingRun?: PendingRun;
};
type Event = [StreamEventName, StreamEventBody];
type Session = {
  agent: Agent;
  file: string;
  response?: MessagesResponse;
  replay?: { key: string; events: Event[] };
  interrupted: boolean;
  busy: boolean;
  run?: Run;
  unlock?: Promise<void>;
  release: () => Promise<void>;
  pendingRun?: PendingRun;
  policy: string;
};
type Exchange = {
  result: Promise<MessagesResponse>;
  controller: AbortController;
  events: Event[];
  listeners: Set<Emit>;
  observers: number;
  settled: boolean;
  mayHaveRun: boolean;
  committed: boolean;
  rowObserver?: NativeRowObserver;
};
const hash = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(value) ?? 'null')
    .digest('hex');

const INTERRUPTED_NOTICE =
  '[Cursor] The previous turn was interrupted. Report its state and do not repeat completed actions.';

/** Cursor owns state, tools and review. External actions are display-only text. */
export class CursorHarness {
  private readonly options: Map<string, CursorModelOption>;
  private readonly sessions = new Map<string, Session>();
  private readonly exchanges = new Map<string, Exchange>();
  private readonly creating = new Set<string>();
  private cwd: string;
  private readonly stateDirectory: string;
  private readonly platform: NodeJS.Platform;
  private readonly resumeAgent: (id: string, options: AgentOptions) => Promise<Agent>;
  private readonly createAgent: CreateCursorHarnessAgent;
  private readonly checkPermissions: () => Promise<WorkerPermissions>;
  private readonly getRun: (id: string, cwd: string) => Promise<Run>;
  private closed = false;
  private readonly closedAgents = new WeakSet<Agent>();

  constructor(
    options: CursorModelOption[],
    {
      cwd = process.cwd(),
      checkPermissions = async () => ({}),
      stateDirectory,
      platform = process.platform,
      env = process.env,
      home = homedir(),
      resumeAgent = async (id: string, config: AgentOptions) =>
        (await import('@cursor/sdk')).Agent.resume(id, config),
      getRun = async (id: string, cwd: string) =>
        (await import('@cursor/sdk')).Agent.getRun(id, { cwd, runtime: 'local' }),
      createAgent = async (config: AgentOptions) =>
        (await import('@cursor/sdk')).Agent.create(config),
    }: {
      cwd?: string;
      checkPermissions?: () => Promise<WorkerPermissions>;
      getRun?: (id: string, cwd: string) => Promise<Run>;
      stateDirectory?: string;
      platform?: NodeJS.Platform;
      env?: NodeJS.ProcessEnv;
      home?: string;
      createAgent?: CreateCursorHarnessAgent;
      resumeAgent?: (id: string, config: AgentOptions) => Promise<Agent>;
    } = {},
  ) {
    this.options = new Map(options.map((option) => [option.model, option]));
    this.platform = platform;
    this.stateDirectory =
      stateDirectory ??
      path.join(
        platform === 'win32' ? (env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local')) : home,
        '.cursor',
        'multi-harness',
      );
    this.cwd = cwd;
    this.checkPermissions = checkPermissions;
    this.getRun = getRun;
    this.resumeAgent = resumeAgent;
    this.createAgent = createAgent;
  }

  private selection(body: MessagesRequest) {
    const option = this.options.get(body.model ?? '');
    if (!option) {
      throw new Error('Unknown Cursor model; use a model from the account catalog');
    }
    return cursorSelection(option, body.output_config?.effort);
  }

  validate(body: MessagesRequest, context?: PermissionContext) {
    this.selection(body);
    if (context) {
      cursorPermissionPolicy(context);
    }
    if (!body.messages?.length) {
      throw new Error('Cursor requires a conversation');
    }
    return prepareCursorRequest(body).inputTokens;
  }

  async handle(
    body: MessagesRequest,
    scope: string,
    signal: AbortSignal,
    emit?: Emit,
    context?: PermissionContext,
    rowObserver?: NativeRowObserver,
  ) {
    if (this.closed) {
      throw new Error('Cursor harness is closed');
    }
    signal.throwIfAborted();
    if (!context) {
      throw new Error('Cursor requires an explicit Claude permission context');
    }
    const permissions = mergeCursorPermissions(context, await this.checkPermissions());
    this.validate(body, permissions);
    this.cwd = await realpath(this.cwd);
    const key = hash([
      this.cwd,
      scope,
      { ...body, stream: undefined },
      cursorPermissionPolicy(permissions).identity,
    ]);
    let exchange = this.exchanges.get(key);
    if (!exchange) {
      // Keep failed/finished requests too: a transport retry must never repeat native edits.
      if (this.exchanges.size >= 256) {
        const completed = [...this.exchanges].find(([, item]) => item.settled);
        if (!completed) {
          throw new Error('Too many concurrent Cursor requests');
        }
        this.exchanges.delete(completed[0]);
      }
      exchange = this.startExchange(body, scope, key, permissions, rowObserver);
      this.exchanges.set(key, exchange);
    }
    return observe(exchange, signal, emit);
  }

  private startExchange(
    body: MessagesRequest,
    scope: string,
    key: string,
    context: PermissionContext,
    rowObserver?: NativeRowObserver,
  ): Exchange {
    const controller = new AbortController();
    const events: Event[] = [];
    const listeners = new Set<Emit>();
    const emit: Emit = (name, value) => {
      events.push([name, structuredClone(value)]);
      for (const listener of listeners) {
        listener(name, value);
      }
    };
    const exchange: Exchange = {
      controller,
      events,
      listeners,
      observers: 0,
      settled: false,
      mayHaveRun: false,
      committed: false,
      rowObserver,
      result: Promise.resolve().then(() =>
        this.cachedExecute(body, scope, key, exchange, emit, context),
      ),
    };
    void exchange.result.then(
      () => {
        exchange.settled = true;
      },
      () => {
        exchange.settled = true;
        if ((!exchange.mayHaveRun || exchange.committed) && this.exchanges.get(key) === exchange) {
          this.exchanges.delete(key);
        }
      },
    );
    return exchange;
  }

  private async cachedExecute(
    body: MessagesRequest,
    scope: string,
    key: string,
    exchange: Exchange,
    emit: Emit,
    context: PermissionContext,
  ): Promise<MessagesResponse> {
    const file = path.join(this.stateDirectory, `${key}.response.json`);
    let current = await readSession(this.sessionFile(scope));
    if (current?.interrupted) {
      // Attempted once per request: a readable terminal result is the stronger
      // path and is persisted as a completed turn; anything else leaves the
      // session interrupted and this request proceeds with a fresh dispatch.
      current = await this.recoverSession(scope);
    }
    const latest = current?.replay;
    const cached =
      latest?.key === key
        ? { response: current?.response, events: latest.events }
        : await readJson(file);
    if (cached !== undefined) {
      const saved = cached as { response: MessagesResponse; events: Event[] };
      if (!saved.response?.id || !Array.isArray(saved.events)) {
        throw new Error('Invalid persisted Cursor response');
      }
      for (const event of saved.events) {
        emit(...event);
      }
      return saved.response;
    }
    const terminal: Event[] = [];
    const replay: { key: string; events: Event[] } = { key, events: [] };
    const deferredEmit: Emit = (name, value) => {
      replay.events.push([name, structuredClone(value)]);
      if (['message_delta', 'message_stop', 'content_block_stop'].includes(name)) {
        terminal.push([name, value]);
      } else {
        emit(name, value);
      }
    };
    const response = await this.execute(body, scope, exchange, deferredEmit, context, replay);
    for (const event of terminal) {
      emit(...event);
    }
    return response;
  }

  private async recoverSession(scope: string): Promise<SavedSession | undefined> {
    if (this.sessions.has(scope) || this.creating.has(scope)) {
      throw new Error('Cursor run is still owned by this gateway; wait for it to finish');
    }
    const file = this.sessionFile(scope);
    const release = await lockStateFile(`${file}.lock`);
    try {
      const saved = await readSession(file);
      const pending = saved?.pendingRun;
      if (!saved?.interrupted || !pending) {
        return saved;
      }
      const recovered = await this.recoverRun(pending, saved.agentId);
      if (!recovered) {
        return saved;
      }
      const updated: SavedSession = {
        ...saved,
        interrupted: false,
        pendingRun: undefined,
        response: recovered.response,
        replay: { key: pending.key, events: recovered.events },
      };
      await atomicJson(file, updated, this.platform);
      return updated;
    } finally {
      await release();
    }
  }

  /** A readable terminal result; every other outcome leaves the run's status unknown. */
  private async recoverRun(pending: PendingRun, agentId: string) {
    if (!pending.runId) {
      return undefined;
    }
    const run = await this.getRun(pending.runId, this.cwd);
    if (run.id !== pending.runId || run.agentId !== agentId) {
      return undefined;
    }
    if (run.status === 'running' || !run.supports('wait')) {
      return undefined;
    }
    const result = await run.wait();
    if (result.id !== pending.runId || result.status !== 'finished') {
      return undefined;
    }
    const events: Event[] = [];
    const response = new HarnessResponse(pending.model, pending.inputTokens, (name, value) => {
      events.push([name, structuredClone(value)]);
    });
    response.text(result.result ?? '');
    return { response: response.finish(), events };
  }

  private async session(scope: string, body: MessagesRequest, context: PermissionContext) {
    if (this.sessions.get(scope)?.busy || this.creating.has(scope)) {
      throw new Error('A different request is already running for this Cursor agent');
    }
    this.creating.add(scope);
    try {
      const session = this.sessions.get(scope) ?? (await this.loadSession(scope, body, context));
      const messages = session.response ? continuation(body) : (body.messages ?? []);
      const rewound = historyRewound(session, body.messages ?? []);
      session.busy = true;
      return { session, messages, rewound };
    } finally {
      this.creating.delete(scope);
    }
  }

  private sessionFile(scope: string) {
    return path.join(this.stateDirectory, `${hash([this.cwd, scope])}.session.json`);
  }

  private async loadSession(
    scope: string,
    body: MessagesRequest,
    context: PermissionContext,
  ): Promise<Session> {
    if (this.sessions.size >= 32) {
      const idle = [...this.sessions].find(([, item]) => !item.busy);
      if (!idle) {
        throw new Error('Too many concurrent Cursor agents');
      }
      this.sessions.delete(idle[0]);
      this.closeAgent(idle[1].agent);
      await this.releaseLock(idle[1]);
    }
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    const file = this.sessionFile(scope);
    const release = await lockStateFile(`${file}.lock`);
    let agent: Agent | undefined;
    try {
      const saved = await readSession(file);
      const config = {
        ...(await cursorNativePermissions(this.cwd, context)),
        model: this.selection(body),
      };
      agent = saved
        ? await this.resumeAgent(saved.agentId, config)
        : await this.createAgent(config);
      if (this.closed) {
        this.closeAgent(agent);
        throw new Error('Cursor harness is closed');
      }
      const session: Session = {
        agent,
        file,
        response: saved?.response,
        replay: saved?.replay,
        interrupted: saved?.interrupted ?? false,
        pendingRun: saved?.pendingRun,
        busy: false,
        release,
        policy: cursorPermissionPolicy(context).identity,
      };
      await this.saveSession(session);
      this.sessions.set(scope, session);
      return session;
    } catch (error) {
      if (agent) {
        this.closeAgent(agent);
      }
      await release();
      throw error;
    }
  }

  private async configureSession(
    session: Session,
    body: MessagesRequest,
    context: PermissionContext,
  ) {
    const config = await cursorNativePermissions(this.cwd, context);
    const policy = cursorPermissionPolicy(context).identity;
    if (session.policy === policy && !this.closedAgents.has(session.agent)) {
      return;
    }
    // Tools are agent-level SDK options. Resume the same conversation with the new policy.
    this.closeAgent(session.agent);
    session.agent = await this.resumeAgent(session.agent.agentId, {
      ...config,
      model: this.selection(body),
    });
    session.policy = policy;
  }

  private saveSession(session: Session) {
    return atomicJson(
      session.file,
      {
        version: 2,
        agentId: session.agent.agentId,
        response: session.response,
        replay: session.replay,
        interrupted: session.interrupted,
        pendingRun: session.pendingRun,
      },
      this.platform,
    );
  }

  private async archiveReply(session: Session) {
    if (session.replay && session.response) {
      // Archive the previous reply before replacing the single atomic session commit.
      await atomicJson(
        path.join(this.stateDirectory, `${session.replay.key}.response.json`),
        { response: session.response, events: session.replay.events },
        this.platform,
      );
    }
  }

  private async persistDispatch(session: Session, key: string, model: string, inputTokens: number) {
    session.pendingRun = { key, model, inputTokens };
    // Durability write: a gateway crash before a terminal result arrives leaves
    // the session interrupted, so the next request resumes it with a notice
    // instead of guessing what the dispatched run did.
    session.interrupted = true;
    await this.saveSession(session);
    return session.pendingRun;
  }

  private async execute(
    body: MessagesRequest,
    scope: string,
    exchange: Exchange,
    emit: Emit,
    context: PermissionContext,
    replay: { key: string; events: Event[] },
  ) {
    const signal = exchange.controller.signal;
    signal.throwIfAborted();
    const { session, messages, rewound } = await this.session(scope, body, context);
    let text = '';
    let cancelled = false;
    let dispatched = false;
    const cancel = () => {
      if (session.run && !cancelled) {
        cancelled = true;
        const run = session.run;
        void Promise.resolve()
          .then(() => run.cancel())
          .catch(() => {});
      }
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const prepared = prepareCursorRequest({ ...body, messages });
      if (session.interrupted) {
        prepared.prompt.text = `${INTERRUPTED_NOTICE}\n\n${prepared.prompt.text ?? ''}`;
      }
      const stream = new HarnessResponse(body.model ?? '', prepared.inputTokens, emit);
      this.writeNotices(stream, session, rewound);
      signal.throwIfAborted();
      if (this.closed) {
        throw new Error('Cursor harness is closed');
      }
      await this.configureSession(session, body, context);
      await this.archiveReply(session);
      const dispatch = await this.persistDispatch(
        session,
        replay.key,
        body.model ?? '',
        prepared.inputTokens,
      );
      dispatched = true;
      signal.throwIfAborted();
      exchange.mayHaveRun = true;
      session.run = await this.dispatchRun(
        session,
        prepared.prompt,
        { model: this.selection(body), mode: cursorPermissionPolicy(context).mode },
        signal,
        stream,
        (delta) => {
          text += delta;
        },
        exchange.rowObserver,
      );
      dispatch.runId = session.run.id;
      await this.saveSession(session);
      if (signal.aborted) {
        cancel();
      }
      const result = await session.run.wait();
      // A readable terminal result, success or not, resolves the uncertainty.
      session.interrupted = false;
      session.pendingRun = undefined;
      signal.throwIfAborted();
      if (result.status !== 'finished') {
        throw cursorRunError(result);
      }
      const suffix = cursorTerminalSuffix(text, result.result ?? '');
      if (suffix) {
        exchange.rowObserver?.({ type: 'text', text: suffix });
      }
      stream.text(suffix);
      const response = stream.finish();
      session.response = response;
      session.replay = replay;
      // Completion and its replayable HTTP reply must commit together.
      await this.saveSession(session);
      exchange.committed = true;
      return response;
    } catch (error) {
      cancel();
      await this.recordUncertainty(session, dispatched, exchange.mayHaveRun);
      throw error instanceof CursorProviderError ? error : new CursorProviderError(error);
    } finally {
      session.busy = false;
      session.run = undefined;
      signal.removeEventListener('abort', cancel);
      if (this.closed) {
        this.closeAgent(session.agent);
        await this.releaseLock(session);
      }
    }
  }

  private writeNotices(stream: HarnessResponse, session: Session, rewound: boolean) {
    if (session.interrupted) {
      stream.text(`${INTERRUPTED_NOTICE}\n`);
    }
    if (rewound) {
      stream.text(
        '[Cursor] Outer history changed; the native conversation continues with its own record.\n',
      );
    }
  }

  private dispatchRun(
    session: Session,
    prompt: ReturnType<typeof prepareCursorRequest>['prompt'],
    options: {
      model: ReturnType<CursorHarness['selection']>;
      mode: ReturnType<typeof cursorPermissionPolicy>['mode'];
    },
    signal: AbortSignal,
    stream: HarnessResponse,
    appendText: (delta: string) => void,
    rowObserver?: NativeRowObserver,
  ) {
    return session.agent.send(prompt, {
      ...options,
      onDelta: ({ update }) => {
        signal.throwIfAborted();
        const observation = rowObserver ? cursorRowObservation(update) : undefined;
        const display = observation ? rowObserver?.(observation) : undefined;
        if (display) {
          stream.displayRow(display);
        }
        if (update.type === 'text-delta') {
          appendText(update.text);
          stream.text(update.text);
        } else if (!rowObserver) {
          const progress = formatCursorProgress(update);
          if (progress) {
            stream.text(`\n${progress}\n`);
          }
        }
      },
    });
  }

  /** No dispatch record: nothing to reconcile. A dispatch that never reached the
   * SDK reverts its durability write; any real attempt keeps its current state. */
  private async recordUncertainty(session: Session, dispatched: boolean, mayHaveRun: boolean) {
    if (!dispatched) {
      return;
    }
    if (!mayHaveRun) {
      session.interrupted = false;
      session.pendingRun = undefined;
    }
    await this.saveSession(session).catch(() => {
      // The error surfaced to the caller is the more useful failure.
    });
  }

  private closeAgent(agent: Agent) {
    if (this.closedAgents.has(agent)) {
      return;
    }
    this.closedAgents.add(agent);
    try {
      agent.close();
    } catch {
      /* SDK cleanup failure must not prevent releasing finished session locks. */
    }
  }

  private releaseLock(session: Session) {
    // Run completion and shutdown can both clean up; never remove a later owner's lock.
    session.unlock ??= session.release();
    return session.unlock;
  }

  async close() {
    this.closed = true;
    for (const exchange of this.exchanges.values()) {
      if (!exchange.settled) {
        exchange.controller.abort(new Error('Cursor gateway closed'));
      }
    }
    await bounded(
      Promise.allSettled([...this.exchanges.values()].map((exchange) => exchange.result)),
    );
    for (const session of this.sessions.values()) {
      this.closeAgent(session.agent);
      if (!session.busy) {
        await this.releaseLock(session);
      }
    }
    this.sessions.clear();
  }
}

/**
 * The newest turn: everything after the last assistant message (the newest user
 * message plus any trailing inline system reminders). The persistent SDK agent
 * already holds everything before it; only the delta needs to be sent on resume.
 */
function continuation(body: MessagesRequest): NonNullable<MessagesRequest['messages']> {
  const messages = body.messages ?? [];
  const lastAssistant = messages.findLastIndex((message) => message.role === 'assistant');
  if (lastAssistant === messages.length - 1) {
    throw new Error('Cursor continuation requires a message after the last assistant turn');
  }
  const delta = messages.slice(lastAssistant + 1);
  if (!delta.some((message) => message.role === 'user')) {
    throw new Error('Cursor continuation requires a new user message');
  }
  return delta;
}

/** True when the outer history no longer contains the previous turn's response. */
function historyRewound(
  session: Session,
  messages: NonNullable<MessagesRequest['messages']>,
): boolean {
  if (!session.response) {
    return false;
  }
  const expected = cursorHistoryHash([{ role: 'assistant', content: session.response.content }]);
  return !messages.some(
    (message) => message.role === 'assistant' && cursorHistoryHash([message]) === expected,
  );
}

async function observe(exchange: Exchange, signal: AbortSignal, emit?: Emit) {
  exchange.observers++;
  const aborted = Promise.withResolvers<never>();
  void aborted.promise.catch(() => {});
  const cancel = () => aborted.reject(signal.reason);
  signal.addEventListener('abort', cancel, { once: true });
  try {
    if (emit) {
      exchange.listeners.add(emit);
      for (const event of exchange.events) {
        emit(...event);
      }
    }
    signal.throwIfAborted();
    return await Promise.race([exchange.result, aborted.promise]);
  } finally {
    signal.removeEventListener('abort', cancel);
    if (emit) {
      exchange.listeners.delete(emit);
    }
    exchange.observers--;
    if (!exchange.observers && !exchange.settled) {
      exchange.controller.abort(new Error('All Cursor request observers disconnected'));
    }
  }
}

class HarnessResponse {
  private readonly response: MessagesResponse;
  private readonly emit: Emit;
  private activeTextIndex: number | undefined;
  private bytes = 0;

  constructor(model: string, inputTokens: number, emit: Emit) {
    this.emit = emit;
    this.response = {
      id: `msg_${randomUUID()}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    };
    emit('message_start', { message: structuredClone(this.response) });
  }

  text(text: string) {
    if (!text) {
      return;
    }
    this.bytes += Buffer.byteLength(text);
    if (this.bytes > 32 * 1024 * 1024) {
      throw new Error('Cursor run exceeded the 32 MiB output limit');
    }
    if (this.activeTextIndex === undefined) {
      this.activeTextIndex = this.response.content.length;
      this.response.content.push({ type: 'text', text: '' });
      this.emit('content_block_start', {
        index: this.activeTextIndex,
        content_block: { type: 'text', text: '' },
      });
    }
    const block = this.response.content[this.activeTextIndex];
    if (block.type === 'text') {
      block.text += text;
    }
    this.emit('content_block_delta', {
      index: this.activeTextIndex,
      delta: { type: 'text_delta', text },
    });
  }

  displayRow(event: ModDisplayEvent) {
    if (this.activeTextIndex !== undefined) {
      this.emit('content_block_stop', { index: this.activeTextIndex });
      this.activeTextIndex = undefined;
    }
    const index = this.response.content.length;
    this.response.content.push({
      type: 'tool_use',
      id: event.toolUseId,
      name: event.tool,
      input: event.input,
    });
    this.emit('content_block_start', {
      index,
      content_block: { type: 'tool_use', id: event.toolUseId, name: event.tool, input: {} },
    });
    this.emit('content_block_delta', {
      index,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(event.input) },
    });
    this.emit('content_block_stop', { index });
  }

  finish() {
    if (this.activeTextIndex !== undefined) {
      this.emit('content_block_stop', { index: this.activeTextIndex });
    }
    this.response.stop_reason = 'end_turn';
    this.response.usage.output_tokens = estimateTextTokens(JSON.stringify(this.response.content));
    this.emit('message_delta', {
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: this.response.usage,
    });
    this.emit('message_stop', {});
    return this.response;
  }
}

async function readSession(file: string): Promise<SavedSession | undefined> {
  const saved = (await readJson(file)) as Partial<SavedSession> | undefined;
  if (saved === undefined) {
    return undefined;
  }
  if (saved.version !== 2) {
    // The native SDK agent is never deleted; an older or unknown session file
    // is ignored and the session starts fresh instead of refusing to load.
    return undefined;
  }
  if (
    typeof saved.agentId !== 'string' ||
    !saved.agentId ||
    typeof saved.interrupted !== 'boolean' ||
    !validSessionReply(saved) ||
    !validPendingRun(saved.pendingRun)
  ) {
    throw new Error('Cursor session has invalid state; refusing to replay native actions');
  }
  return saved as SavedSession;
}

function validPendingRun(pending: PendingRun | undefined) {
  return (
    pending === undefined ||
    (pending !== null &&
      isHash(pending.key) &&
      typeof pending.model === 'string' &&
      Number.isSafeInteger(pending.inputTokens) &&
      pending.inputTokens >= 0 &&
      (pending.runId === undefined ||
        (typeof pending.runId === 'string' && pending.runId.length > 0)))
  );
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function validSessionReply(saved: Partial<SavedSession>) {
  if (saved.response === undefined && saved.replay === undefined) {
    return true;
  }
  return (
    typeof saved.response?.id === 'string' &&
    Array.isArray(saved.response.content) &&
    saved.response.content.every(
      (block) => block?.type === 'text' && typeof block.text === 'string',
    ) &&
    isHash(saved.replay?.key) &&
    Array.isArray(saved.replay?.events) &&
    saved.replay.events.every(
      (event) =>
        Array.isArray(event) &&
        event.length === 2 &&
        typeof event[0] === 'string' &&
        event[1] !== null &&
        typeof event[1] === 'object',
    )
  );
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function atomicJson(
  file: string,
  value: unknown,
  platform: NodeJS.Platform = process.platform,
) {
  await atomicWriteFile(file, JSON.stringify(value), { mode: 0o600, platform });
}

async function bounded(operation: Promise<unknown>) {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
