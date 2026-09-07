import { toolName, callId } from './native-tools.ts';
// Anthropic Messages <-> OpenAI Responses, for native Claude Code workers.
const SIGNATURE_PREFIX = 'multi-openai:';
const IMAGE_MEDIA_TYPES: readonly unknown[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export type Effort = (typeof EFFORTS)[number];

// ---------------------------------------------------------------------------
// Anthropic Messages, as Claude Code sends them. These arrive as untrusted JSON:
// fields the gateway inspects rather than forwards stay `unknown` so every use
// has to narrow them first.
// ---------------------------------------------------------------------------

export interface ImageSource {
  type: string;
  media_type?: string;
  data?: unknown;
  url?: unknown;
}

/** A request content block. `type` selects which fields are meaningful; the
 *  translation validates them per block kind and rejects anything else. */
export interface ContentBlock {
  type: string;
  text?: unknown;
  source?: ImageSource;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
  signature?: string;
  thinking?: string;
  data?: string;
  cache_control?: unknown;
  title?: string;
  tool_name?: string;
}

export interface RequestMessage {
  role: string;
  content: string | ContentBlock[];
}

export interface Tool {
  type?: string;
  name?: string;
  description?: string;
  input_schema?: unknown;
  defer_loading?: boolean;
}

export interface ToolChoice {
  type: string;
  name?: string;
  disable_parallel_tool_use?: boolean;
}

/** Structured-output request. The schema is forwarded verbatim, so it stays opaque. */
export interface OutputFormat {
  type?: string;
  schema?: unknown;
}

export interface MessagesRequest {
  model?: string;
  system?: string | ContentBlock[];
  messages?: RequestMessage[];
  tools?: Tool[];
  tool_choice?: ToolChoice;
  stop_sequences?: string[];
  output_config?: { effort?: string; format?: OutputFormat };
  output_format?: OutputFormat;
  stream?: boolean;
  thinking?: { type: string; budget_tokens?: number };
}

// ---------------------------------------------------------------------------
// Anthropic Messages, as the gateway answers them.
// ---------------------------------------------------------------------------

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export type ResponseContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'thinking'; thinking: string; signature: string };

export interface MessagesResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: ResponseContentBlock[];
  stop_reason: StopReason | null;
  stop_sequence: string | null;
  usage: Usage;
}

export type BlockDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'input_json_delta'; partial_json: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'signature_delta'; signature: string };

export type StreamEventName = 'message_start' | 'content_block_start' | 'content_block_delta'
  | 'content_block_stop' | 'message_delta' | 'message_stop' | 'ping' | 'error';

/** An Anthropic SSE event without its `type`; the gateway merges the two. */
export type StreamEventBody =
  | { message: MessagesResponse }
  | { index: number; content_block: ResponseContentBlock }
  | { index: number; delta: BlockDelta }
  | { index: number }
  | { delta: { stop_reason: StopReason | null; stop_sequence: string | null }; usage: Usage }
  | { error: { type: string; message: string } }
  | Record<string, never>;

export type Emit = (type: StreamEventName, value: StreamEventBody) => void;

// ---------------------------------------------------------------------------
// OpenAI Responses, as the gateway sends and reads them.
// ---------------------------------------------------------------------------

export type ResponsesInputContent =
  | { type: 'input_text' | 'output_text'; text: string }
  | { type: 'input_image'; image_url: string; detail: 'auto' }
  | { type: 'input_file'; filename: string; file_data: string };

export type ResponsesInputItem =
  | { role: 'user' | 'assistant' | 'developer'; content: ResponsesInputContent[] }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string | ResponsesInputContent[] }
  | { type: 'reasoning'; id?: string; encrypted_content: string; summary: unknown };

export interface ResponsesTool {
  type: 'function';
  name: string;
  description: string;
  parameters: unknown;
  strict: boolean;
}

export type ResponsesToolChoice = 'auto' | 'none' | 'required' | { type: 'function'; name?: string };

