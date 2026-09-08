import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AgentOptions, Run, RunResult, SDKAgent } from '@cursor/sdk';
import type { WorkerPermissions } from '../../gateway/agent-definitions.ts';
import type {
  Emit,
  MessagesRequest,
  MessagesResponse,
  StreamEventBody,
  StreamEventName,
} from '../../gateway/messages.ts';
import type { PermissionContext } from '../../gateway/mode-hook.ts';
import { estimateTextTokens } from '../openai/tokens.ts';
import { CursorProviderError, cursorRunError } from './errors.ts';
import { type CursorModelOption, cursorSelection } from './models.ts';
import {
  cursorNativePermissions,
  cursorPermissionPolicy,
  mergeCursorPermissions,
} from './permissions.ts';
import { formatCursorProgress } from './progress.ts';
import { cursorHistoryHash, cursorTerminalSuffix, prepareCursorRequest } from './request.ts';
import { lockCursorSession } from './state-lock.ts';

type Agent = Pick<SDKAgent, 'agentId' | 'send' | 'close'>;
export type CreateCursorHarnessAgent = (options: AgentOptions) => Promise<Agent>;
type PendingRun = {
  key: string;
  runId?: string;
  historyLength: number;
  historyHash: string;
  model: string;
  inputTokens: number;
  submissionId?: string;
};
type SavedSession = {
  version: 1;
  agentId: string;
  historyLength: number;
  historyHash: string;
  response?: MessagesResponse;
  replay?: { key: string; events: Event[] };
  instructions: string;
  pending: boolean;
  pendingRun?: PendingRun;
  submissionId?: string;
  needsPrompt?: boolean;
};
type Event = [StreamEventName, StreamEventBody];
type Session = {
  agent: Agent;
  file: string;
  historyLength: number;
  historyHash: string;
  response?: MessagesResponse;
  replay?: { key: string; events: Event[] };
  instructions: string;
  busy: boolean;
  run?: Run;
  failed: boolean;
  unlock?: Promise<void>;
  release: () => Promise<void>;
  pendingRun?: PendingRun;
  submissionId?: string;
  needsPrompt?: boolean;
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
};
const hash = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(value) ?? 'null')
    .digest('hex');

