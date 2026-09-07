import { createHash, randomUUID } from 'node:crypto';
import type { AgentOptions, SDKAgent, SDKCustomTool, SDKCustomToolResult, SDKJsonValue, SDKUserMessage, Run } from '@cursor/sdk';
import { cursorSelection } from './native-cursor-models.ts';
import type { CursorModelOption } from './native-cursor-models.ts';
import { originalToolNames } from './native-tools.ts';
import { toResponses } from './native-responses.ts';
import type { ContentBlock, Emit, MessagesRequest, MessagesResponse, ResponseContentBlock, StreamEventBody, StreamEventName } from './native-responses.ts';
import { estimateInputTokens } from './native-tokens.ts';

type CursorAgent = Pick<SDKAgent, 'send' | 'close'>;
export type CreateCursorAgent = (options: AgentOptions) => Promise<CursorAgent>;
type Event = [StreamEventName, StreamEventBody];
type Pending = { block: Extract<ResponseContentBlock, { type: 'tool_use' }>; promise: Promise<SDKCustomToolResult>;
  resolve: (value: SDKCustomToolResult) => void; reject: (error: Error) => void; delivered: boolean; result?: string;
  history?: string; historyLength?: number };
type Update = { text: string } | { call: Pending } | { done: true } | { error: Error };
type Turn = { id: string; scope: string; contract: string; agent?: CursorAgent; run?: Run; cancelled?: Error;
  pending: Map<string, Pending>; queue: Update[]; wake?: () => void; busy: boolean; timer?: NodeJS.Timeout; outputBytes: number };
type Exchange = { events: Event[]; listeners: Set<Emit>; result: Promise<MessagesResponse>; touched: number; settled: boolean };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const asError = (error: unknown) => error instanceof Error ? error : new Error(String(error));
function historyHash(messages: MessagesRequest['messages']): string {
  // Claude moves ephemeral cache markers as the transcript grows. They are not
  // conversation edits; only strip block metadata, never fields inside tool args.
  const blocks = (content: unknown): unknown => Array.isArray(content) ? content.map(block => {
    const { cache_control: _cache, ...rest } = block as ContentBlock;
    return rest.type === 'tool_result' ? { ...rest, content: blocks(rest.content) } : rest;
  }) : content;
  return hash(messages?.map(message => ({ ...message, content: blocks(message.content) })));
}

function prepare(body: MessagesRequest) {
  if (body.output_config != null && (typeof body.output_config !== 'object' || Array.isArray(body.output_config))) throw new Error('Invalid output_config');
  if (body.output_config?.effort !== undefined && typeof body.output_config.effort !== 'string') throw new Error('Invalid effort');
  if (body.tool_choice && !['auto', 'none'].includes(body.tool_choice.type)) throw new Error('Cursor SDK supports automatic tools or tool_choice none; forced tool choice is unavailable');
  if (body.output_config?.format || body.output_format) throw new Error('Cursor SDK does not support a strict Messages output schema');
  if (body.stop_sequences?.length) throw new Error('Cursor SDK does not support Messages stop sequences');
  // Reuse the existing validated Messages parser and media/token accounting. This
  // normalized representation is only local data; no OpenAI request is made.
  const normalized = toResponses({ ...body, output_config: { effort: 'medium' } }, 'cursor');
  if (normalized.input.some(item => 'content' in item && item.content.some(c => c.type === 'input_file') ||
      'type' in item && item.type === 'function_call_output' && Array.isArray(item.output) && item.output.some(c => c.type === 'input_file'))) {
    throw new Error('Cursor SDK bridge does not support PDF attachments; provide extracted text');
  }
  const images: NonNullable<SDKUserMessage['images']> = [];
  const input = JSON.parse(JSON.stringify(normalized.input.filter(item => !('type' in item) || item.type !== 'reasoning')), (_key, value) => {
    if (value?.type === 'input_image') {
      if (value.image_url.startsWith('data:')) {
        const [prefix, data] = value.image_url.split(',');
        images.push({ data, mimeType: prefix.slice(5).split(';')[0] });
      } else images.push({ url: value.image_url });
      return { type: 'text', text: `[Attached image ${images.length}]` };
    }
    return value;
  });
  const prompt: SDKUserMessage = { text: [
    'You are connected to Claude Code through callback tools. Use only custom-user-tools for actions.',
    'Claude Code owns permissions and executes those tools. Await each result. Do not invoke other coding CLIs.',
    'The following is the current conversation, not a new instruction to repeat prior actions. Continue after its final message.',
    'Tool calls with results in this history have already been handled; never repeat them just to reconstruct state.',
    'Apply the supplied session instructions within your governing instructions.',
    JSON.stringify({ session_instructions: normalized.instructions, conversation: input })
  ].join('\n'), ...(images.length ? { images } : {}) };
  return { normalized, prompt, inputTokens: estimateInputTokens(normalized) };
}