export interface ResponsesRequest {
  model: string;
  instructions: string;
  input: ResponsesInputItem[];
  tools: ResponsesTool[];
  text?: { format: { type: 'json_schema'; name: string; schema: unknown; strict: boolean } };
  tool_choice: ResponsesToolChoice;
  parallel_tool_calls: boolean;
  reasoning: { effort: Effort; summary: 'auto' };
  include: string[];
  store: boolean;
  stream: boolean;
}

export interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
}

export interface ResponsesResponse {
  id: string;
  usage?: ResponsesUsage | null;
  incomplete_details?: { reason?: string };
  error?: { message?: string };
}

/** Part of a completed `message` output item. */
export interface ResponsesOutputContent {
  type: string;
  text?: string;
  refusal?: string;
}

/** The output items this gateway understands; any other `type` is rejected. */
export type ResponsesOutputItem =
  | { type: 'message'; content?: ResponsesOutputContent[] }
  | { type: 'function_call'; call_id?: string; name?: string; arguments?: string }
  | { type: 'reasoning'; id?: string; encrypted_content?: string; summary?: unknown };

/** Streamed events the translation acts on. Any other `type` is ignored, exactly
 *  as an unrecognised event was before it had a name here. */
export type ResponseStreamEvent =
  | { type: 'response.created'; response: ResponsesResponse }
  | { type: 'response.output_item.added'; output_index: number; item: ResponsesOutputItem }
  | { type: 'response.output_item.done'; output_index: number; item: ResponsesOutputItem }
  | { type: 'response.output_text.delta'; output_index: number; delta: string }
  | { type: 'response.refusal.delta'; output_index: number; delta: string }
  | { type: 'response.function_call_arguments.delta'; output_index: number; delta: string }
  | { type: 'response.reasoning_summary_text.delta'; output_index: number; delta: string }
  | { type: 'response.completed'; response: ResponsesResponse }
  | { type: 'response.incomplete'; response: ResponsesResponse }
  | { type: 'response.failed'; response?: Pick<ResponsesResponse, 'error'>; message?: string }
  | { type: 'error'; response?: Pick<ResponsesResponse, 'error'>; message?: string };

/** Provider reasoning state, round-tripped through an opaque Claude signature. */
export interface ReasoningState {
  type: 'reasoning';
  id?: string;
  encrypted_content: string;
  summary?: unknown;
}

// Boundary guards: JSON.parse and the provider stream hand us `unknown`.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOutputItem(value: unknown, done: boolean): value is ResponsesOutputItem {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (value.type === 'function_call') {
    return ['call_id', 'name', 'arguments'].every(key =>
      value[key] === undefined ? !done : typeof value[key] === 'string');
  }
  if (value.type === 'message') return value.content === undefined ||
    (Array.isArray(value.content) && value.content.every(part => isRecord(part) &&
      (part.type === 'output_text' ? typeof part.text === 'string' :
       part.type === 'refusal' && typeof part.refusal === 'string')));
  if (value.type === 'reasoning') return (value.id === undefined || typeof value.id === 'string') &&
    (value.encrypted_content == null ? !done : typeof value.encrypted_content === 'string') &&
    (value.summary === undefined || (Array.isArray(value.summary) && value.summary.every(part =>
      isRecord(part) && part.type === 'summary_text' && typeof part.text === 'string')));
  return false;
}

function validResponse(value: unknown): boolean {
  if (!isRecord(value) || typeof value.id !== 'string') return false;
  if (value.usage == null) return true;
  if (!isRecord(value.usage)) return false;
  const count = (v: unknown) => v === undefined || (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0);
  const usage = value.usage;
  return count(usage.input_tokens) && count(usage.output_tokens) &&
    (usage.input_tokens_details === undefined || (isRecord(usage.input_tokens_details) && count(usage.input_tokens_details.cached_tokens)));
}