/** Cursor owns state, tools and review. External actions are display-only text. */
export class CursorHarness {
  private readonly options: Map<string, CursorModelOption>;
  private readonly sessions = new Map<string, Session>();
  private readonly exchanges = new Map<string, Exchange>();
  private readonly creating = new Set<string>();
  private cwd: string;
  private readonly stateDirectory: string;
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
      stateDirectory = path.join(homedir(), '.cursor', 'multi-harness'),
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
      createAgent?: CreateCursorHarnessAgent;
      resumeAgent?: (id: string, config: AgentOptions) => Promise<Agent>;
    } = {},
  ) {
    this.options = new Map(options.map((option) => [option.model, option]));
    this.cwd = cwd;
    this.checkPermissions = checkPermissions;
    this.getRun = getRun;
    this.stateDirectory = stateDirectory;
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
      exchange = this.startExchange(body, scope, key, permissions);
      this.exchanges.set(key, exchange);
    }
    return observe(exchange, signal, emit);
  }

  private startExchange(
    body: MessagesRequest,
    scope: string,
    key: string,
    context: PermissionContext,
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
    const current = await readSession(this.sessionFile(scope));
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
    const failure = await readJson(path.join(this.stateDirectory, `${key}.failure.json`));
    if (failure !== undefined) {
      throw new CursorProviderError(failure);
    }
    if (current?.pending) {
      await this.recoverSession(scope);
      return this.cachedExecute(body, scope, key, exchange, emit, context);
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

  private async recoverSession(scope: string): Promise<void> {
    if (this.sessions.has(scope) || this.creating.has(scope)) {
      throw new Error('Cursor run is still owned by this gateway; wait for it to finish');
    }
    const file = this.sessionFile(scope);
    const release = await lockCursorSession(`${file}.lock`);
    try {
      const saved = await readSession(file);
      if (!saved?.pending) {
        return;
      }
      const pending = saved.pendingRun;
      if (!pending?.runId) {
        throw new Error(
          'Cursor interrupted run has no durable SDK run identity; refusing to replay native actions',
        );
      }
      const run = await this.getRun(pending.runId, this.cwd);
      if (run.id !== pending.runId || run.agentId !== saved.agentId) {
        throw new Error('Cursor recovery run identity does not match its session');
      }
      if (run.status === 'running' || !run.supports('wait')) {
        throw new Error(
          'Cursor interrupted run has no readable terminal result; native state is preserved',
        );
      }
      const result = await run.wait();
      if (result.id !== pending.runId) {
        throw new Error('Cursor recovery result identity does not match its run');
      }
      if (result.status !== 'finished') {
        await atomicJson(
          path.join(this.stateDirectory, `${pending.key}.failure.json`),
          cursorRunError(result).failure,
        );
        await atomicJson(file, {
          ...saved,
          pending: false,
          pendingRun: undefined,
          submissionId: pending.submissionId,
          needsPrompt: true,
        });
        return;
      }
      const events: Event[] = [];
      const response = new HarnessResponse(pending.model, pending.inputTokens, (name, value) => {
        events.push([name, structuredClone(value)]);
      });
      response.text(result.result ?? '');
      await atomicJson(file, {
        ...saved,
        pending: false,
        pendingRun: undefined,
        historyLength: pending.historyLength,
        historyHash: pending.historyHash,
        submissionId: pending.submissionId,
        needsPrompt: false,
        response: response.finish(),
        replay: { key: pending.key, events },
      });
    } finally {
      await release();
    }
  }

  private async session(scope: string, body: MessagesRequest, context: PermissionContext) {
    if (this.sessions.get(scope)?.busy || this.creating.has(scope)) {
      throw new Error('A different request is already running for this Cursor agent');
    }
    this.creating.add(scope);
    try {
      const session = this.sessions.get(scope) ?? (await this.loadSession(scope, body, context));
      if (session.failed) {
        throw new Error('Cursor previous run failed; refusing to replay native work');
      }
      const messages =
        session.response || session.needsPrompt
          ? continuation(session, body, context)
          : body.messages;
      const reconciled =
        session.needsPrompt ||
        (session.response &&
          cursorHistoryHash(body.messages?.slice(0, session.historyLength)) !==
            session.historyHash);
      session.busy = true;
      return { session, messages, reconciled };
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
    const release = await lockCursorSession(`${file}.lock`);
    let agent: Agent | undefined;
    try {
      const saved = await readSession(file);
      if (saved?.pending) {
        throw new Error('Cursor session has an interrupted run; refusing to replay native actions');
      }
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
        historyLength: saved?.historyLength ?? 0,
        historyHash: saved?.historyHash ?? cursorHistoryHash([]),
        response: saved?.response,
        replay: saved?.replay,
        instructions: saved?.instructions ?? systemHash(body),
        busy: false,
        failed: false,
        release,
        submissionId: saved?.submissionId,
        needsPrompt: saved?.needsPrompt,
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

  private saveSession(session: Session, pending = false) {
    return atomicJson(session.file, {
      version: 1,
      agentId: session.agent.agentId,
      historyLength: session.historyLength,
      historyHash: session.historyHash,
      response: session.response,
      replay: session.replay,
      instructions: session.instructions,
      pending,
      pendingRun: pending ? session.pendingRun : undefined,
      submissionId: session.submissionId,
      needsPrompt: session.needsPrompt,
    });
  }

  private async archiveReply(session: Session) {
    if (session.replay && session.response) {
      // Archive the previous reply before replacing the single atomic session commit.
      await atomicJson(path.join(this.stateDirectory, `${session.replay.key}.response.json`), {
        response: session.response,
        events: session.replay.events,
      });
    }
  }

  private async persistDispatch(
    session: Session,
    body: MessagesRequest,
    context: PermissionContext,
    key: string,
    inputTokens: number,
  ) {
    session.pendingRun = {
      key,
      inputTokens,
      historyLength: body.messages?.length ?? 0,
      historyHash: cursorHistoryHash(body.messages ?? []),
      model: body.model ?? '',
      submissionId: context.submission?.id,
    };
    await this.saveSession(session, true);
    return session.pendingRun;
  }

  private async clearUnsentRun(session: Session, unsent: boolean) {
    if (unsent) {
      session.failed = true;
      await this.saveSession(session);
      session.failed = false;
    }
  }

  private async recordFailure(session: Session, result: RunResult | undefined) {
    const pending = session.pendingRun;
    if (!pending || !result || result.status === 'finished') {
      return;
    }
    await atomicJson(
      path.join(this.stateDirectory, `${pending.key}.failure.json`),
      cursorRunError(result).failure,
    );
    session.submissionId = pending.submissionId;
    session.needsPrompt = true;
    await this.saveSession(session);
    session.failed = false;
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
    const { session, messages, reconciled } = await this.session(scope, body, context);
    let text = '';
    let cancelled = false;
    let pending = false;
    let terminalResult: RunResult | undefined;
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
      const stream = new HarnessResponse(body.model ?? '', prepared.inputTokens, emit);
      if (reconciled) {
        stream.text(
          '[Cursor] Continuing with retained native history; outer history edits or compaction did not undo prior actions.\n',
        );
      }
      signal.throwIfAborted();
      if (this.closed) {
        throw new Error('Cursor harness is closed');
      }
      await this.configureSession(session, body, context);
      await this.archiveReply(session);
      const dispatch = await this.persistDispatch(
        session,
        body,
        context,
        replay.key,
        prepared.inputTokens,
      );
      pending = true;
      signal.throwIfAborted();
      exchange.mayHaveRun = true;
      session.run = await session.agent.send(prepared.prompt, {
        model: this.selection(body),
        mode: cursorPermissionPolicy(context).mode,
        onDelta: ({ update }) => {
          signal.throwIfAborted();
          if (update.type === 'text-delta') {
            text += update.text;
            stream.text(update.text);
          } else {
            const progress = formatCursorProgress(update);
            if (progress) {
              stream.text(`\n${progress}\n`);
            }
          }
        },
      });
      dispatch.runId = session.run.id;
      await this.saveSession(session, true);
      if (signal.aborted) {
        cancel();
      }
      const result = await session.run.wait();
      terminalResult = result;
      signal.throwIfAborted();
      if (result.status !== 'finished') {
        throw cursorRunError(result);
      }
      stream.text(cursorTerminalSuffix(text, result.result ?? ''));
      const response = stream.finish();
      session.historyLength = body.messages?.length ?? 0;
      session.historyHash = cursorHistoryHash(body.messages ?? []);
      session.response = response;
      session.replay = replay;
      session.submissionId = context.submission?.id;
      session.needsPrompt = false;
      // Completion and its replayable HTTP reply must commit together.
      await this.saveSession(session);
      exchange.committed = true;
      return response;
    } catch (error) {
      session.failed = exchange.mayHaveRun;
      await this.clearUnsentRun(session, pending && !exchange.mayHaveRun);
      cancel();
      await this.recordFailure(session, terminalResult);
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

function continuation(session: Session, body: MessagesRequest, context: PermissionContext) {
  const messages = body.messages ?? [];
  if (session.failed || session.instructions !== systemHash(body)) {
    throw new Error(
      'Cursor session instructions changed or its previous run failed; use a new session',
    );
  }
  const count = session.historyLength;
  if (
    session.needsPrompt ||
    !session.response ||
    cursorHistoryHash(messages.slice(0, count)) !== session.historyHash
  ) {
    return reconcileHistory(session, body, context);
  }
  const assistant = messages[count];
  const expected = [{ role: 'assistant', content: session.response.content }];
  if (!assistant || cursorHistoryHash([assistant]) !== cursorHistoryHash(expected)) {
    throw new Error(
      'Cursor continuation does not match its previous response; refusing to replay history',
    );
  }
  const delta = messages.slice(count + 1);
  if (!delta.length) {
    throw new Error('Cursor continuation contains no new message');
  }
  return delta;
}

function plainText(content: unknown): string | undefined {
  if (
    !Array.isArray(content) ||
    !content.every((block) => block?.type === 'text' && typeof block.text === 'string')
  ) {
    return undefined;
  }
  return content.map((block) => block.text).join('');
}

function reconcileHistory(session: Session, body: MessagesRequest, context: PermissionContext) {
  const messages = body.messages ?? [];
  const last = messages.at(-1);
  const content = last?.content;
  const text = typeof content === 'string' ? content : plainText(content);
  const submission = context.submission;
  if (
    last?.role === 'user' &&
    text !== undefined &&
    submission &&
    submission.id !== session.submissionId &&
    createHash('sha256').update(text).digest('hex') === submission.promptHash
  ) {
    // The hook proves this is a newly submitted prompt. Keep SDK history intact;
    // neither the external summary nor rewritten prior actions are new work.
    return [last];
  }
  if (!session.needsPrompt && session.response) {
    const expected = cursorHistoryHash([{ role: 'assistant', content: session.response.content }]);
    const anchors = messages.flatMap((message, index) =>
      cursorHistoryHash([message]) === expected ? [index] : [],
    );
    if (anchors.length === 1 && anchors[0] < messages.length - 1) {
      return messages.slice(anchors[0] + 1);
    }
  }
  throw new Error(
    'Cursor history changed or was compacted externally without a new observed prompt or unique response anchor; native state is preserved',
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
  private started = false;
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
    if (!this.started) {
      this.started = true;
      this.response.content.push({ type: 'text', text: '' });
      this.emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    }
    const block = this.response.content[0];
    if (block.type === 'text') {
      block.text += text;
    }
    this.emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
  }

  finish() {
    if (this.started) {
      this.emit('content_block_stop', { index: 0 });
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
  if (
    saved?.version !== 1 ||
    typeof saved.agentId !== 'string' ||
    !saved.agentId ||
    !Number.isSafeInteger(saved.historyLength) ||
    typeof saved.historyLength !== 'number' ||
    saved.historyLength < 0 ||
    !isHash(saved.historyHash) ||
    !isHash(saved.instructions) ||
    typeof saved.pending !== 'boolean' ||
    !validSessionReply(saved) ||
    !validPendingRun(saved.pendingRun) ||
    (saved.needsPrompt !== undefined && typeof saved.needsPrompt !== 'boolean') ||
    (saved.submissionId !== undefined && typeof saved.submissionId !== 'string')
  ) {
    throw new Error(
      'Cursor session has incompatible or invalid state; refusing to replay native actions',
    );
  }
  return saved as SavedSession;
}

function validPendingRun(pending: PendingRun | undefined) {
  return (
    pending === undefined ||
    (pending !== null &&
      isHash(pending.key) &&
      isHash(pending.historyHash) &&
      Number.isSafeInteger(pending.historyLength) &&
      pending.historyLength > 0 &&
      typeof pending.model === 'string' &&
      Number.isSafeInteger(pending.inputTokens) &&
      pending.inputTokens >= 0 &&
      (pending.runId === undefined ||
        (typeof pending.runId === 'string' && pending.runId.length > 0)) &&
      (pending.submissionId === undefined || typeof pending.submissionId === 'string'))
  );
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function validSessionReply(saved: Partial<SavedSession>) {
  if (saved.response === undefined && saved.replay === undefined) {
    return saved.historyLength === 0 && saved.historyHash === cursorHistoryHash([]);
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

async function atomicJson(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, file);
}

function systemHash(body: MessagesRequest) {
  return cursorHistoryHash([{ role: 'system', content: body.system ?? '' }]);
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
