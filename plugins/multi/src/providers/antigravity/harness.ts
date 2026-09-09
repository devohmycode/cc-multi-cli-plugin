import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type {
  Emit,
  MessagesRequest,
  MessagesResponse,
  RequestMessage,
  StreamEventBody,
  StreamEventName,
} from '../../gateway/messages.ts';
import type { PermissionContext } from '../../gateway/mode-hook.ts';
import { lockCursorSession } from '../cursor/state-lock.ts';
import type {
  AntigravityResult,
  AntigravityRunOptions,
  AntigravityRunResult,
  AntigravityStreamEvent,
  AntigravityUsage,
} from './cli.ts';
import { runAntigravity } from './cli.ts';
import type { AntigravityModel } from './models.ts';
import { selectAntigravityModel } from './models.ts';
import type { AntigravityPolicy } from './permissions.ts';
import {
  antigravityHistoryHash,
  antigravitySystem,
  antigravityTerminalSuffix,
  prepareAntigravityRequest,
} from './request.ts';

export type AntigravityRunner = (options: AntigravityRunOptions) => Promise<AntigravityRunResult>;

export type CheckAntigravityPermissions = (
  cwd: string,
  context: PermissionContext,
) => Promise<AntigravityPolicy>;

type Event = [StreamEventName, StreamEventBody];
type Pending = {
  key: string;
  conversationId?: string;
  historyLength: number;
  historyHash: string;
  model: string;
  inputTokens: number;
  submissionId?: string;
};
type Saved = {
  version: 1;
  provider: 'antigravity';
  identity: string;
  historyLength: number;
  historyHash: string;
  instructions: string;
  response?: MessagesResponse;
  replay?: { key: string; events: Event[] };
  pending: boolean;
  pendingRun?: Pending;
  conversationId?: string;
  usage?: AntigravityUsage;
  submissionId?: string;
  needsPrompt?: boolean;
  policyIdentity?: string;
};
type Session = Saved & {
  file: string;
  busy: boolean;
  release: () => Promise<void>;
  unlock?: Promise<void>;
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

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const textDigest = (value: string) => createHash('sha256').update(value).digest('hex');

function modelEffort(model: AntigravityModel): AntigravityRunOptions['effort'] {
  if (model.effort) {
    return model.effort;
  }
  const suffix = model.id.split('-').at(-1);
  return suffix === 'low' || suffix === 'medium' || suffix === 'high' ? suffix : undefined;
}

function toolsForRun(policy: AntigravityPolicy, context: PermissionContext) {
  return context.compaction === undefined ? policy.tools : [];
}

function noticeForRun(policy: AntigravityPolicy, context: PermissionContext) {
  return context.compaction === undefined
    ? policy.notice
    : 'Compaction summary; native tools disabled.';
}

function requestSystem(
  body: MessagesRequest,
  session: Session,
  context: PermissionContext,
): MessagesRequest['system'] {
  return context.compaction !== undefined || !session.conversationId ? body.system : undefined;
}

export class AntigravityHarness {
  private readonly models: readonly AntigravityModel[];
  private readonly defaultCwd: string;
  private readonly stateDirectory: string;
  private readonly run: AntigravityRunner;
  private readonly checkPermissions: CheckAntigravityPermissions;
  private readonly sessions = new Map<string, Session>();
  private readonly exchanges = new Map<string, Exchange>();
  private readonly creating = new Set<string>();
  private readonly loading = new Set<string>();
  private closed = false;

  constructor(
    models: readonly AntigravityModel[],
    {
      cwd = process.cwd(),
      stateDirectory = path.join(homedir(), '.gemini', 'antigravity-cli', 'multi-harness'),
      run = runAntigravity,
      checkPermissions,
    }: {
      cwd?: string;
      stateDirectory?: string;
      run?: AntigravityRunner;
      checkPermissions?: CheckAntigravityPermissions;
    } = {},
  ) {
    this.models = models;
    this.defaultCwd = cwd;
    this.stateDirectory = stateDirectory;
    this.run = run;
    this.checkPermissions = checkPermissions ?? missingPermissions;
  }

  private selection(body: MessagesRequest) {
    return selectAntigravityModel(this.models, body.model, body.output_config?.effort);
  }

  validate(body: MessagesRequest) {
    const model = this.selection(body);
    return prepareAntigravityRequest(body, model.id).inputTokens;
  }

  async handle(
    body: MessagesRequest,
    scope: string,
    signal: AbortSignal,
    emit?: Emit,
    context?: PermissionContext,
  ): Promise<MessagesResponse> {
    if (this.closed) {
      throw new Error('Antigravity harness is closed');
    }
    signal.throwIfAborted();
    if (!context) {
      throw new Error('Antigravity requires an explicit Claude permission context');
    }
    const model = this.selection(body);
    this.validate(body);
    const cwd = await realpath(context.cwd ?? this.defaultCwd);
    const identity = `${cwd}\0${scope}`;
    const key = digest([
      'antigravity',
      identity,
      {
        ...body,
        stream: undefined,
        messages: antigravityHistoryHash(body.messages),
        system: systemHash(body),
      },
      {
        permissionMode: context.permissionMode,
        tools: context.tools,
        disallowedTools: context.disallowedTools,
        nativePermissionError: context.nativePermissionError,
        compaction: context.compaction,
      },
    ]);
    let exchange = this.exchanges.get(key);
    if (!exchange) {
      if (this.exchanges.size >= 256) {
        throw new Error('Too many concurrent Antigravity requests');
      }
      exchange = this.startExchange(body, scope, context, model, cwd, identity, key);
      this.exchanges.set(key, exchange);
    }
    return observe(exchange, signal, emit);
  }

  private startExchange(
    body: MessagesRequest,
    scope: string,
    context: PermissionContext,
    model: AntigravityModel,
    cwd: string,
    identity: string,
    key: string,
  ): Exchange {
    const controller = new AbortController();
    const events: Event[] = [];
    const listeners = new Set<Emit>();
    const forward: Emit = (name, value) => {
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
        this.cachedExecute(body, scope, context, model, cwd, identity, key, exchange, forward),
      ),
    };
    void exchange.result.then(
      () => {
        exchange.settled = true;
        if (this.exchanges.get(key) === exchange) {
          this.exchanges.delete(key);
        }
      },
      () => {
        exchange.settled = true;
        if (this.exchanges.get(key) === exchange) {
          this.exchanges.delete(key);
        }
      },
    );
    return exchange;
  }

  private async cachedExecute(
    body: MessagesRequest,
    scope: string,
    context: PermissionContext,
    model: AntigravityModel,
    cwd: string,
    identity: string,
    key: string,
    exchange: Exchange,
    emit: Emit,
  ) {
    let saved = this.sessions.get(identity);
    if (!saved) {
      if (this.loading.has(identity)) {
        throw new Error('A different request is already loading this Antigravity agent');
      }
      this.loading.add(identity);
      try {
        saved = await this.loadSession(body, identity);
      } finally {
        this.loading.delete(identity);
      }
    }
    if (saved.pending) {
      throw new Error(
        'Antigravity interrupted run has unknown completion; refusing to rerun native actions',
      );
    }
    const persisted =
      saved?.replay?.key === key
        ? { response: saved.response, events: saved.replay.events }
        : await readJson(path.join(this.stateDirectory, `${key}.response.json`));
    if (persisted !== undefined) {
      if (!validPersistedResponse(persisted)) {
        throw new Error('Invalid persisted Antigravity response');
      }
      const replay = persisted;
      for (const event of replay.events) {
        emit(...event);
      }
      return replay.response;
    }
    const failure = await readJson(path.join(this.stateDirectory, `${key}.failure.json`));
    if (failure !== undefined) {
      throw new AntigravityProviderError(failure);
    }
    return this.execute(body, scope, context, model, cwd, identity, key, exchange, emit);
  }

  private async execute(
    body: MessagesRequest,
    scope: string,
    context: PermissionContext,
    model: AntigravityModel,
    cwd: string,
    identity: string,
    key: string,
    exchange: Exchange,
    emit: Emit,
  ): Promise<MessagesResponse> {
    const { session, messages, reconciled } = await this.session(
      body,
      scope,
      context,
      cwd,
      identity,
    );
    const signal = exchange.controller.signal;
    const initSaves: Promise<void>[] = [];
    try {
      const prepared = prepareAntigravityRequest(
        { ...body, messages, system: requestSystem(body, session, context) },
        model.id,
      );
      const policy = await this.checkPermissions(cwd, context);
      const nativeTools = toolsForRun(policy, context);
      const notice = noticeForRun(policy, context);
      const response = new HarnessResponse(body.model ?? model.model, prepared.inputTokens, emit);
      const policyIdentity = digest({
        tools: nativeTools,
        mode: policy.mode,
        bypass: policy.bypass,
        notice,
      });
      writeNotices(response, session, reconciled, notice, policyIdentity);
      session.policyIdentity = policyIdentity;
      session.pending = true;
      const pending: Pending = {
        key,
        conversationId: session.conversationId,
        historyLength: body.messages?.length ?? 0,
        historyHash: antigravityHistoryHash(body.messages ?? []),
        model: model.id,
        inputTokens: prepared.inputTokens,
        submissionId: context.submission?.id,
      };
      session.pendingRun = pending;
      await this.saveSession(session);
      signal.throwIfAborted();
      exchange.mayHaveRun = true;
      let streamed = '';
      const startedAt = performance.now();
      const outcome = await this.run({
        cwd,
        prompt: prepared.prompt,
        model: model.id,
        effort: modelEffort(model),
        ...(session.conversationId ? { conversation: session.conversationId } : {}),
        mode: policy.mode,
        bypass: policy.bypass,
        env: { ...process.env, MULTI_ANTIGRAVITY_TOOLS: JSON.stringify(nativeTools) },
        signal,
        onEvent: (event) =>
          this.eventText(
            event,
            response,
            (text) => {
              streamed += text;
            },
            (conversationId) => {
              session.conversationId = conversationId;
              pending.conversationId = conversationId;
              const save = this.saveSession(session);
              initSaves.push(save);
              void save.catch((error: unknown) => {
                exchange.controller.abort(error);
              });
            },
          ),
      });
      await awaitSaves(initSaves);
      const result = outcome.result;
      session.conversationId = result.conversation_id;
      appendDiagnostics(response, result, outcome.stderr, performance.now() - startedAt);
      if (result.status !== 'SUCCESS') {
        await this.recordFailure(session, result);
        throw new AntigravityProviderError(result.error ?? `Antigravity run ${result.status}`);
      }
      response.text(antigravityTerminalSuffix(streamed, result.response));
      const finished = response.finish(usageDelta(result.usage, session.usage));
      const terminalEvents = response.takeTerminalEvents();
      session.pending = false;
      session.pendingRun = undefined;
      session.conversationId = result.conversation_id;
      session.usage = result.usage;
      session.historyLength = body.messages?.length ?? 0;
      session.historyHash = antigravityHistoryHash(body.messages ?? []);
      session.response = finished;
      session.replay = {
        key,
        events: [
          ...exchange.events,
          ...terminalEvents.map(([name, value]) => [name, structuredClone(value)] as Event),
        ],
      };
      session.submissionId = context.submission?.id;
      session.needsPrompt = false;
      await this.saveSession(session);
      await atomicJson(path.join(this.stateDirectory, `${key}.response.json`), {
        response: finished,
        events: session.replay.events,
      });
      exchange.committed = true;
      for (const event of terminalEvents) {
        emit(...event);
      }
      return finished;
    } catch (error) {
      if (error instanceof AntigravityProviderError) {
        throw error;
      }
      throw new AntigravityProviderError(error);
    } finally {
      await Promise.allSettled(initSaves);
      session.busy = false;
      if (this.closed) {
        await this.releaseLock(session);
      }
    }
  }

  private eventText(
    event: AntigravityStreamEvent,
    response: HarnessResponse,
    add: (text: string) => void,
    init: (conversationId: string) => void,
  ) {
    if (event.event === 'init') {
      init(event.conversation_id);
      return;
    }
    if (event.event !== 'step_update') {
      return;
    }
    const update = event.step_update;
    if (typeof update.text_delta === 'string') {
      add(update.text_delta);
      response.text(update.text_delta);
    } else if (typeof update.tool_name === 'string') {
      const detail = [
        update.step_type,
        update.duration_seconds !== undefined ? `${update.duration_seconds}s` : undefined,
        update.tool_info ? safeText(JSON.stringify(update.tool_info)) : undefined,
      ]
        .filter(Boolean)
        .join(' · ');
      response.text(`\n[Antigravity] ${update.tool_name}${detail ? ` (${detail})` : ''}\n`);
    }
  }

  private async session(
    body: MessagesRequest,
    _scope: string,
    context: PermissionContext,
    _cwd: string,
    identity: string,
  ) {
    const current = this.sessions.get(identity);
    if (current?.busy || this.creating.has(identity)) {
      throw new Error('A different request is already running for this Antigravity agent');
    }
    this.creating.add(identity);
    try {
      const session = current ?? (await this.loadSession(body, identity));
      const messages =
        session.response || session.needsPrompt
          ? continuation(session, body, context)
          : body.messages;
      const reconciled =
        !!session.needsPrompt ||
        (!!session.response &&
          antigravityHistoryHash(body.messages?.slice(0, session.historyLength)) !==
            session.historyHash);
      session.busy = true;
      return { session, messages, reconciled };
    } finally {
      this.creating.delete(identity);
    }
  }

  private sessionFile(identity: string) {
    return path.join(this.stateDirectory, `${digest(identity)}.session.json`);
  }

  private async loadSession(body: MessagesRequest, identity: string): Promise<Session> {
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    const file = this.sessionFile(identity);
    const release = await lockCursorSession(`${file}.lock`);
    try {
      const saved = await readSession(file);
      if (saved?.pending) {
        throw new Error(
          'Antigravity interrupted run has unknown completion; refusing native replay',
        );
      }
      const session: Session = {
        ...(saved ?? {
          version: 1,
          provider: 'antigravity',
          identity,
          historyLength: 0,
          historyHash: antigravityHistoryHash([]),
          instructions: systemHash(body),
          pending: false,
        }),
        file,
        busy: false,
        release,
      };
      this.sessions.set(identity, session);
      return session;
    } catch (error) {
      await release();
      throw error;
    }
  }

  private saveSession(session: Session) {
    const { file: _file, busy: _busy, release: _release, unlock: _unlock, ...saved } = session;
    return atomicJson(session.file, { ...saved, provider: 'antigravity' });
  }

  private async recordFailure(session: Session, result: AntigravityResult) {
    const pending = session.pendingRun;
    if (!pending) {
      return;
    }
    await atomicJson(path.join(this.stateDirectory, `${pending.key}.failure.json`), {
      status: 502,
      message: result.error ?? `Antigravity run ${result.status}`,
    });
    session.pending = false;
    session.pendingRun = undefined;
    session.needsPrompt = true;
    await this.saveSession(session);
  }

  private releaseLock(session: Session) {
    session.unlock ??= session.release();
    return session.unlock;
  }

  async close() {
    this.closed = true;
    const running: Promise<MessagesResponse>[] = [];
    for (const exchange of this.exchanges.values()) {
      if (!exchange.settled) {
        exchange.controller.abort(new Error('Antigravity gateway closed'));
        running.push(exchange.result);
      }
    }
    await Promise.allSettled(running);
    for (const session of this.sessions.values()) {
      await this.releaseLock(session);
    }
    this.sessions.clear();
  }
}

