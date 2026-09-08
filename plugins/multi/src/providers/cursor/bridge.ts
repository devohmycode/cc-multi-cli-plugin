import { createHash, randomUUID } from 'node:crypto';
import type {
  AgentOptions,
  Run,
  SDKAgent,
  SDKCustomTool,
  SDKCustomToolResult,
  SDKJsonValue,
  SDKUserMessage,
} from '@cursor/sdk';
import type {
  ContentBlock,
  Emit,
  MessagesRequest,
  MessagesResponse,
  ResponseContentBlock,
  StreamEventBody,
  StreamEventName,
} from '../../gateway/messages.ts';
import { originalToolNames } from '../../gateway/tools.ts';
import { toResponses } from '../openai/responses.ts';
import { estimateTextTokens } from '../openai/tokens.ts';
import { CursorProviderError, cursorRunError } from './errors.ts';
import type { CursorModelOption } from './models.ts';
import { cursorSelection } from './models.ts';

type CursorAgent = Pick<SDKAgent, 'send' | 'close'>;
export type CreateCursorAgent = (options: AgentOptions) => Promise<CursorAgent>;
type Event = [StreamEventName, StreamEventBody];
type Pending = {
  block: Extract<ResponseContentBlock, { type: 'tool_use' }>;
  promise: Promise<SDKCustomToolResult>;
  resolve: (value: SDKCustomToolResult) => void;
  reject: (error: Error) => void;
  delivered: boolean;
  result?: string;
  history?: string;
  historyLength?: number;
};
type Update = { text: string } | { call: Pending } | { done: true } | { error: Error };
type Turn = {
  id: string;
  scope: string;
  contract: string;
  agent?: CursorAgent;
  run?: Run;
  cancelled?: Error;
  pending: Map<string, Pending>;
  queue: Update[];
  wake?: () => void;
  busy: boolean;
  timer?: NodeJS.Timeout;
  outputBytes: number;
  streamedText: string;
  streamedSegment: string;
  startup: Promise<void>;
  startupDone: () => void;
  agentClosed?: boolean;
  runCancelRequested?: boolean;
};
type Exchange = {
  events: Event[];
  listeners: Set<Emit>;
  result: Promise<MessagesResponse>;
  controller: AbortController;
  observers: number;
  touched: number;
  settled: boolean;
  mayHaveRun: boolean;
};
const cancelWaitMs = 1000;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const asError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));
function historyHash(messages: MessagesRequest['messages']): string {
  // Claude moves ephemeral cache markers as the transcript grows. They are not
  // conversation edits; only strip block metadata, never fields inside tool args.
  const blocks = (content: unknown): unknown =>
    Array.isArray(content)
      ? content.map((block) => {
          const { cache_control: _cache, ...rest } = block as ContentBlock;
          return rest.type === 'tool_result' ? { ...rest, content: blocks(rest.content) } : rest;
        })
      : content;
  return hash(messages?.map((message) => ({ ...message, content: blocks(message.content) })));
}

