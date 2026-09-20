import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFile } from '../../multi-core/src/gateway/atomic-write.ts';
import type {
  Emit,
  MessagesRequest,
  MessagesResponse,
  StreamEventBody,
  StreamEventName,
} from '../../multi-core/src/gateway/messages.ts';
import type { PermissionContext } from '../../multi-core/src/gateway/mode-hook.ts';
import { abortGraceMs, settleOrAbort } from '../../multi-core/src/gateway/settle.ts';
import { lockStateFile } from '../../multi-core/src/gateway/state-lock.ts';
import type { GrokRunOptions, GrokRunResult, GrokStreamEvent, GrokUsage } from './cli.ts';
import { GrokCliError, runGrok } from './cli.ts';
import { grokFailureAdvice } from './errors.ts';
import type { GrokModel } from './models.ts';
import { selectGrokModel } from './models.ts';
import { type GrokPolicy, grokCompactionPolicy } from './permissions.ts';
import { grokHistoryHash, prepareGrokRequest } from './request.ts';

export type GrokRunner = (options: GrokRunOptions) => Promise<GrokRunResult>;

export type CheckGrokPermissions = (cwd: string, context: PermissionContext) => Promise<GrokPolicy>;

type Event = [StreamEventName, StreamEventBody];
type Saved = {
  version: 1;
  provider: 'grok';
  identity: string;
  response?: MessagesResponse;
  replay?: { key: string; events: Event[] };
  interrupted: boolean;
  /** Native session identity, chosen here so a durable run ID precedes any output. */
  sessionId?: string;
  /** Running total in USD, reported per invocation by the CLI. */
  cost?: number;
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
};

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class GrokHarness {
  private readonly models: readonly GrokModel[];
  private readonly defaultCwd: string;
  private readonly stateDirectory: string;
  private readonly run: GrokRunner;
  private readonly checkPermissions: CheckGrokPermissions;
  private readonly platform: NodeJS.Platform;
  private readonly sessions = new Map<string, Session>();
  private readonly exchanges = new Map<string, Exchange>();
  private readonly creating = new Set<string>();
  private readonly loading = new Set<string>();
  private readonly queues = new Map<string, Promise<void>>();
  private closed = false;

  constructor(
    models: readonly GrokModel[],
    {
      cwd = process.cwd(),
      stateDirectory = path.join(os.homedir(), '.grok', 'multi-harness'),
      run = runGrok,
      checkPermissions,
      platform = process.platform,
    }: {
      cwd?: string;
      stateDirectory?: string;
      run?: GrokRunner;
      checkPermissions?: CheckGrokPermissions;
      platform?: NodeJS.Platform;
    } = {},
  ) {
    this.models = models;
    this.defaultCwd = cwd;
    this.stateDirectory = stateDirectory;
    this.platform = platform;
    this.run = run;
    this.checkPermissions = checkPermissions ?? missingPermissions;
  }

  private selection(body: MessagesRequest) {
    return selectGrokModel(this.models, body.model, body.output_config?.effort);
  }

  validate(body: MessagesRequest) {
    const selection = this.selection(body);
    return prepareGrokRequest(body, selection.model.id).inputTokens;
  }

  async handle(
    body: MessagesRequest,
    scope: string,
    signal: AbortSignal,
    emit?: Emit,
    context?: PermissionContext,
  ): Promise<MessagesResponse> {
    if (this.closed) {
      throw new Error('Grok harness is closed');
    }
    signal.throwIfAborted();
    if (!context) {
      throw new Error('Grok requires an explicit Claude permission context');
    }
    const selection = this.selection(body);
    this.validate(body);
    const cwd = await realpath(context.cwd ?? this.defaultCwd);
    const identity = `${cwd}\0${scope}`;
    const key = digest([
      'grok',
      identity,
      {
        ...body,
        stream: undefined,
        messages: grokHistoryHash(body.messages),
        system: undefined,
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
        throw new Error('Too many concurrent Grok requests');
      }
      exchange = this.startExchange(body, context, selection, cwd, identity, key);
      this.exchanges.set(key, exchange);
    }
    return observe(exchange, signal, emit);
  }

  private startExchange(
    body: MessagesRequest,
    context: PermissionContext,
    selection: ReturnType<typeof selectGrokModel>,
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
      result: Promise.resolve().then(() =>
        this.cachedExecute(body, context, selection, cwd, identity, key, exchange, forward),
      ),
    };
    const settle = () => {
      exchange.settled = true;
      if (this.exchanges.get(key) === exchange) {
        this.exchanges.delete(key);
      }
    };
    void exchange.result.then(settle, settle);
    return exchange;
  }

  /**
   * One turn at a time per agent, in arrival order. A second prompt waits instead
   * of being refused: the answer streams to the user before the turn is released,
   * so typing straight after reading it used to cost them the message. Grok only —
   * Cursor and Antigravity still refuse, and widening this is the repository
   * owner's call.
   */
  private async waitForTurn(identity: string, signal: AbortSignal): Promise<() => void> {
    const previous = this.queues.get(identity) ?? Promise.resolve();
    const turn = Promise.withResolvers<void>();
    const queued = previous.then(
      () => turn.promise,
      () => turn.promise,
    );
    this.queues.set(identity, queued);
    const release = () => {
      turn.resolve();
      if (this.queues.get(identity) === queued) {
        this.queues.delete(identity);
      }
    };
    const controller = new AbortController();
    const waiting = new Promise<never>((_, reject) => {
      const cancel = () => reject(signal.reason);
      if (signal.aborted) {
        cancel();
        return;
      }
      signal.addEventListener('abort', cancel, { once: true, signal: controller.signal });
    });
    void waiting.catch(() => {});
    try {
      // A failure ahead in the queue never fails the request behind it.
      await Promise.race([previous.catch(() => {}), waiting]);
    } catch (error) {
      release();
      throw error;
    } finally {
      controller.abort();
    }
    return release;
  }

  private async cachedExecute(
    body: MessagesRequest,
    context: PermissionContext,
    selection: ReturnType<typeof selectGrokModel>,
    cwd: string,
    identity: string,
    key: string,
    exchange: Exchange,
    emit: Emit,
  ) {
    const release = await this.waitForTurn(identity, exchange.controller.signal);
    try {
      return await this.serve(body, context, selection, cwd, identity, key, exchange, emit);
    } finally {
      release();
    }
  }

  private async serve(
    body: MessagesRequest,
    context: PermissionContext,
    selection: ReturnType<typeof selectGrokModel>,
    cwd: string,
    identity: string,
    key: string,
    exchange: Exchange,
    emit: Emit,
  ) {
    let saved = this.sessions.get(identity);
    if (!saved) {
      if (this.loading.has(identity)) {
        throw new GrokProviderError(
          new GrokBusyError('A different request is already loading this Grok agent'),
        );
      }
      this.loading.add(identity);
      try {
        saved = await this.loadSession(identity);
      } finally {
        this.loading.delete(identity);
      }
    }
    const persisted =
      saved?.replay?.key === key
        ? { response: saved.response, events: saved.replay.events }
        : await readJson(path.join(this.stateDirectory, `${key}.response.json`));
    if (persisted === undefined) {
      return this.execute(body, context, selection, cwd, identity, key, exchange, emit);
    }
    if (!validPersistedResponse(persisted)) {
      throw new Error('Invalid persisted Grok response');
    }
    for (const event of persisted.events) {
      emit(...event);
    }
    return {
      ...persisted.response,
      multi_usage: persisted.response.multi_usage
        ? { ...persisted.response.multi_usage, replayed: true }
        : { source: 'unavailable' as const, replayed: true },
    };
  }

  private async execute(
    body: MessagesRequest,
    context: PermissionContext,
    selection: ReturnType<typeof selectGrokModel>,
    cwd: string,
    identity: string,
    key: string,
    exchange: Exchange,
    emit: Emit,
  ): Promise<MessagesResponse> {
    const { session, messages, rewound } = await this.session(body, identity);
    const signal = exchange.controller.signal;
    const wasInterrupted = session.interrupted;
    let started = false;
    try {
      const prepared = prepareGrokRequest({ ...body, messages }, selection.model.id);
      // A run policy is always checked, so an unsupported mode fails before the CLI
      // starts; a compaction turn then replaces it with its own toolless policy.
      const checked = await this.checkPermissions(cwd, context);
      const policy = context.compaction === undefined ? checked : grokCompactionPolicy();
      const response = new HarnessResponse(
        body.model ?? selection.model.model,
        prepared.inputTokens,
        emit,
      );
      const policyIdentity = digest(policy);
      writeNotices(response, session, wasInterrupted, rewound, policy.notice, policyIdentity);
      session.policyIdentity = policyIdentity;
      signal.throwIfAborted();
      const sessionId = session.sessionId ?? randomUUID();
      let startSave: Promise<void> | undefined;
      const startedAt = performance.now();
      const outcome = await settleOrAbort(
        this.run({
          cwd,
          prompt: wasInterrupted ? `${INTERRUPTED_NOTICE}\n\n${prepared.prompt}` : prepared.prompt,
          model: selection.model.id,
          ...(selection.effort ? { effort: selection.effort } : {}),
          ...(session.sessionId ? { resume: session.sessionId } : { session: sessionId }),
          mode: policy.mode,
          tools: policy.tools,
          disallowedTools: policy.disallowedTools,
          deny: policy.deny,
          forbiddenTools: policy.forbidden,
          signal,
          onEvent: (event) => {
            if (!started) {
              started = true;
              // The native session now exists. Record it before the turn completes so
              // a crash resumes this conversation instead of starting a fresh one.
              session.sessionId = sessionId;
              session.interrupted = true;
              startSave = this.saveSession(session).catch(() => {
                // The run continues regardless of a failed durability write.
              });
            }
            eventText(event, response);
          },
        }),
        signal,
        'Grok native run',
      );
      await startSave;
      return await this.settle(
        { session, response, outcome, selection, key, exchange, emit },
        performance.now() - startedAt,
      );
    } catch (error) {
      // Traced before the rethrow: a failure that never reached the CLI left no
      // other evidence at all, which cost one diagnosis already.
      if (error instanceof GrokProviderError) {
        throw error;
      }
      // The run ended without a terminal result. If the CLI ever produced output the
      // native turn's completion is unknown, so the next request resumes and says so.
      if (started) {
        session.interrupted = true;
        await this.saveSession(session).catch(() => {
          // The run failure below is the more useful error to surface.
        });
      }
      throw new GrokProviderError(error);
    } finally {
      session.busy = false;
      if (this.closed) {
        await this.releaseLock(session);
      }
    }
  }

  private async settle(
    run: {
      session: Session;
      response: HarnessResponse;
      outcome: GrokRunResult;
      selection: ReturnType<typeof selectGrokModel>;
      key: string;
      exchange: Exchange;
      emit: Emit;
    },
    elapsedMs: number,
  ): Promise<MessagesResponse> {
    const { session, response, outcome, selection, key, exchange, emit } = run;
    const result = outcome.result;
    // The CLI owns the identity it reports; a mismatch would silently fork history.
    if (session.sessionId !== undefined && result.sessionId !== session.sessionId) {
      throw new GrokProviderError(
        `Grok answered on session ${result.sessionId} instead of ${session.sessionId}`,
      );
    }
    session.sessionId = result.sessionId;
    session.interrupted = false;
    session.cost = (session.cost ?? 0) + (result.costUsd ?? 0);
    appendDiagnostics(response, outcome, elapsedMs);
    const finished = response.finish(result.usage, selection.model.id, selection.effort);
    const terminalEvents = response.takeTerminalEvents();
    session.response = finished;
    session.replay = {
      key,
      events: [
        ...exchange.events,
        ...terminalEvents.map(([name, value]) => [name, structuredClone(value)] as Event),
      ],
    };
    await this.saveSession(session);
    await atomicJson(
      path.join(this.stateDirectory, `${key}.response.json`),
      { response: finished, events: session.replay.events },
      this.platform,
    );
    for (const event of terminalEvents) {
      emit(...event);
    }
    return finished;
  }

  private async session(body: MessagesRequest, identity: string) {
    const current = this.sessions.get(identity);
    if (current?.busy || this.creating.has(identity)) {
      throw new GrokProviderError(
        new GrokBusyError('A different request is already running for this Grok agent'),
      );
    }
    this.creating.add(identity);
    try {
      const session = current ?? (await this.loadSession(identity));
      const messages = session.sessionId ? continuation(body) : (body.messages ?? []);
      const rewound = historyRewound(session, body.messages ?? []);
      session.busy = true;
      return { session, messages, rewound };
    } finally {
      this.creating.delete(identity);
    }
  }

  private sessionFile(identity: string) {
    return path.join(this.stateDirectory, `${digest(identity)}.session.json`);
  }

  private async loadSession(identity: string): Promise<Session> {
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    const file = this.sessionFile(identity);
    const release = await lockStateFile(`${file}.lock`);
    try {
      const saved = await readSession(file);
      const session: Session = {
        ...(saved ?? { version: 1, provider: 'grok', identity, interrupted: false }),
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
    return atomicJson(session.file, { ...saved, provider: 'grok' }, this.platform);
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
        exchange.controller.abort(new Error('Grok gateway closed'));
        running.push(exchange.result);
      }
    }
    await bounded(Promise.allSettled(running));
    for (const session of this.sessions.values()) {
      await this.releaseLock(session);
    }
    this.sessions.clear();
  }
}