/** Ignore new event types; validate every known field before narrowing JSON. */
function isStreamEvent(value: unknown): value is ResponseStreamEvent {
  if (!isRecord(value) || typeof value.type !== 'string') throw new Error('Malformed OpenAI stream event');
  const indexed = Number.isSafeInteger(value.output_index) && Number(value.output_index) >= 0;
  let valid: boolean;
  switch (value.type) {
    case 'response.created': case 'response.completed': case 'response.incomplete':
      valid = validResponse(value.response); break;
    case 'response.output_item.added': case 'response.output_item.done':
      valid = indexed && isOutputItem(value.item, value.type.endsWith('.done')); break;
    case 'response.output_text.delta': case 'response.refusal.delta':
    case 'response.function_call_arguments.delta': case 'response.reasoning_summary_text.delta':
      valid = indexed && typeof value.delta === 'string'; break;
    case 'response.failed': case 'error':
      valid = (value.message === undefined || typeof value.message === 'string') &&
        (value.response === undefined || (isRecord(value.response) &&
          (value.response.error === undefined || (isRecord(value.response.error) &&
            (value.response.error.message === undefined || typeof value.response.error.message === 'string'))))); break;
    default: return false;
  }
  if (!valid) throw new Error(`OpenAI sent a malformed ${value.type} event`);
  return true;
}

function isReasoningState(value: unknown): value is ReasoningState {
  return isRecord(value) && isOutputItem(value, true) && value.type === 'reasoning' &&
    typeof value.encrypted_content === 'string' && value.encrypted_content.length > 0;
}

function isEffort(value: string): value is Effort {
  return (EFFORTS as readonly string[]).includes(value);
}

// Only rewrite Claude-bound history when it contains our provider's opaque state.
export function forAnthropic(body: MessagesRequest): MessagesRequest {
  let changed = false;
  const messages = body.messages?.map(message => {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) return message;
    const content = message.content.filter(block => {
      const foreign = block.type === 'thinking' && block.signature?.startsWith(SIGNATURE_PREFIX);
      changed ||= Boolean(foreign);
      return !foreign;
    });
    return { ...message, content };
  }).filter(message => !Array.isArray(message.content) || message.content.length);
  return changed ? { ...body, messages } : body;
}

function blocks(value: unknown): ContentBlock[] {
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  if (!Array.isArray(value)) throw new Error('Expected text or content blocks');
  for (const block of value) {
    if (!isRecord(block) || typeof block.type !== 'string') throw new Error('Invalid content block');
    for (const key of ['id', 'name', 'tool_use_id', 'signature', 'title', 'tool_name']) {
      if (block[key] !== undefined && typeof block[key] !== 'string') throw new Error(`Invalid content field: ${key}`);
    }
    if (block.is_error !== undefined && typeof block.is_error !== 'boolean') throw new Error('Invalid tool result error flag');
  }
  return value;
}

function textOnly(value: unknown): string {
  return blocks(value).map(block => {
    if (block.type !== 'text' || typeof block.text !== 'string') {
      throw new Error(`Unsupported text content: ${block.type}`);
    }
    return block.text;
  }).join('\n');
}