function prepare(body: MessagesRequest) {
  if (
    body.output_config != null &&
    (typeof body.output_config !== 'object' || Array.isArray(body.output_config))
  ) {
    throw new Error('Invalid output_config');
  }
  if (body.output_config?.effort !== undefined && typeof body.output_config.effort !== 'string') {
    throw new Error('Invalid effort');
  }
  if (body.tool_choice && !['auto', 'none'].includes(body.tool_choice.type)) {
    throw new Error(
      'Cursor SDK supports automatic tools or tool_choice none; forced tool choice is unavailable',
    );
  }
  if (body.output_config?.format || body.output_format) {
    throw new Error('Cursor SDK does not support a strict Messages output schema');
  }
  if (body.stop_sequences?.length) {
    throw new Error('Cursor SDK does not support Messages stop sequences');
  }
  // AgentOptions has no Messages max-token or sampling controls. Keep Claude's
  // required max_tokens accepted, but do not claim the SDK enforces it or samples.
  // Reuse the existing validated Messages parser and media normalization. This
  // normalized representation is only local data; no OpenAI request is made.
  const normalized = toResponses({ ...body, output_config: { effort: 'medium' } }, 'cursor');
  if (
    normalized.input.some(
      (item) =>
        ('content' in item && item.content.some((c) => c.type === 'input_file')) ||
        ('type' in item &&
          item.type === 'function_call_output' &&
          Array.isArray(item.output) &&
          item.output.some((c) => c.type === 'input_file')),
    )
  ) {
    throw new Error('Cursor SDK bridge does not support PDF attachments; provide extracted text');
  }
  const images: NonNullable<SDKUserMessage['images']> = [];
  const input = JSON.parse(
    JSON.stringify(
      normalized.input.filter((item) => !('type' in item) || item.type !== 'reasoning'),
    ),
    (_key, value) => {
      if (value?.type === 'input_image') {
        if (value.image_url.startsWith('data:')) {
          const [prefix, data] = value.image_url.split(',');
          images.push({ data, mimeType: prefix.slice(5).split(';')[0] });
        } else {
          images.push({ url: value.image_url });
        }
        return { type: 'text', text: `[Attached image ${images.length}]` };
      }
      return value;
    },
  );
  const prompt: SDKUserMessage = {
    text: [
      'You are connected to Claude Code through callback tools. Use only custom-user-tools for actions.',
      'Claude Code owns permissions and executes those tools. Await each result. Do not invoke other coding CLIs.',
      'The following is the current conversation, not a new instruction to repeat prior actions. Continue after its final message.',
      'Tool calls with results in this history have already been handled; never repeat them just to reconstruct state.',
      'Apply the supplied session instructions within your governing instructions.',
      JSON.stringify({ session_instructions: normalized.instructions, conversation: input }),
    ].join('\n'),
    ...(images.length ? { images } : {}),
  };
  const definitions = Object.fromEntries(
    (body.tool_choice?.type === 'none' ? [] : normalized.tools).map((tool) => [
      tool.name,
      { description: tool.description, inputSchema: tool.parameters },
    ]),
  );
  // ponytail: SDK hidden envelope overhead and image expansion are unknown;
  // estimate the actual submitted prompt/schemas until SDK exposes context counting.
  const inputTokens =
    estimateTextTokens(prompt.text ?? '') +
    estimateTextTokens(JSON.stringify(definitions)) +
    images.length * 4096;
  return { normalized, prompt, inputTokens };
}

function toolResult(block: ContentBlock): SDKCustomToolResult {
  if (typeof block.content === 'string' || block.content === undefined) {
    return {
      content: [{ type: 'text', text: block.content ?? '' }],
      isError: Boolean(block.is_error),
    };
  }
  if (!Array.isArray(block.content)) {
    throw new Error('Invalid Cursor tool result');
  }
  return {
    isError: Boolean(block.is_error),
    content: block.content.map((part: ContentBlock) => {
      if (part.type === 'text' && typeof part.text === 'string') {
        return { type: 'text' as const, text: part.text };
      }
      if (
        part.type === 'image' &&
        part.source?.type === 'base64' &&
        typeof part.source.data === 'string'
      ) {
        return { type: 'image' as const, data: part.source.data, mimeType: part.source.media_type };
      }
      if (part.type === 'tool_reference' && part.tool_name) {
        return { type: 'text' as const, text: `Available tool: ${part.tool_name}` };
      }
      if (
        part.type === 'document' &&
        part.source?.type === 'text' &&
        typeof part.source.data === 'string'
      ) {
        return { type: 'text' as const, text: part.source.data };
      }
      throw new Error(
        `Unsupported Cursor callback result content: ${part.type}. Images must be base64.`,
      );
    }),
  };
}

function callbackInput(args: unknown): Record<string, SDKJsonValue> {
  if (!isCallbackObject(args, new Set())) {
    throw new Error('Cursor callback arguments must be a JSON object with finite JSON values');
  }
  const snapshot: unknown = JSON.parse(JSON.stringify(args));
  if (!isCallbackObject(snapshot, new Set())) {
    throw new Error('Cursor callback arguments could not be serialized as a JSON object');
  }
  return snapshot;
}