/**
 * Native activity is displayed, never replayed: a tool call becomes one line of text
 * in the assistant answer and never a Claude tool block.
 */
function eventText(event: GrokStreamEvent, response: HarnessResponse) {
  if (event.event === 'text') {
    response.text(event.text);
    return;
  }
  if (event.event === 'tool_call') {
    response.text(`\n[Grok] ${event.call.toolName ?? event.call.title ?? 'tool'}\n`);
    return;
  }
  if (event.event === 'tool_update' && event.call.status === 'failed') {
    // A policy denial and an ordinary tool error both arrive as `failed`; only
    // the text tells them apart, and calling an error a refusal would misreport
    // what the policy did.
    const detail = safeText(contentText(event.call.content));
    const refused = /denied by permission policy/i.test(detail);
    response.text(`[Grok] ${refused ? 'refused' : 'failed'}: ${detail}\n`);
  }
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((entry) => {
      const inner = isRecord(entry) && isRecord(entry.content) ? entry.content.text : undefined;
      return typeof inner === 'string' ? inner : '';
    })
    .filter(Boolean)
    .join(' ');
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
      throw new Error('Grok run exceeded the 32 MiB output limit');
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
  finish(usage?: GrokUsage, model?: string, effort?: string) {
    if (this.started) {
      this.emit('content_block_stop', { index: 0 });
    }
    this.response.stop_reason = 'end_turn';
    const estimatedOutput = Math.ceil(JSON.stringify(this.response.content).length / 4);
    this.response.usage.input_tokens = usage?.input_tokens ?? this.response.usage.input_tokens;
    this.response.usage.output_tokens = usage?.output_tokens ?? estimatedOutput;
    if (usage?.cache_read_input_tokens !== undefined) {
      this.response.usage.cache_read_input_tokens = usage.cache_read_input_tokens;
    }
    if (usage?.cache_creation_input_tokens !== undefined) {
      this.response.usage.cache_creation_input_tokens = usage.cache_creation_input_tokens;
    }
    this.response.multi_usage = {
      source: usageSource(usage),
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      ...(usage?.reasoning_tokens === undefined
        ? {}
        : { reasoning_tokens: usage.reasoning_tokens }),
      ...(usage?.total_tokens === undefined ? {} : { total_tokens: usage.total_tokens }),
    };
    this.terminalEvents.push([
      'message_delta',
      { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: this.response.usage },
    ]);
    this.terminalEvents.push(['message_stop', {}]);
    return this.response;
  }
  takeTerminalEvents() {
    return this.terminalEvents.splice(0);
  }
}