class HarnessResponse {
  private readonly response: MessagesResponse;
  private readonly emit: Emit;
  private readonly terminalEvents: Event[] = [];
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
  text(value: string) {
    if (!value) {
      return;
    }
    this.bytes += Buffer.byteLength(value);
    if (this.bytes > 32 * 1024 * 1024) {
      throw new Error('Antigravity run exceeded the 32 MiB output limit');
    }
    if (!this.started) {
      this.started = true;
      this.response.content.push({ type: 'text', text: '' });
      this.emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    }
    const block = this.response.content[0];
    if (block.type === 'text') {
      block.text += value;
    }
    this.emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: value } });
  }
  finish(usage?: AntigravityUsage) {
    if (this.started) {
      this.emit('content_block_stop', { index: 0 });
    }
    this.response.stop_reason = 'end_turn';
    this.response.usage.input_tokens = usage?.input_tokens ?? this.response.usage.input_tokens;
    this.response.usage.output_tokens =
      usage?.output_tokens ?? Math.ceil(JSON.stringify(this.response.content).length / 4);
    if (usage?.cache_read_tokens !== undefined) {
      this.response.usage.cache_read_input_tokens = usage.cache_read_tokens;
    }
    this.terminalEvents.push([
      'message_delta',
      {
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: this.response.usage,
      },
    ]);
    this.terminalEvents.push(['message_stop', {}]);
    return this.response;
  }
  takeTerminalEvents() {
    return this.terminalEvents.splice(0);
  }
}