function isCallbackObject(
  value: unknown,
  ancestors: Set<object>,
): value is Record<string, SDKJsonValue> {
  return (
    Boolean(value) &&
    !Array.isArray(value) &&
    typeof value === 'object' &&
    isJsonValue(value, ancestors)
  );
}

function isJsonValue(value: unknown, ancestors: Set<object>): value is SDKJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (typeof value !== 'object' || ancestors.has(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) {
    return false;
  }
  ancestors.add(value);
  const valid = Object.values(value).every((item) => isJsonValue(item, ancestors));
  ancestors.delete(value);
  return valid;
}

/** Cursor owns inference; callbacks pause before Claude executes any action. */
export class CursorBridge {
  private readonly options: Map<string, CursorModelOption>;
  private readonly turns = new Set<Turn>();
  private readonly calls = new Map<string, Turn>();
  private readonly exchanges = new Map<string, Exchange>();
  private readonly cleanups = new Set<Promise<void>>();
  private closed = false;
  private readonly createAgent: CreateCursorAgent;
  private readonly cwd: string;
  private readonly idleMs: number;

  constructor(
    options: CursorModelOption[],
    {
      cwd = process.cwd(),
      idleMs = 600000,
      createAgent = async (config: AgentOptions) =>
        (await import('@cursor/sdk')).Agent.create(config),
    }: { cwd?: string; idleMs?: number; createAgent?: CreateCursorAgent } = {},
  ) {
    this.options = new Map(options.map((option) => [option.model, option]));
    this.cwd = cwd;
    this.idleMs = idleMs;
    this.createAgent = createAgent;
  }

  private modelOption(body: MessagesRequest) {
    const option = this.options.get(body.model ?? '');
    if (!option) {
      throw new Error('Unknown Cursor model; use a model from the account catalog');
    }
    return option;
  }

  validate(body: MessagesRequest): number {
    const option = this.modelOption(body);
    cursorSelection(option, body.output_config?.effort);
    return prepare(body).inputTokens;
  }

  async handle(
    body: MessagesRequest,
    scope: string,
    signal: AbortSignal,
    emit?: Emit,
  ): Promise<MessagesResponse> {
    if (this.closed) {
      throw new Error('Cursor bridge is closed');
    }
    signal.throwIfAborted();
    this.validate(body);
    const key = hash([scope, { ...body, stream: undefined }]);
    this.pruneExchanges();
    let exchange = this.exchanges.get(key);
    if (!exchange) {
      if (this.exchanges.size >= 256) {
        const oldest = [...this.exchanges].find(([, entry]) => entry.settled);
        if (!oldest) {
          throw new Error('Too many simultaneous Cursor requests');
        }
        this.exchanges.delete(oldest[0]);
      }
      const events: Event[] = [];
      const listeners = new Set<Emit>();
      const broadcast: Emit = (name, value) => {
        events.push([name, structuredClone(value)]);
        for (const listener of listeners) {
          listener(name, value);
        }
      };
      // Defer execution so the entry exists before callbacks or a duplicate request arrive.
      let entry: Exchange;
      const controller = new AbortController();
      entry = {
        events,
        listeners,
        controller,
        observers: 0,
        touched: Date.now(),
        settled: false,
        mayHaveRun: false,
        result: Promise.resolve().then(() =>
          this.exchange(body, scope, controller.signal, broadcast, () => {
            entry.mayHaveRun = true;
          }),
        ),
      };
      exchange = entry;
      void entry.result.then(
        () => {
          entry.settled = true;
        },
        () => {
          entry.settled = true;
          // Before send(), Cursor cannot infer or request a callback, so retrying
          // is safe. Afterwards retain deduplication: an SDK error can follow work.
          if (!entry.mayHaveRun && this.exchanges.get(key) === entry) {
            this.exchanges.delete(key);
          }
        },
      );
      this.exchanges.set(key, exchange);
    }
    exchange.touched = Date.now();
    exchange.observers++;
    let observing = true;
    const release = () => {
      if (!observing) {
        return;
      }
      observing = false;
      exchange.observers--;
      if (!exchange.settled && exchange.observers === 0) {
        exchange.controller.abort(new Error('All Cursor request observers disconnected'));
      }
    };
    const abort = Promise.withResolvers<never>();
    void abort.promise.catch(() => {});
    const onAbort = () => {
      release();
      abort.reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      if (emit) {
        exchange.listeners.add(emit);
        for (const event of exchange.events) {
          emit(...event);
        }
      }
      signal.throwIfAborted();
      return await Promise.race([exchange.result, abort.promise]);
    } finally {
      release();
      if (emit) {
        exchange.listeners.delete(emit);
      }
      signal.removeEventListener('abort', onAbort);
    }
  }