function usageSource(
  usage: GrokUsage | undefined,
): NonNullable<MessagesResponse['multi_usage']>['source'] {
  if (usage === undefined) {
    return 'estimate';
  }
  return usage.input_tokens !== undefined && usage.output_tokens !== undefined
    ? 'provider'
    : 'mixed';
}

/** The CLI reports cost per invocation, so it is shown as billed for this run. */
function appendDiagnostics(response: HarnessResponse, outcome: GrokRunResult, elapsedMs: number) {
  const parts = [];
  if (Number.isFinite(elapsedMs)) {
    parts.push(`completed in ${(Math.max(0, elapsedMs) / 1000).toFixed(1)}s`);
  }
  if (outcome.result.costUsd !== undefined) {
    parts.push(`$${outcome.result.costUsd.toFixed(4)} billed`);
  }
  if (parts.length) {
    response.text(`\n[Grok] ${parts.join(' · ')}\n`);
  }
  const diagnostics = outcome.stderr
    .split(/\r?\n/)
    .filter((line) => /warn|error|denied|permission|fail/i.test(line))
    .join('\n');
  if (diagnostics.trim()) {
    response.text(`[Grok] ${safeText(diagnostics)}\n`);
  }
}

const INTERRUPTED_NOTICE =
  '[Grok] The previous turn was interrupted. Report its state and do not repeat completed actions.';