function appendDiagnostics(
  response: HarnessResponse,
  result: AntigravityResult,
  stderr: string,
  elapsedMs: number,
) {
  if (Number.isFinite(elapsedMs)) {
    response.text(`[Antigravity] completed in ${(Math.max(0, elapsedMs) / 1000).toFixed(1)}s\n`);
  }
  const denied = result.denied_actions;
  if (Array.isArray(denied) && denied.length) {
    const detail = denied
      .map((action) => {
        if (action && typeof action === 'object') {
          const value = action as Record<string, unknown>;
          return [value.display_name, value.action, value.reason]
            .filter((item) => typeof item === 'string')
            .join(':');
        }
        return String(action);
      })
      .join(', ');
    response.text(`[Antigravity] denied actions: ${safeText(detail)}\n`);
  }
  const diagnostics = stderr
    .split(/\r?\n/)
    .filter((line) => /warn|error|denied|permission|fail/i.test(line))
    .join('\n');
  if (diagnostics.trim()) {
    response.text(`[Antigravity] ${safeText(diagnostics)}\n`);
  }
}

function usageDelta(current: AntigravityUsage | undefined, previous: AntigravityUsage | undefined) {
  if (!current || !previous) {
    return current;
  }
  const delta: AntigravityUsage = {};
  for (const key of [
    'input_tokens',
    'output_tokens',
    'thinking_tokens',
    'cache_read_tokens',
    'total_tokens',
  ] as const) {
    const value = current[key];
    const old = previous[key];
    if (value !== undefined) {
      delta[key] = old !== undefined && value >= old ? value - old : value;
    }
  }
  return delta;
}