  private pruneExchanges() {
    // Bounded in-memory retry history. Pending callbacks have their own lifetime.
    for (const [id, entry] of this.exchanges) {
      if (entry.settled && Date.now() - entry.touched > this.idleMs) {
        this.exchanges.delete(id);
      }
    }
  }

  private push(turn: Turn, update: Update) {
    if (turn.cancelled) {
      return;
    }
    turn.outputBytes += Buffer.byteLength(JSON.stringify(update));
    if (turn.outputBytes > 32 * 1024 * 1024) {
      this.cancel(turn, new Error('Cursor run exceeded the 32 MiB output limit'));
      return;
    }
    turn.queue.push(update);
    turn.wake?.();
  }

  private cancel(turn: Turn, error: Error) {
    if (turn.cancelled) {
      return;
    }
    turn.cancelled = error;
    clearTimeout(turn.timer);
    for (const pending of turn.pending.values()) {
      pending.reject(error);
    }
    turn.queue.push({ error });
    turn.wake?.();
    this.cleanup(turn);
    this.forgetTurn(turn);
  }

  private cleanup(turn: Turn) {
    const cleanup = this.finishCancellation(turn);
    this.cleanups.add(cleanup);
    void cleanup.finally(() => this.cleanups.delete(cleanup));
  }

  private async finishCancellation(turn: Turn) {
    if (!turn.run) {
      await this.waitFor(turn.startup);
    }
    await this.cancelRun(turn);
    this.closeAgent(turn);
  }

  private async cancelRun(turn: Turn) {
    if (!turn.run || turn.runCancelRequested) {
      return;
    }
    turn.runCancelRequested = true;
    const stopping = Promise.resolve().then(() => turn.run?.cancel());
    void stopping.catch(() => {});
    await this.waitFor(stopping);
  }

  private closeAgent(turn: Turn) {
    if (!turn.agent || turn.agentClosed) {
      return;
    }
    turn.agentClosed = true;
    try {
      turn.agent?.close();
    } catch {
      // A failed SDK cleanup must not block bridge shutdown.
    }
  }