function writeNotices(
  response: HarnessResponse,
  session: Session,
  interrupted: boolean,
  rewound: boolean,
  notice: string,
  policyIdentity: string,
) {
  if (!session.response || session.policyIdentity !== policyIdentity) {
    response.text(`[Grok] ${notice}\n`);
  }
  if (interrupted) {
    response.text(`${INTERRUPTED_NOTICE}\n`);
  }
  if (rewound) {
    response.text(
      '[Grok] Outer history changed; the native conversation continues with its own record.\n',
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

/**
 * The newest turn: everything after the last assistant message. The native session
 * already holds everything before it, so only the delta is sent on resume.
 */
function continuation(body: MessagesRequest): NonNullable<MessagesRequest['messages']> {
  const messages = body.messages ?? [];
  const lastAssistant = messages.findLastIndex((message) => message.role === 'assistant');
  if (lastAssistant === messages.length - 1) {
    throw new Error('Grok continuation requires a message after the last assistant turn');
  }
  const delta = messages.slice(lastAssistant + 1);
  if (!delta.some((message) => message.role === 'user')) {
    throw new Error('Grok continuation requires a new user message');
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
  const expected = grokHistoryHash([{ role: 'assistant', content: session.response.content }]);
  return !messages.some(
    (message) => message.role === 'assistant' && grokHistoryHash([message]) === expected,
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
      exchange.controller.abort(new Error('All Grok observers disconnected'));
    }
  }
}

async function readSession(file: string): Promise<Saved | undefined> {
  const saved = (await readJson(file)) as Partial<Saved> | undefined;
  if (saved === undefined) {
    return undefined;
  }
  if (saved.version !== 1) {
    // The native session is never deleted; an unknown record is ignored and a fresh
    // session starts rather than refusing to load.
    return undefined;
  }
  if (
    saved.provider !== 'grok' ||
    typeof saved.identity !== 'string' ||
    (saved.policyIdentity !== undefined && !isHash(saved.policyIdentity)) ||
    (saved.sessionId !== undefined && !isUuid(saved.sessionId)) ||
    (saved.cost !== undefined && !(typeof saved.cost === 'number' && saved.cost >= 0)) ||
    typeof saved.interrupted !== 'boolean' ||
    !validSavedResponse(saved)
  ) {
    throw new Error('Grok session has invalid state; refusing native replay');
  }
  return saved as Saved;
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
  if (!isRecord(value)) {
    return false;
  }
  return validMessagesResponse(value.response) && validEvents(value.events);
}

function validMessagesResponse(value: unknown): value is MessagesResponse {
  if (!isRecord(value)) {
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
        isRecord(block) &&
        block.type === 'text' &&
        typeof (block as { text: unknown }).text === 'string',
    ) &&
    (response.stop_reason === null || response.stop_reason === 'end_turn') &&
    (response.stop_sequence === null || typeof response.stop_sequence === 'string') &&
    validResponseUsage(response.usage)
  );
}

function validResponseUsage(value: unknown): value is MessagesResponse['usage'] {
  if (!isRecord(value)) {
    return false;
  }
  return (
    Number.isSafeInteger(value.input_tokens) &&
    Number(value.input_tokens) >= 0 &&
    Number.isSafeInteger(value.output_tokens) &&
    Number(value.output_tokens) >= 0 &&
    optionalCount(value.cache_read_input_tokens) &&
    optionalCount(value.cache_creation_input_tokens)
  );
}

function optionalCount(value: unknown) {
  return value === undefined || (Number.isSafeInteger(value) && Number(value) >= 0);
}

function validReplay(value: unknown): value is { key: string; events: Event[] } {
  if (!isRecord(value)) {
    return false;
  }
  return isHash(value.key) && validEvents(value.events);
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
    isRecord(body)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value);
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
        timer = setTimeout(resolve, abortGraceMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Another run owns this agent. Retrying cannot help while it lasts, and a
 * retryable status turned one conflict into ten attempts in a live session.
 */
class GrokBusyError extends Error {}

const missingPermissions: CheckGrokPermissions = async () => {
  throw new Error('Grok native permission policy is not configured');
};

export class GrokProviderError extends Error {
  readonly failure: { status: number; message: string };
  constructor(error: unknown) {
    // A policy the CLI did not apply, or a CLI that will not start, fails the same
    // way on every attempt. Reporting them as 502 had Claude retry a paid run ten
    // times over one prompt, so they are answered as a request error instead.
    const deterministic =
      error instanceof GrokBusyError ||
      (error instanceof GrokCliError && (error.code === 'policy' || error.code === 'spawn'));
    const detail = error && typeof error === 'object' && 'message' in error ? error.message : error;
    const reported = String(detail ?? 'unknown Grok failure');
    const advice = grokFailureAdvice(reported);
    const message = `${reported}${advice ? ` ${advice}` : ''}`
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500);
    super(message, { cause: error });
    this.name = 'GrokProviderError';
    this.failure = { status: deterministic ? 400 : 502, message };
  }
}