function imageInput(block: ContentBlock): ResponsesInputContent {
  const source = block.source;
  let image_url;
  if (source?.type === 'base64') {
    if (!IMAGE_MEDIA_TYPES.includes(source.media_type)
        || typeof source.data !== 'string' || !source.data
        || Buffer.from(source.data, 'base64').toString('base64') !== source.data) {
      throw new Error('Invalid base64 image source');
    }
    image_url = `data:${source.media_type};base64,${source.data}`;
  } else if (source?.type === 'url') {
    let url;
    if (typeof source.url !== 'string') throw new Error('Invalid image URL');
    try { url = new URL(source.url); } catch { throw new Error('Invalid image URL'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid image URL');
    image_url = source.url;
  } else {
    throw new Error('Unsupported image source');
  }
  // Forward the source to the provider; never fetch image URLs in the gateway.
  return { type: 'input_image', image_url, detail: 'auto' };
}

function documentInput(block: ContentBlock): ResponsesInputContent[] {
  const source = block.source;
  const title = block.title ? `Document: ${block.title}\n` : '';
  if (source?.type === 'text' && source.media_type === 'text/plain' && typeof source.data === 'string') {
    return [{ type: 'input_text', text: title + source.data }];
  }
  if (source?.type !== 'base64' || source.media_type !== 'application/pdf' ||
      typeof source.data !== 'string' || !source.data ||
      Buffer.from(source.data, 'base64').toString('base64') !== source.data) {
    throw new Error('Unsupported document: use base64 PDF or text/plain');
  }
  return [{ type: 'input_file', filename: 'document.pdf', file_data: `data:application/pdf;base64,${source.data}` }];
}

function toolOutput(block: ContentBlock): string | ResponsesInputContent[] {
  const content = blocks(block.content ?? '');
  const prefix = block.is_error ? 'Tool error:\n' : '';
  if (!content.some(item => ['image', 'document', 'tool_reference'].includes(item.type))) return prefix + textOnly(content);
  return [
    ...(prefix ? [{ type: 'input_text' as const, text: prefix }] : []),
    ...content.flatMap((item): ResponsesInputContent[] => {
      if (item.type === 'image') return [imageInput(item)];
      if (item.type === 'document') return documentInput(item);
      if (item.type === 'tool_reference' && item.tool_name) return [{ type: 'input_text', text: `Available tool: ${toolName(item.tool_name)}` }];
      return [{ type: 'input_text', text: textOnly([item]) }];
    })
  ];
}

export function toResponses(body: MessagesRequest, model: string): ResponsesRequest {
  if (!Array.isArray(body.messages)) throw new Error('messages must be an array');
  if (body.stop_sequences !== undefined && (!Array.isArray(body.stop_sequences) ||
      body.stop_sequences.some(s => typeof s !== 'string' || !s.length))) throw new Error('Invalid stop sequences');
  if (body.tools !== undefined && !Array.isArray(body.tools)) throw new Error('tools must be an array');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw new Error('stream must be boolean');
  for (const key of ['output_config', 'output_format', 'thinking', 'tool_choice'] as const) {
    if (body[key] != null && !isRecord(body[key])) throw new Error(`Invalid ${key}`);
  }
  const format = body.output_config?.format ?? body.output_format;
  if (format != null && (format.type !== 'json_schema' || !format.schema || typeof format.schema !== 'object' || Array.isArray(format.schema))) {
    throw new Error('Unsupported output format: expected json_schema with an object schema');
  }
  const input: ResponsesInputItem[] = [];
  for (const message of body.messages) {
    if (!isRecord(message)) throw new Error('Invalid message');
    const role = message.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'system') throw new Error('Unsupported message role');
    for (const block of blocks(message.content)) {
      if (block.type === 'text') {
        input.push({ role: role === 'system' ? 'developer' : role,
          content: [{ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: textOnly([block]) }] });
      } else if (block.type === 'image' && message.role === 'user') {
        input.push({ role: 'user', content: [imageInput(block)] });
      } else if (block.type === 'document' && message.role === 'user') {
        input.push({ role: 'user', content: documentInput(block) });
      } else if (block.type === 'tool_use' && message.role === 'assistant') {
        if (!block.id || !block.name || !isRecord(block.input)) throw new Error('Invalid tool_use');
        input.push({ type: 'function_call', call_id: callId(block.id), name: toolName(block.name), arguments: JSON.stringify(block.input) });
      } else if (block.type === 'tool_result' && message.role === 'user') {
        if (!block.tool_use_id) throw new Error('Missing tool result ID');
        input.push({ type: 'function_call_output', call_id: callId(block.tool_use_id),
          output: toolOutput(block) });
      } else if (block.type === 'thinking' && message.role === 'assistant') {
        if (!block.signature?.startsWith(SIGNATURE_PREFIX)) continue;
        const item: unknown = JSON.parse(Buffer.from(block.signature.slice(SIGNATURE_PREFIX.length), 'base64url').toString());
        if (!isReasoningState(item)) throw new Error('Invalid reasoning state');
        input.push({ type: 'reasoning', id: item.id, encrypted_content: item.encrypted_content, summary: item.summary ?? [] });
      } else if (block.type === 'redacted_thinking' && message.role === 'assistant') {
        continue;
      } else {
        throw new Error(`Unsupported native worker content: ${block.type}`);
      }
    }
  }
  const tools = (body.tools ?? []).map((tool): ResponsesTool => {
    if (!isRecord(tool)) throw new Error('Invalid tool');
    if (tool.type && tool.type !== 'custom') throw new Error(`Unsupported server tool: ${tool.type}`);
    if (typeof tool.name !== 'string' || !tool.name.trim() || !isRecord(tool.input_schema)) throw new Error('Invalid function tool');
    if (tool.description !== undefined && typeof tool.description !== 'string') throw new Error('Invalid tool description');
    return { type: 'function', name: toolName(tool.name), description: tool.description ?? '', parameters: tool.input_schema, strict: false };
  });
  const choice = body.tool_choice;
  const wanted = choice?.type ?? 'auto';
  if (wanted !== 'auto' && wanted !== 'any' && wanted !== 'none' && wanted !== 'tool') throw new Error('Unsupported tool choice');
  if (wanted === 'tool' && (typeof choice?.name !== 'string' || !tools.some(t => t.name === toolName(choice.name!)))) throw new Error('Named tool choice must reference a declared tool');
  if (choice?.disable_parallel_tool_use !== undefined && typeof choice.disable_parallel_tool_use !== 'boolean') throw new Error('Invalid parallel tool choice');
  const thinking = body.thinking;
  if (thinking && !['enabled', 'adaptive', 'disabled', 'auto'].includes(thinking.type)) throw new Error('Unsupported thinking configuration');
  const budget = thinking?.budget_tokens;
  if (budget !== undefined && (!Number.isSafeInteger(budget) || budget < 0)) throw new Error('Invalid thinking budget');
  const effort = body.output_config?.effort ?? (thinking?.type === 'disabled' ? 'low' :
    budget === undefined ? 'medium' : budget <= 1024 ? 'low' : budget <= 8192 ? 'medium' : budget <= 24576 ? 'high' : 'xhigh');
  if (!isEffort(effort)) throw new Error(`Unsupported reasoning effort: ${effort}`);
  return {
    model, instructions: textOnly(body.system ?? ''), input, tools,
    // Preserve the schema's meaning; OpenAI validates its supported strict subset.
    ...(format ? { text: { format: { type: 'json_schema' as const, name: 'claude_output', schema: format.schema, strict: true } } } : {}),
    tool_choice: wanted === 'tool' ? { type: 'function', name: toolName(choice!.name!) } : wanted === 'any' ? 'required' : wanted,
    parallel_tool_calls: !choice?.disable_parallel_tool_use,
    reasoning: { effort, summary: 'auto' }, include: ['reasoning.encrypted_content'],
    // Codex's subscription endpoint requires store:false and streamed responses.
    // ponytail: max_tokens is not accepted there; use bounded tasks until provider-side caps exist.
    store: false, stream: true
  };
}

export async function* readSse(stream: AsyncIterable<Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let pending = '';
  let data: string[] = [];
  let dataBytes = 0;
  let totalBytes = 0;
  const addData = (line: string) => {
    dataBytes += Buffer.byteLength(line);
    if (dataBytes > 8 * 1024 * 1024) throw new Error('OpenAI SSE event exceeds 8 MiB');
    data.push(line);
  };
  const parse = (): unknown => {
    const value = data.join('\n');
    if (Buffer.byteLength(value) > 8 * 1024 * 1024) throw new Error('OpenAI SSE event exceeds 8 MiB');
    data = [];
    dataBytes = 0;
    return value && value !== '[DONE]' ? JSON.parse(value) : null;
  };
  for await (const chunk of stream) {
    totalBytes += chunk.byteLength;
    if (totalBytes > 32 * 1024 * 1024) throw new Error('OpenAI response exceeds 32 MiB');
    pending += decoder.decode(chunk, { stream: true });
    if (Buffer.byteLength(pending) > 8 * 1024 * 1024) throw new Error('OpenAI SSE buffer exceeds 8 MiB');
    let index;
    while ((index = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, index).replace(/\r$/, '');
      pending = pending.slice(index + 1);
      if (!line) { const event = parse(); if (event) yield event; }
      else if (line.startsWith('data:')) addData(line.slice(5).replace(/^ /, ''));
    }
  }
  pending += decoder.decode();
  if (pending.startsWith('data:')) addData(pending.slice(5).trimStart());
  const event = parse();
  if (event) yield event;
}

interface OutputSlot {
  item: ResponsesOutputItem;
  text: string;
  arguments: string;
  done: boolean;
  block?: ResponseContentBlock;
  index?: number;
  emitted: number;
}

export interface ResponseOptions {
  toolNames?: ReadonlyMap<string, string>;
  stopSequences?: readonly string[];
}

export async function fromResponses(stream: AsyncIterable<Uint8Array>, model: string, emit: Emit = () => {},
    options: ResponseOptions = {}): Promise<MessagesResponse> {
  const content: ResponseContentBlock[] = [];
  const slots = new Map<number, OutputSlot>();
  let message: MessagesResponse | undefined;
  let completed = false;
  let stopped: string | null = null;
  let cursor = 0;
  const start = (response: ResponsesResponse) => {
    if (message) return;
    message = { id: response.id, type: 'message', role: 'assistant', model, content,
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } };
    emit('message_start', { message: { ...message, content: [] } });
  };
  const finish = (stopReason: StopReason, usage?: ResponsesUsage | null) => {
    if (!message) throw new Error('OpenAI stream omitted response.created');
    const cached = usage?.input_tokens_details?.cached_tokens ?? 0;
    message.usage = { input_tokens: Math.max(0, (usage?.input_tokens ?? 0) - cached),
      output_tokens: usage?.output_tokens ?? 0, cache_read_input_tokens: cached, cache_creation_input_tokens: 0 };
    message.stop_reason = stopReason;
    message.stop_sequence = stopped;
    emit('message_delta', { delta: { stop_reason: stopReason, stop_sequence: stopped }, usage: message.usage });
    emit('message_stop', {});
    completed = true;
  };
  // Emit one Claude block at a time. Parallel calls can finish out of order;
  // their metadata/arguments are held until the preceding block has ended.
  const drain = () => {
    const ordered = [...slots.values()];
    while (cursor < ordered.length && !stopped) {
      const slot = ordered[cursor];
      const item = slot.item;
      if (item.type === 'function_call' && !slot.done) return;
      if (!slot.block) {
        if (item.type === 'function_call') {
          if (!item.call_id || !item.name || typeof item.arguments !== 'string') throw new Error('Incomplete function call');
          if (slot.arguments && slot.arguments !== item.arguments) throw new Error('OpenAI function arguments changed after streaming');
          const input: unknown = JSON.parse(item.arguments);
          if (!isRecord(input)) throw new Error('OpenAI function arguments must be an object');
          const name = options.toolNames?.get(item.name) ?? item.name;
          if (options.toolNames && !options.toolNames.has(item.name)) throw new Error('OpenAI returned an undeclared tool');
          slot.block = { type: 'tool_use', id: callId(item.call_id), name, input };
        } else if (item.type === 'reasoning') slot.block = { type: 'thinking', thinking: '', signature: '' };
        else slot.block = { type: 'text', text: '' };
        slot.index = content.length;
        content.push(slot.block);
        emit('content_block_start', { index: slot.index, content_block: slot.block.type === 'tool_use'
          ? { ...slot.block, input: {} } : { ...slot.block } });
      }
      const index = slot.index!;
      if (slot.block.type === 'tool_use') {
        emit('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(slot.block.input) } });
      } else {
        let limit = slot.text.length;
        if (slot.block.type === 'text') {
          let matchAt = Infinity;
          for (const stop of options.stopSequences ?? []) {
            const at = slot.text.indexOf(stop);
            if (at >= 0 && at < matchAt) { matchAt = at; stopped = stop; }
          }
          if (stopped) limit = matchAt;
          else if (!slot.done) {
            // Hold only a suffix that might become a stop string in a later delta.
            for (const stop of options.stopSequences ?? []) for (let n = 1; n < stop.length; n++) {
              if (slot.text.endsWith(stop.slice(0, n))) limit = Math.min(limit, slot.text.length - n);
            }
          }
        }
        const text = slot.text.slice(slot.emitted, limit);
        if (text) emit('content_block_delta', { index, delta: slot.block.type === 'text'
          ? { type: 'text_delta', text } : { type: 'thinking_delta', thinking: text } });
        slot.emitted = limit;
        if (slot.block.type === 'text') slot.block.text = slot.text.slice(0, limit);
        else slot.block.thinking = slot.text.slice(0, limit);
      }
      if (!slot.done && !stopped) return;
      if (item.type === 'reasoning' && slot.block.type === 'thinking') {
        if (!isReasoningState(item)) throw new Error('OpenAI omitted encrypted reasoning state');
        slot.block.signature = SIGNATURE_PREFIX + Buffer.from(JSON.stringify(item)).toString('base64url');
        emit('content_block_delta', { index, delta: { type: 'signature_delta', signature: slot.block.signature } });
      }
      emit('content_block_stop', { index });
      cursor++;
    }
  };
  for await (const event of readSse(stream)) {
    if (!isStreamEvent(event)) continue;
    if (event.type === 'response.created') start(event.response);
    else if (event.type === 'response.failed' || event.type === 'error') {
      throw new Error(event.message ?? event.response?.error?.message ?? 'OpenAI stream failed');
    } else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      start(event.response);
      if (event.type === 'response.incomplete' && event.response.incomplete_details?.reason !== 'max_output_tokens') {
        throw new Error(`OpenAI response incomplete: ${event.response.incomplete_details?.reason ?? 'unknown'}`);
      }
      if ([...slots.values()].some(slot => !slot.done)) throw new Error('OpenAI completed with an unfinished content block');
      drain();
      finish(event.type === 'response.incomplete' ? 'max_tokens' : content.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn', event.response.usage);
      break;
    } else {
      if (!message) throw new Error('OpenAI stream omitted response.created');
      if (event.type === 'response.output_item.added') {
        if (slots.has(event.output_index)) throw new Error('Duplicate OpenAI output item');
        slots.set(event.output_index, { item: event.item, text: '', arguments: '', done: false, emitted: 0 });
      } else {
        const slot = slots.get(event.output_index);
        if (!slot || slot.done) throw new Error('OpenAI event without an active output item');
        if (event.type === 'response.output_item.done') {
          if (slot.item.type !== event.item.type) throw new Error('OpenAI output item changed type');
          slot.item = event.item;
          slot.done = true;
          if (event.item.type === 'message') {
            const text = (event.item.content ?? []).map(b => b.type === 'refusal' ? b.refusal : b.text).join('');
            if (slot.text && slot.text !== text) throw new Error('OpenAI text changed after streaming');
            slot.text = text;
          } else if (event.item.type === 'reasoning' && !slot.text && Array.isArray(event.item.summary)) {
            slot.text = event.item.summary.map(part => (part as { text: string }).text).join('\n');
          }
        } else if (event.type === 'response.function_call_arguments.delta') {
          if (slot.item.type !== 'function_call') throw new Error('Arguments without function call');
          slot.arguments += event.delta;
        } else {
          const thinking = event.type === 'response.reasoning_summary_text.delta';
          if (slot.item.type !== (thinking ? 'reasoning' : 'message')) throw new Error('OpenAI delta has the wrong output type');
          slot.text += event.delta;
        }
      }
      drain();
      if (stopped) { finish('stop_sequence'); break; }
    }
  }
  if (!completed || !message) throw new Error('OpenAI stream ended before completion');
  return message;
}