async function awaitSaves(saves: readonly Promise<void>[]) {
  const results = await Promise.allSettled(saves);
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') {
    throw failure.reason;
  }
}

function writeNotices(
  response: HarnessResponse,
  session: Session,
  reconciled: boolean,
  notice: string,
  policyIdentity: string,
) {
  if (!session.response || session.policyIdentity !== policyIdentity) {
    response.text(`[Antigravity] ${notice}\n`);
  }
  if (reconciled) {
    response.text(
      '[Antigravity] Continuing with retained native history; outer history changes did not undo prior actions.\n',
    );
  }
}

function safeText(value: string) {
  return (
    value
      .replace(/bearer\s+[^\s]+/gi, 'Bearer [redacted]')
      .replace(/((?:api[_-]?key|token|password|secret)[=:])[^\s,;]+/gi, '$1[redacted]')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: diagnostics must remove terminal control bytes.
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500)
  );
}

function continuation(session: Session, body: MessagesRequest, context: PermissionContext) {
  if (context.compaction === undefined && session.instructions !== systemHash(body)) {
    throw new Error('Antigravity session instructions changed; use a new session');
  }
  const messages = body.messages ?? [];
  const count = session.historyLength;
  if (
    session.needsPrompt ||
    !session.response ||
    antigravityHistoryHash(messages.slice(0, count)) !== session.historyHash
  ) {
    return reconcileHistory(session, messages, context);
  }
  const assistant = messages[count];
  const expected = antigravityHistoryHash([
    { role: 'assistant', content: session.response.content },
  ]);
  if (!assistant || antigravityHistoryHash([assistant]) !== expected) {
    throw new Error('Antigravity continuation does not match its previous response');
  }
  const delta = messages.slice(count + 1);
  if (!delta.length) {
    throw new Error('Antigravity continuation contains no new message');
  }
  return delta;
}