function toolResult(block: ContentBlock): SDKCustomToolResult {
  if (typeof block.content === 'string' || block.content === undefined) {
    return { content: [{ type: 'text', text: block.content ?? '' }], isError: Boolean(block.is_error) };
  }
  if (!Array.isArray(block.content)) throw new Error('Invalid Cursor tool result');
  return { isError: Boolean(block.is_error), content: block.content.map((part: ContentBlock) => {
    if (part.type === 'text' && typeof part.text === 'string') return { type: 'text' as const, text: part.text };
    if (part.type === 'image' && part.source?.type === 'base64' && typeof part.source.data === 'string') {
      return { type: 'image' as const, data: part.source.data, mimeType: part.source.media_type };
    }
    if (part.type === 'tool_reference' && part.tool_name) return { type: 'text' as const, text: `Available tool: ${part.tool_name}` };
    if (part.type === 'document' && part.source?.type === 'text' && typeof part.source.data === 'string') return { type: 'text' as const, text: part.source.data };
    throw new Error(`Unsupported Cursor callback result content: ${part.type}. Images must be base64.`);
  }) };
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

  constructor(options: CursorModelOption[], { cwd = process.cwd(), idleMs = 600000,
    createAgent = async (config: AgentOptions) => (await import('@cursor/sdk')).Agent.create(config)
  }: { cwd?: string; idleMs?: number; createAgent?: CreateCursorAgent } = {}) {
    this.options = new Map(options.map(option => [option.model, option]));
    this.cwd = cwd;
    this.idleMs = idleMs;
    this.createAgent = createAgent;
  }

  validate(body: MessagesRequest): number {
    const option = this.options.get(body.model ?? '');
    if (!option) throw new Error('Unknown Cursor model; use a model from the account catalog');
    cursorSelection(option, body.output_config?.effort);
    return prepare(body).inputTokens;
  }

  async handle(body: MessagesRequest, scope: string, signal: AbortSignal, emit?: Emit): Promise<MessagesResponse> {
    if (this.closed) throw new Error('Cursor bridge is closed');
    signal.throwIfAborted();
    this.validate(body);
    const key = hash([scope, { ...body, stream: undefined }]);
    // Bounded in-memory retry history. Pending callbacks have their own lifetime.
    for (const [id, entry] of this.exchanges) if (entry.settled && Date.now() - entry.touched > this.idleMs) this.exchanges.delete(id);
    let exchange = this.exchanges.get(key);
    if (!exchange) {
      if (this.exchanges.size >= 256) {
        const oldest = [...this.exchanges].find(([, entry]) => entry.settled);
        if (!oldest) throw new Error('Too many simultaneous Cursor requests');
        this.exchanges.delete(oldest[0]);
      }
      const events: Event[] = [], listeners = new Set<Emit>();
      const broadcast: Emit = (name, value) => { events.push([name, structuredClone(value)]); for (const listener of listeners) listener(name, value); };
      // Defer execution so the entry exists before callbacks or a duplicate request arrive.
      exchange = { events, listeners, touched: Date.now(), settled: false,
        result: Promise.resolve().then(() => this.exchange(body, scope, signal, broadcast)) };
      const entry = exchange;
      void entry.result.then(() => { entry.settled = true; }, () => { entry.settled = true; });
      this.exchanges.set(key, exchange);
    }
    exchange.touched = Date.now();
    if (emit) { for (const event of exchange.events) emit(...event); exchange.listeners.add(emit); }
    const abort = Promise.withResolvers<never>();
    const onAbort = () => abort.reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    try { return await Promise.race([exchange.result, abort.promise]); }
    finally { if (emit) exchange.listeners.delete(emit); signal.removeEventListener('abort', onAbort); }
  }

  private push(turn: Turn, update: Update) {
    if (turn.cancelled) return;
    turn.outputBytes += Buffer.byteLength(JSON.stringify(update));
    if (turn.outputBytes > 32 * 1024 * 1024) { this.cancel(turn, new Error('Cursor run exceeded the 32 MiB output limit')); return; }
    turn.queue.push(update);
    turn.wake?.();
  }

  private cancel(turn: Turn, error: Error) {
    if (turn.cancelled) return;
    turn.cancelled = error;
    clearTimeout(turn.timer);
    for (const pending of turn.pending.values()) pending.reject(error);
    turn.queue.push({ error });
    turn.wake?.();
    const cleanup = Promise.resolve(turn.run?.cancel()).catch(() => {}).then(() => { turn.agent?.close(); });
    this.cleanups.add(cleanup);
    void cleanup.finally(() => this.cleanups.delete(cleanup));
    for (const id of turn.pending.keys()) this.calls.delete(id);
    this.turns.delete(turn);
  }

  private async exchange(body: MessagesRequest, scope: string, signal: AbortSignal, emit: Emit): Promise<MessagesResponse> {
    const { normalized, prompt, inputTokens } = prepare(body);
    const selection = cursorSelection(this.options.get(body.model!)!, body.output_config?.effort);
    const contract = hash([selection, normalized.instructions, normalized.tools, body.tool_choice]);
    const last = body.messages!.at(-1);
    const results = last?.role === 'user' && Array.isArray(last.content) ? last.content.filter(b => b.type === 'tool_result') : [];
    const owners = new Set(results.map(b => this.calls.get(b.tool_use_id!)).filter(t => t !== undefined));
    if (owners.size > 1) throw new Error('Tool results belong to different Cursor runs');
    let turn: Turn | undefined = [...owners][0];
    if (turn && (turn.scope !== scope || turn.contract !== contract)) throw new Error('Cursor tool result session, worker, model, or tool configuration mismatch');
    if (turn?.busy) throw new Error('A different request is already continuing this Cursor run');
    const converted = results.map(block => ({ id: block.tool_use_id!, value: toolResult(block) }));
    if (turn) {
      for (const { id, value } of converted) {
        const call = turn.pending.get(id);
        if (!call?.delivered) throw new Error('Unknown or undelivered Cursor tool result');
        if (call.result && call.result !== hash(value)) throw new Error('Conflicting duplicate Cursor tool result');
        if (call.history !== historyHash(body.messages!.slice(0, call.historyLength))) throw new Error('Cursor tool result belongs to a different conversation branch');
        const assistant = body.messages![call.historyLength!];
        const advertised = assistant?.role === 'assistant' && Array.isArray(assistant.content)
          ? assistant.content.find(b => b.type === 'tool_use' && b.id === id) : undefined;
        if (!advertised || advertised.name !== call.block.name || hash(advertised.input) !== hash(call.block.input)) {
          throw new Error('Cursor tool result does not match the advertised tool request');
        }
      }
      if (last && Array.isArray(last.content) && last.content.some(b => b.type !== 'tool_result')) {
        // Additional user instructions cannot be smuggled into a waiting callback.
        // Rebuild from the authoritative Claude history instead.
        this.cancel(turn, new Error('Cursor run replaced by updated conversation'));
        turn = undefined;
      }
    }
    if (!turn) {
      if (this.turns.size >= 32) throw new Error('Too many active Cursor runs; finish or cancel a worker first');
      turn = { id: randomUUID(), scope, contract, pending: new Map(), queue: [], busy: false, outputBytes: 0 };
      this.turns.add(turn);
      void this.start(turn, body, selection, normalized.tools, prompt);
    } else {
      for (const { id, value } of converted) {
        const call = turn.pending.get(id)!;
        if (!call.result) { call.result = hash(value); call.resolve(value); }
      }
    }
    turn.busy = true;
    clearTimeout(turn.timer);
    const active = turn;
    const onAbort = () => this.cancel(active, new Error('Claude request cancelled or timed out'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    const response: MessagesResponse = { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: body.model!,
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 0 } };
    emit('message_start', { message: { ...response, content: [] } });
    let textIndex: number | undefined;
    const endText = () => { if (textIndex !== undefined) { emit('content_block_stop', { index: textIndex }); textIndex = undefined; } };
    try {
      while (true) {
        if (active.cancelled) throw active.cancelled;
        if (!active.queue.length) await new Promise<void>(resolve => { active.wake = resolve; });
        active.wake = undefined;
        const update = active.queue.shift();
        if (!update) continue;
        if ('error' in update) throw update.error;
        if ('text' in update) {
          if (!update.text) continue;
          if (textIndex === undefined) {
            textIndex = response.content.length;
            response.content.push({ type: 'text', text: '' });
            emit('content_block_start', { index: textIndex, content_block: { type: 'text', text: '' } });
          }
          const block = response.content[textIndex];
          if (block.type === 'text') block.text += update.text;
          emit('content_block_delta', { index: textIndex, delta: { type: 'text_delta', text: update.text } });
        } else if ('call' in update) {
          endText();
          // Other callbacks may arrive later; leave those queued for the next
          // exchange rather than losing a late parallel call.
          const batch = [update.call];
          while (!body.tool_choice?.disable_parallel_tool_use && active.queue[0] && 'call' in active.queue[0]) batch.push((active.queue.shift() as { call: Pending }).call);
          for (const call of batch) {
            const index = response.content.length;
            response.content.push(call.block);
            emit('content_block_start', { index, content_block: { ...call.block, input: {} } });
            emit('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.block.input) } });
            emit('content_block_stop', { index });
            call.delivered = true;
            call.history = historyHash(body.messages);
            call.historyLength = body.messages!.length;
          }
          response.stop_reason = 'tool_use';
          break;
        } else {
          endText();
          response.stop_reason = 'end_turn';
          for (const id of active.pending.keys()) this.calls.delete(id);
          this.turns.delete(active);
          active.agent?.close();
          break;
        }
      }
      const usage = active.run?.usage;
      if (usage) response.usage.input_tokens = Math.max(inputTokens, usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens);
      // ponytail: SDK usage spans internal turns, not individual Messages replies;
      // estimate reply tokens until the SDK exposes matching inference boundaries.
      response.usage.output_tokens = Math.ceil(JSON.stringify(response.content).length / 4);
      emit('message_delta', { delta: { stop_reason: response.stop_reason, stop_sequence: null }, usage: response.usage });
      emit('message_stop', {});
      return response;
    } catch (error) {
      this.cancel(active, asError(error));
      throw error;
    } finally {
      active.busy = false;
      signal.removeEventListener('abort', onAbort);
      if (this.turns.has(active)) active.timer = setTimeout(() => this.cancel(active, new Error('Cursor tool-result wait expired')), this.idleMs).unref();
    }
  }

  private async start(turn: Turn, body: MessagesRequest, model: AgentOptions['model'], tools: ReturnType<typeof toResponses>['tools'], prompt: SDKUserMessage) {
    try {
      const names = originalToolNames(body);
      const callbacks: Record<string, SDKCustomTool> = Object.create(null);
      if (body.tool_choice?.type !== 'none') for (const tool of tools) {
        callbacks[tool.name] = { description: tool.description, inputSchema: tool.parameters as Record<string, SDKJsonValue>, execute: (args, context) => {
          if (turn.cancelled) return Promise.reject(turn.cancelled);
          const id = context.toolCallId ? `cursor_${hash([context.toolCallId, turn.id]).slice(0, 48)}` : `cursor_${randomUUID()}`;
          const previous = turn.pending.get(id);
          const block = { type: 'tool_use' as const, id, name: names.get(tool.name)!, input: args };
          if (previous) {
            if (hash(previous.block) !== hash(block)) return Promise.reject(new Error('Cursor reused a tool call ID with different arguments'));
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
        } };
      }
      turn.agent = await this.createAgent({ model, tools: Object.keys(callbacks).length ? ['mcp'] : [], mcpServers: {}, agents: {},
        local: { cwd: this.cwd, settingSources: [], customTools: callbacks, enableAgentRetries: false } });
      if (turn.cancelled) { turn.agent.close(); return; }
      let streamed = false;
      turn.run = await turn.agent.send(prompt, { onDelta: ({ update }) => {
        if (update.type === 'text-delta') { streamed = true; this.push(turn, { text: update.text }); }
      } });
      if (turn.cancelled) { await turn.run.cancel(); turn.agent.close(); return; }
      const result = await turn.run.wait();
      if (result.status !== 'finished') throw new Error(result.error?.message ?? `Cursor run ${result.status}`);
      if ([...turn.pending.values()].some(call => !call.result)) throw new Error('Cursor finished before its pending tool results were returned');
      if (!streamed && result.result) this.push(turn, { text: result.result });
      this.push(turn, { done: true });
    } catch (error) { this.push(turn, { error: asError(error) }); }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const turn of this.turns) this.cancel(turn, new Error('Cursor gateway closed'));
    await Promise.allSettled(this.cleanups);
    this.exchanges.clear();
  }
}