  private async waitFor(operation: Promise<unknown>) {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, cancelWaitMs);
    });
    try {
      await Promise.race([operation, deadline]);
    } catch {
      // Cancel errors still require closing the SDK agent.
    } finally {
      clearTimeout(timer);
    }
  }

  private forgetTurn(turn: Turn) {
    for (const id of turn.pending.keys()) {
      this.calls.delete(id);
    }
    this.turns.delete(turn);
  }

  private resultOwner(results: ContentBlock[], scope: string, contract: string): Turn | undefined {
    const owners = new Set(
      results.map((b) => this.calls.get(b.tool_use_id ?? '')).filter((t) => t !== undefined),
    );
    if (owners.size > 1) {
      throw new Error('Tool results belong to different Cursor runs');
    }
    const turn: Turn | undefined = [...owners][0];
    if (turn && (turn.scope !== scope || turn.contract !== contract)) {
      throw new Error('Cursor tool result session, worker, model, or tool configuration mismatch');
    }
    if (turn?.busy) {
      throw new Error('A different request is already continuing this Cursor run');
    }
    return turn;
  }

  private async exchange(
    body: MessagesRequest,
    scope: string,
    signal: AbortSignal,
    emit: Emit,
    inferenceStarted: () => void,
  ): Promise<MessagesResponse> {
    const { normalized, prompt, inputTokens } = prepare(body);
    const selection = cursorSelection(this.modelOption(body), body.output_config?.effort);
    const contract = hash([selection, normalized.instructions, normalized.tools, body.tool_choice]);
    const messages = body.messages;
    if (!messages?.length || !body.model) {
      throw new Error('Cursor requires a model and conversation');
    }
    const last = messages.at(-1);
    const results =
      last?.role === 'user' && Array.isArray(last.content)
        ? last.content.filter((b) => b.type === 'tool_result')
        : [];
    let turn = this.resultOwner(results, scope, contract);
    if (turn) {
      // A continuation belongs to a run that has already reached Cursor. Retain
      // its failed exchange so an HTTP retry cannot replay callback results.
      inferenceStarted();
    }
    const converted = results.map((block) => ({
      id: block.tool_use_id ?? '',
      value: toolResult(block),
    }));
    if (turn) {
      validateResults(turn, converted, messages);
      if (
        last &&
        Array.isArray(last.content) &&
        last.content.some((b) => b.type !== 'tool_result')
      ) {
        // Additional user instructions cannot be smuggled into a waiting callback.
        // Rebuild from the authoritative Claude history instead.
        this.cancel(turn, new Error('Cursor run replaced by updated conversation'));
        turn = undefined;
      }
    }
    if (!turn) {
      if (this.turns.size >= 32) {
        throw new Error('Too many active Cursor runs; finish or cancel a worker first');
      }
      const startup = Promise.withResolvers<void>();
      turn = {
        id: randomUUID(),
        scope,
        contract,
        pending: new Map(),
        queue: [],
        busy: false,
        outputBytes: 0,
        streamedText: '',
        streamedSegment: '',
        startup: startup.promise,
        startupDone: startup.resolve,
      };
      this.turns.add(turn);
      void this.start(turn, body, selection, normalized.tools, prompt, inferenceStarted);
    } else {
      resolveResults(turn, converted);
    }
    return this.respond(turn, body, messages, inputTokens, signal, emit);
  }

  private async respond(
    turn: Turn,
    body: MessagesRequest,
    messages: NonNullable<MessagesRequest['messages']>,
    inputTokens: number,
    signal: AbortSignal,
    emit: Emit,
  ): Promise<MessagesResponse> {
    turn.busy = true;
    clearTimeout(turn.timer);
    const active = turn;
    const onAbort = () => this.cancel(active, new Error('Claude request cancelled or timed out'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
    const response: MessagesResponse = {
      id: `msg_${randomUUID()}`,
      type: 'message',
      role: 'assistant',
      model: body.model ?? '',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    };
    emit('message_start', { message: { ...response, content: [] } });
    const stream = new CursorResponse(response, emit, messages);
    try {
      await this.consume(active, body, response, stream);
      // SDK usage is cumulative spend across internal turns, not this reply's
      // context occupancy. Keep both counts local to the authoritative request.
      response.usage.output_tokens = estimateTextTokens(JSON.stringify(response.content));
      emit('message_delta', {
        delta: { stop_reason: response.stop_reason, stop_sequence: null },
        usage: response.usage,
      });
      emit('message_stop', {});
      return response;
    } catch (error) {
      this.cancel(active, asError(error));
      throw error;
    } finally {
      active.busy = false;
      signal.removeEventListener('abort', onAbort);
      if (this.turns.has(active)) {
        active.timer = setTimeout(
          () => this.cancel(active, new Error('Cursor tool-result wait expired')),
          this.idleMs,
        ).unref();
      }
    }
  }

  private async consume(
    active: Turn,
    body: MessagesRequest,
    response: MessagesResponse,
    stream: CursorResponse,
  ) {
    while (true) {
      const update = await nextUpdate(active);
      if (!update) {
        continue;
      }
      if ('error' in update) {
        throw update.error;
      }
      if ('text' in update) {
        stream.text(update.text);
        continue;
      }
      if ('call' in update) {
        stream.endText();
        const batch = callbackBatch(
          active,
          update.call,
          body.tool_choice?.disable_parallel_tool_use,
        );
        for (const call of batch) {
          stream.tool(call);
        }
        response.stop_reason = 'tool_use';
        break;
      } else {
        stream.endText();
        response.stop_reason = 'end_turn';
        this.forgetTurn(active);
        active.agent?.close();
        break;
      }
    }
  }

  private callback(turn: Turn, name: string, args: unknown, toolCallId?: string) {
    if (turn.cancelled) {
      return Promise.reject(turn.cancelled);
    }
    let input: Record<string, SDKJsonValue>;
    try {
      input = callbackInput(args);
    } catch (error) {
      return Promise.reject(asError(error));
    }
    const id = toolCallId
      ? `cursor_${hash([toolCallId, turn.id]).slice(0, 48)}`
      : `cursor_${randomUUID()}`;
    const previous = turn.pending.get(id);
    const block = {
      type: 'tool_use' as const,
      id,
      name: name,
      input,
    };
    if (previous) {
      if (hash(previous.block) !== hash(block)) {
        return Promise.reject(new Error('Cursor reused a tool call ID with different arguments'));
      }
      return previous.promise;
    }
    const deferred = Promise.withResolvers<SDKCustomToolResult>();
    // Cancellation may precede the SDK installing its rejection handler.
    void deferred.promise.catch(() => {});
    const pending: Pending = { block, ...deferred, delivered: false };
    turn.pending.set(id, pending);
    this.calls.set(id, turn);
    this.push(turn, { call: pending });
    return pending.promise;
  }

  private async start(
    turn: Turn,
    body: MessagesRequest,
    model: AgentOptions['model'],
    tools: ReturnType<typeof toResponses>['tools'],
    prompt: SDKUserMessage,
    inferenceStarted: () => void,
  ) {
    try {
      const names = originalToolNames(body);
      const callbacks: Record<string, SDKCustomTool> = Object.create(null);
      if (body.tool_choice?.type !== 'none') {
        for (const tool of tools) {
          const name = names.get(tool.name);
          if (!name) {
            throw new Error('Missing original Cursor tool name');
          }
          callbacks[tool.name] = {
            description: tool.description,
            inputSchema: tool.parameters as Record<string, SDKJsonValue>,
            execute: (args, context) => this.callback(turn, name, args, context.toolCallId),
          };
        }
      }
      turn.agent = await this.createAgent({
        model,
        tools: Object.keys(callbacks).length ? ['mcp'] : [],
        mcpServers: {},
        agents: {},
        local: {
          cwd: this.cwd,
          settingSources: [],
          // SDK custom callbacks skip its approval gate. Setting autoReview here
          // cannot establish review capability; Claude still owns permissions.
          customTools: callbacks,
          enableAgentRetries: false,
        },
      });
      if (turn.cancelled) {
        turn.startupDone();
        this.closeAgent(turn);
        return;
      }
      inferenceStarted();
      turn.run = await turn.agent.send(prompt, {
        onDelta: ({ update }) => {
          if (update.type === 'text-delta') {
            turn.streamedText += update.text;
            turn.streamedSegment += update.text;
            this.push(turn, { text: update.text });
          }
        },
      });
      turn.startupDone();
      if (turn.cancelled) {
        await this.cancelRun(turn);
        this.closeAgent(turn);
        return;
      }
      const result = await turn.run.wait();
      if (result.status !== 'finished') {
        throw cursorRunError(result);
      }
      if ([...turn.pending.values()].some((call) => !call.result)) {
        throw new Error('Cursor finished before its pending tool results were returned');
      }
      this.pushTerminal(turn, result.result);
      this.push(turn, { done: true });
    } catch (error) {
      turn.startupDone();
      this.push(turn, {
        error: error instanceof CursorProviderError ? error : new CursorProviderError(error),
      });
    }
  }

  private pushTerminal(turn: Turn, result: string | undefined) {
    if (!result) {
      return;
    }
    const terminal = terminalSuffix(turn.streamedText, turn.streamedSegment, result);
    if (terminal) {
      this.push(turn, { text: terminal });
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const turn of this.turns) {
      this.cancel(turn, new Error('Cursor gateway closed'));
    }
    await Promise.allSettled(this.cleanups);
    this.exchanges.clear();
  }
}

function validateResults(
  turn: Turn,
  converted: { id: string; value: SDKCustomToolResult }[],
  messages: NonNullable<MessagesRequest['messages']>,
) {
  for (const { id, value } of converted) {
    const call = turn.pending.get(id);
    if (!call?.delivered) {
      throw new Error('Unknown or undelivered Cursor tool result');
    }
    if (call.result && call.result !== hash(value)) {
      throw new Error('Conflicting duplicate Cursor tool result');
    }
    if (call.history !== historyHash(messages.slice(0, call.historyLength))) {
      throw new Error('Cursor tool result belongs to a different conversation branch');
    }
    const assistant = messages[call.historyLength ?? -1];
    const advertised =
      assistant?.role === 'assistant' && Array.isArray(assistant.content)
        ? assistant.content.find((b) => b.type === 'tool_use' && b.id === id)
        : undefined;
    if (
      !advertised ||
      advertised.name !== call.block.name ||
      hash(advertised.input) !== hash(call.block.input)
    ) {
      throw new Error('Cursor tool result does not match the advertised tool request');
    }
  }
}

function resolveResults(turn: Turn, converted: { id: string; value: SDKCustomToolResult }[]) {
  const resumesRun = converted.some(({ id }) => !turn.pending.get(id)?.result);
  if (resumesRun) {
    turn.streamedSegment = '';
  }
  for (const { id, value } of converted) {
    const call = turn.pending.get(id);
    if (!call) {
      throw new Error('Unknown Cursor tool result');
    }
    if (!call.result) {
      call.result = hash(value);
      call.resolve(value);
    }
  }
}

async function nextUpdate(turn: Turn) {
  if (turn.cancelled) {
    throw turn.cancelled;
  }
  if (!turn.queue.length) {
    await new Promise<void>((resolve) => {
      turn.wake = resolve;
    });
  }
  turn.wake = undefined;
  return turn.queue.shift();
}

function callbackBatch(turn: Turn, first: Pending, single = false) {
  const batch = [first];
  // Late parallel callbacks stay queued for the next exchange.
  while (!single) {
    const next = turn.queue[0];
    if (!next || !('call' in next)) {
      break;
    }
    turn.queue.shift();
    batch.push(next.call);
  }
  return batch;
}

function terminalSuffix(streamed: string, segment: string, terminal: string) {
  if (streamed && terminal.startsWith(streamed)) {
    return terminal.slice(streamed.length);
  }
  if (segment && terminal.startsWith(segment)) {
    return terminal.slice(segment.length);
  }
  if (segment.endsWith(terminal)) {
    return '';
  }
  return terminal;
}

class CursorResponse {
  private textIndex: number | undefined;
  private readonly response: MessagesResponse;
  private readonly emit: Emit;
  private readonly messages: NonNullable<MessagesRequest['messages']>;

  constructor(
    response: MessagesResponse,
    emit: Emit,
    messages: NonNullable<MessagesRequest['messages']>,
  ) {
    this.response = response;
    this.emit = emit;
    this.messages = messages;
  }

  endText() {
    if (this.textIndex !== undefined) {
      this.emit('content_block_stop', { index: this.textIndex });
      this.textIndex = undefined;
    }
  }

  text(text: string) {
    if (!text) {
      return;
    }
    if (this.textIndex === undefined) {
      this.textIndex = this.response.content.length;
      this.response.content.push({ type: 'text', text: '' });
      this.emit('content_block_start', {
        index: this.textIndex,
        content_block: { type: 'text', text: '' },
      });
    }
    const block = this.response.content[this.textIndex];
    if (block.type === 'text') {
      block.text += text;
    }
    this.emit('content_block_delta', {
      index: this.textIndex,
      delta: { type: 'text_delta', text: text },
    });
  }

  tool(call: Pending) {
    const index = this.response.content.length;
    this.response.content.push(call.block);
    this.emit('content_block_start', { index, content_block: { ...call.block, input: {} } });
    this.emit('content_block_delta', {
      index,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.block.input) },
    });
    this.emit('content_block_stop', { index });
    call.delivered = true;
    call.history = historyHash(this.messages);
    call.historyLength = this.messages.length;
  }
}
