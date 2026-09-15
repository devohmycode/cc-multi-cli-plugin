import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type {
  ContentBlock,
  Emit,
  MessagesRequest,
  MessagesResponse,
  RequestMessage,
} from './messages.ts';
import {
  type NativeObservation,
  type NativeRow,
  type NativeRowObserver,
  type NativeRowRecord,
  nativeRowExchange,
  nativeRowNames,
  nativeRowTools,
  rowText,
} from './native-rows-protocol.ts';
import { NativeRowsStore, rowDigest } from './native-rows-store.ts';
import { lockStateFile } from './state-lock.ts';

const denial =
  '[Cursor] Some display rows were unavailable or denied; this did not authorize or undo native actions.\n';
const interrupted =
  '[Cursor] Native display interrupted; native state is retained. Send a new prompt to continue.';
function blocks(message: RequestMessage | undefined): ContentBlock[] {
  return Array.isArray(message?.content) ? message.content : [];
}
function exchangeId(message: RequestMessage | undefined) {
  return blocks(message)
    .map((block) => nativeRowExchange(block.id))
    .find(Boolean);
}
function reminder(block: ContentBlock) {
  return (
    block.type === 'text' &&
    typeof block.text === 'string' &&
    /^\s*<system-reminder>[\s\S]*<\/system-reminder>\s*$/.test(block.text)
  );
}
function response(model: string, text: string): MessagesResponse {
  return {
    id: `msg_${randomBytes(16).toString('hex')}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}
export function emitRowResponse(value: MessagesResponse, emit: Emit) {
  emit('message_start', { message: { ...value, content: [], stop_reason: null } });
  for (const [index, block] of value.content.entries()) {
    emit('content_block_start', { index, content_block: { type: 'text', text: '' } });
    if (block.type === 'text') {
      emit('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } });
    }
    emit('content_block_stop', { index });
  }
  emit('message_delta', {
    delta: { stop_reason: value.stop_reason, stop_sequence: null },
    usage: value.usage,
  });
  emit('message_stop', {});
}
function validateResults(messages: RequestMessage[], record: NativeRowRecord) {
  const assistant = blocks(messages.at(-2));
  const actual = assistant.map((block) => ({ id: block.id, name: block.name, input: block.input }));
  const expected = record.rows.map(({ id, name, input }) => ({ id, name, input }));
  const results = blocks(messages.at(-1)).filter((block) => !reminder(block));
  if (
    rowDigest(actual) !== rowDigest(expected) ||
    results.length !== record.rows.length ||
    results.some((block) => block.type !== 'tool_result') ||
    new Set(results.map((block) => block.tool_use_id)).size !== results.length ||
    record.rows.some((row) => !results.some((block) => block.tool_use_id === row.id))
  ) {
    throw new Error('Invalid native display follow-up; no native action was dispatched');
  }
  return results.some((block) => block.is_error);
}

/** Owns only observations. A Messages connection owns native execution throughout the run. */
export class NativeRows {
  private readonly store: NativeRowsStore;
  private readonly active = new Map<string, RowStream>();
  private readonly enabled: boolean;
  constructor(directory: string, enabled = false) {
    this.store = new NativeRowsStore(directory);
    this.enabled = enabled;
  }
  available(body: MessagesRequest) {
    return (
      this.enabled && nativeRowNames.every((name) => body.tools?.some((tool) => tool.name === name))
    );
  }

  async followup(body: MessagesRequest, scope: string) {
    const messages = (body.messages ?? []).filter((message) => message.role !== 'system');
    const id = exchangeId(messages.at(-2));
    if (!id) {
      return undefined;
    }
    // A fresh user message after an interrupted display is a prompt, not an acknowledgement.
    if (!blocks(messages.at(-1)).some((block) => block.type === 'tool_result')) {
      return undefined;
    }
    const saved = await this.store.load(scope, id);
    if (!saved?.final) {
      return response(body.model ?? '', interrupted);
    }
    if (saved.model !== body.model) {
      throw new Error('Native display model changed during follow-up');
    }
    const denied = validateResults(messages, saved);
    if (!denied) {
      return saved.final;
    }
    return {
      ...saved.final,
      content: [
        {
          type: 'text' as const,
          text: denial,
        },
        ...saved.final.content,
      ],
    };
  }

  async normalize(body: MessagesRequest, scope: string): Promise<MessagesRequest> {
    const messages: RequestMessage[] = [];
    let previous: { id: string; record?: NativeRowRecord } | undefined;
    for (const message of body.messages ?? []) {
      if (message.role === 'system') {
        messages.push(message);
        continue;
      }
      const id = message.role === 'assistant' ? exchangeId(message) : undefined;
      if (id) {
        previous = { id, record: await this.store.load(scope, id) };
        messages.push({
          role: 'assistant',
          content: previous.record?.original?.content ?? interrupted,
        });
      } else if (previous && this.bridgeMessage(message, previous)) {
        // Display calls/results never enter the native prompt, including on disk resume.
      } else {
        messages.push(message);
        previous = undefined;
      }
    }
    return { ...body, messages };
  }
  private bridgeMessage(
    message: RequestMessage,
    previous: { id: string; record?: NativeRowRecord },
  ) {
    if (message.role === 'assistant') {
      const content = blocks(message).filter(
        (block) => block.type !== 'text' || block.text !== denial,
      );
      return (
        rowDigest(content.map((block) => ({ type: block.type, text: block.text }))) ===
          rowDigest(previous.record?.final?.content) ||
        (content.length === 1 && content[0].type === 'text' && content[0].text === interrupted)
      );
    }
    const content = blocks(message);
    return (
      content.length > 0 &&
      content.every(
        (block) =>
          reminder(block) ||
          (block.type === 'tool_result' && nativeRowExchange(block.tool_use_id) === previous.id),
      )
    );
  }

  async run(
    body: MessagesRequest,
    scope: string,
    emit: Emit,
    abort: AbortController,
    execute: (observer: NativeRowObserver) => Promise<MessagesResponse>,
  ) {
    await this.store.prepare();
    const key = rowDigest([scope, body, 'cursor-rows-v1']);
    const release = await lockStateFile(path.join(this.store.directory, `${key}.lock`));
    try {
      abort.signal.throwIfAborted();
      const prior = await this.store.index(key);
      if (prior) {
        return await this.replay(scope, prior, emit);
      }
      const saved: NativeRowRecord = {
        version: 1,
        id: randomBytes(16).toString('hex'),
        scope,
        model: body.model ?? '',
        rows: [],
      };
      await this.store.save(saved);
      await this.store.rememberScope(saved.id, scope);
      await this.store.remember(key, saved.id);
      const stream = new RowStream(saved, emit, abort);
      this.active.set(saved.id, stream);
      try {
        const original = await execute((event) => stream.observe(event));
        stream.flush();
        saved.original = original;
        saved.final = response(
          saved.model,
          stream.tail.trim() ||
            original.content
              .filter((block) => block.type === 'text')
              .map((block) => block.text)
              .join('\n') ||
            '[Cursor] Native run completed.',
        );
        stream.settle();
        await this.store.save(saved);
        stream.finish(original);
        return original;
      } finally {
        stream.close();
        this.active.delete(saved.id);
      }
    } finally {
      await release();
    }
  }
  private async replay(scope: string, id: string, emit: Emit) {
    const saved = await this.store.load(scope, id);
    if (!saved?.original || !saved.final) {
      throw new Error(interrupted);
    }
    const stream = new RowStream(saved, emit, new AbortController());
    for (const row of saved.rows) {
      stream.emitRow(row);
    }
    stream.finish(saved.original);
    stream.close();
    return saved.original;
  }

  async rpc(value: Record<string, unknown>, signal: AbortSignal) {
    const method = value.method;
    if (method === 'initialize') {
      return {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'Cursor', version: '1' },
      };
    }
    if (method === 'tools/list') {
      return { tools: nativeRowTools };
    }
    if (method === 'ping') {
      return {};
    }
    if (method !== 'tools/call') {
      throw new Error('Unknown native display MCP method');
    }
    return this.waiter(value.params, signal);
  }
  private async waiter(params: unknown, signal: AbortSignal) {
    if (
      !isObject(params) ||
      !isObject(params._meta) ||
      typeof params._meta['claudecode/toolUseId'] !== 'string'
    ) {
      throw new Error('Native display requires Claude tool correlation');
    }
    const toolId = params._meta['claudecode/toolUseId'];
    const id = nativeRowExchange(toolId);
    const stream = id ? this.active.get(id) : undefined;
    const record = stream?.record ?? (id ? await this.store.locate(id) : undefined);
    const row = record?.rows.find((item) => item.id === toolId);
    if (
      !row ||
      row.name !== `mcp__multi_cursor__${params.name}` ||
      rowDigest(row.input) !== rowDigest(params.arguments)
    ) {
      throw new Error('Unknown or modified native display row');
    }
    const result =
      row.result ?? (stream ? await stream.wait(row, signal) : { text: interrupted, error: true });
    return {
      content: result.text ? [{ type: 'text', text: result.text }] : [],
      isError: result.error,
    };
  }
}
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

class RowStream {
  tail = '';
  private note = '';
  private index = 0;
  private readonly nativeIds = new Map<string, NativeRow>();
  private readonly pending = new Map<
    string,
    ReturnType<typeof Promise.withResolvers<NonNullable<NativeRow['result']>>>
  >();
  private readonly timer: NodeJS.Timeout;
  readonly record: NativeRowRecord;
  private readonly emit: Emit;
  private readonly abort: AbortController;
  constructor(record: NativeRowRecord, emit: Emit, abort: AbortController) {
    this.record = record;
    this.emit = emit;
    this.abort = abort;
    emit('message_start', {
      message: {
        ...response(record.model, ''),
        id: `msg_${record.id}`,
        content: [],
        stop_reason: null,
      },
    });
    this.timer = setInterval(() => {
      if (!abort.signal.aborted) {
        try {
          this.flush();
        } catch (error) {
          abort.abort(error);
        }
      }
    }, 750);
  }
  observe(event: NativeObservation) {
    if (event.type === 'text') {
      this.tail += event.text;
      this.note += event.text;
      if (this.note.length >= 512) {
        this.flush();
      }
      return;
    }
    if (event.type === 'started') {
      this.flush();
      this.tail = '';
      if (this.nativeIds.has(event.id)) {
        return;
      }
      const row = this.add(event.kind, event.description);
      if (row) {
        this.nativeIds.set(event.id, row);
      }
    } else {
      const row = this.nativeIds.get(event.id);
      if (row) {
        row.result = { text: rowText(event.text, 4096), error: event.error };
        this.pending.get(row.id)?.resolve(row.result);
      }
    }
  }
  flush() {
    if (this.note) {
      const row = this.add('note', this.note);
      if (row) {
        row.result = { text: '', error: false };
        this.pending.get(row.id)?.resolve(row.result);
      }
      this.note = '';
    }
  }
  private add(kind: string, description: string) {
    // Bound transcript growth without stopping or serializing the native run.
    if (this.record.rows.length >= 2048) {
      return undefined;
    }
    const row: NativeRow = {
      id: `toolu_multi_cursor_${this.record.id}_${this.record.rows.length}`,
      name: `mcp__multi_cursor__${kind}`,
      input: { description: rowText(description, kind === 'note' ? 1200 : 160) },
    };
    this.record.rows.push(row);
    this.pending.set(row.id, Promise.withResolvers());
    this.emitRow(row);
    return row;
  }
  emitRow(row: NativeRow) {
    const index = this.index++;
    this.emit('content_block_start', {
      index,
      content_block: { type: 'tool_use', id: row.id, name: row.name, input: {} },
    });
    this.emit('content_block_delta', {
      index,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(row.input) },
    });
    this.emit('content_block_stop', { index });
  }
  settle() {
    for (const row of this.record.rows) {
      if (!row.result) {
        row.result = { text: 'Native run ended without a per-action outcome.', error: false };
        this.pending.get(row.id)?.resolve(row.result);
      }
    }
  }
  finish(original: MessagesResponse) {
    if (!this.record.rows.length) {
      this.emit('content_block_start', {
        index: 0,
        content_block: { type: 'text', text: '' },
      });
      this.emit('content_block_delta', {
        index: 0,
        delta: {
          type: 'text_delta',
          text:
            this.tail ||
            original.content
              .filter((block) => block.type === 'text')
              .map((block) => block.text)
              .join('\n') ||
            '[Cursor] Native run completed.',
        },
      });
      this.emit('content_block_stop', { index: 0 });
    }
    this.emit('message_delta', {
      delta: {
        stop_reason: this.record.rows.length ? 'tool_use' : 'end_turn',
        stop_sequence: null,
      },
      usage: original.usage,
    });
    this.emit('message_stop', {});
  }
  async wait(row: NativeRow, signal: AbortSignal) {
    if (row.result) {
      return row.result;
    }
    const promise = this.pending.get(row.id);
    if (!promise) {
      throw new Error('Native display waiter missing');
    }
    const cancel = () => this.abort.abort(new Error('Native display waiter disconnected'));
    signal.addEventListener('abort', cancel, { once: true });
    try {
      if (signal.aborted) {
        cancel();
      }
      return await promise.promise;
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }
  close() {
    clearInterval(this.timer);
    for (const item of this.pending.values()) {
      item.resolve({
        text: 'Native display interrupted; per-action outcome unavailable.',
        error: true,
      });
    }
  }
}