function systemHash(body: MessagesRequest) {
  return antigravityHistoryHash([
    { role: 'system', content: antigravitySystem(body.system) ?? '' },
  ]);
}

function reconcileHistory(
  session: Session,
  messages: NonNullable<MessagesRequest['messages']>,
  context: PermissionContext,
) {
  if (context.compaction !== undefined) {
    if (!context.compaction || context.compaction.length > 128) {
      throw new Error('Invalid Antigravity compaction marker');
    }
    // PreCompact is an authenticated Claude hook event. Claude may replace the
    // outer history and system prompt while asking the provider for a summary;
    // retain the native conversation and pass only this bounded summary request.
    return messages;
  }
  if (context.submission && context.submission.id !== session.submissionId) {
    const userIndex = messages.findLastIndex((message) => message.role === 'user');
    const content = authenticatedContent(
      messages[userIndex]?.content,
      context.submission.promptHash,
    );
    if (
      userIndex >= 0 &&
      content !== undefined &&
      messages.slice(userIndex + 1).every((message) => message.role === 'system')
    ) {
      // Claude may append inline system reminders after the authenticated prompt.
      // Keep those records with the prompt; they are part of this request's context.
      return [{ ...messages[userIndex], content }, ...messages.slice(userIndex + 1)];
    }
  }
  const expected = antigravityHistoryHash([
    { role: 'assistant', content: session.response?.content ?? [] },
  ]);
  const anchors = messages.flatMap((message, index) =>
    antigravityHistoryHash([message]) === expected ? [index] : [],
  );
  if (anchors.length === 1 && anchors[0] < messages.length - 1) {
    return messages.slice(anchors[0] + 1);
  }
  throw new Error(
    'Antigravity history changed without an authenticated prompt or unique response anchor; native state is preserved',
  );
}

function authenticatedContent(content: RequestMessage['content'] | undefined, hash: string) {
  const text = plainText(content);
  if (text !== undefined && textDigest(text) === hash) {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  // Claude can merge the compact summary and the fresh prompt into one user
  // message. Match an exact text block, never a substring of historical text.
  const index = content.findLastIndex(
    (block) =>
      block.type === 'text' && typeof block.text === 'string' && textDigest(block.text) === hash,
  );
  return index < 0 ? undefined : content.slice(index);
}

function plainText(content: unknown): string | undefined {
  if (typeof content === 'string') {
    return content;
  }
  if (
    Array.isArray(content) &&
    content.every(
      (block) =>
        block &&
        typeof block === 'object' &&
        'type' in block &&
        block.type === 'text' &&
        'text' in block &&
        typeof block.text === 'string',
    )
  ) {
    return content.map((block) => (block as { text: string }).text).join('');
  }
  return undefined;
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
      exchange.controller.abort(new Error('All Antigravity observers disconnected'));
    }
  }
}

async function readSession(file: string): Promise<Saved | undefined> {
  const saved = (await readJson(file)) as Partial<Saved> | undefined;
  if (saved === undefined) {
    return undefined;
  }
  if (
    saved.version !== 1 ||
    saved.provider !== 'antigravity' ||
    typeof saved.identity !== 'string' ||
    !isHash(saved.historyHash) ||
    !Number.isSafeInteger(saved.historyLength) ||
    !isHash(saved.instructions) ||
    (saved.policyIdentity !== undefined && !isHash(saved.policyIdentity)) ||
    typeof saved.pending !== 'boolean' ||
    !validUsage(saved.usage) ||
    !validSavedResponse(saved) ||
    !validPending(saved.pendingRun)
  ) {
    throw new Error('Antigravity session has invalid state; refusing native replay');
  }
  return saved as Saved;
}

function validUsage(usage: AntigravityUsage | undefined) {
  return (
    usage === undefined ||
    (typeof usage === 'object' &&
      usage !== null &&
      !Array.isArray(usage) &&
      Object.values(usage).every(
        (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
      ))
  );
}

function validSavedResponse(saved: Partial<Saved>) {
  if (saved.response === undefined && saved.replay === undefined) {
    return true;
  }
  return validMessagesResponse(saved.response) && validReplay(saved.replay);
}

function validPersistedResponse(
  value: unknown,
): value is { response: MessagesResponse; events: Event[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return validMessagesResponse(record.response) && validEvents(record.events);
}

function validMessagesResponse(value: unknown): value is MessagesResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const response = value as Partial<MessagesResponse>;
  return (
    typeof response.id === 'string' &&
    response.type === 'message' &&
    response.role === 'assistant' &&
    typeof response.model === 'string' &&
    Array.isArray(response.content) &&
    response.content.every(
      (block) =>
        block &&
        typeof block === 'object' &&
        !Array.isArray(block) &&
        block.type === 'text' &&
        typeof block.text === 'string',
    ) &&
    (response.stop_reason === null || response.stop_reason === 'end_turn') &&
    (response.stop_sequence === null || typeof response.stop_sequence === 'string') &&
    validResponseUsage(response.usage)
  );
}

function validResponseUsage(value: unknown): value is MessagesResponse['usage'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const usage = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(usage.input_tokens) &&
    Number(usage.input_tokens) >= 0 &&
    Number.isSafeInteger(usage.output_tokens) &&
    Number(usage.output_tokens) >= 0 &&
    (usage.cache_read_input_tokens === undefined ||
      (Number.isSafeInteger(usage.cache_read_input_tokens) &&
        Number(usage.cache_read_input_tokens) >= 0)) &&
    (usage.cache_creation_input_tokens === undefined ||
      (Number.isSafeInteger(usage.cache_creation_input_tokens) &&
        Number(usage.cache_creation_input_tokens) >= 0))
  );
}

function validReplay(value: unknown): value is { key: string; events: Event[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const replay = value as { key?: unknown; events?: unknown };
  return isHash(replay.key) && validEvents(replay.events);
}

function validEvents(value: unknown): value is Event[] {
  return Array.isArray(value) && value.every(validEvent);
}

function validEvent(value: unknown): value is Event {
  if (!Array.isArray(value) || value.length !== 2) {
    return false;
  }
  const [name, body] = value;
  return (
    typeof name === 'string' &&
    [
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
      'ping',
      'error',
    ].includes(name) &&
    body !== null &&
    typeof body === 'object' &&
    !Array.isArray(body)
  );
}

function validPending(pending: Pending | undefined) {
  return (
    pending === undefined ||
    (isHash(pending.key) &&
      isHash(pending.historyHash) &&
      Number.isSafeInteger(pending.historyLength) &&
      pending.historyLength > 0 &&
      typeof pending.model === 'string' &&
      Number.isSafeInteger(pending.inputTokens) &&
      pending.inputTokens >= 0)
  );
}
function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
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
const missingPermissions: CheckAntigravityPermissions = async () => {
  throw new Error('Antigravity native permission policy is not configured');
};

export class AntigravityProviderError extends Error {
  readonly failure: { status: number; message: string };
  constructor(error: unknown) {
    const detail = error && typeof error === 'object' && 'message' in error ? error.message : error;
    const message = String(detail ?? 'unknown Antigravity failure')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500);
    super(message, { cause: error });
    this.name = 'AntigravityProviderError';
    this.failure = { status: 502, message };
  }
}
