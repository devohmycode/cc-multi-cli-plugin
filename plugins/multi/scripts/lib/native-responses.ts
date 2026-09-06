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
}

// ---------------------------------------------------------------------------
// Anthropic Messages, as the gateway answers them.
// ---------------------------------------------------------------------------

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens';

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
  stop_sequence: null;
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
  | { delta: { stop_reason: StopReason | null; stop_sequence: null }; usage: Usage }
  | { error: { type: string; message: string } }
  | Record<string, never>;

export type Emit = (type: StreamEventName, value: StreamEventBody) => void;

// ---------------------------------------------------------------------------
// OpenAI Responses, as the gateway sends and reads them.
// ---------------------------------------------------------------------------

export type ResponsesInputContent =
  | { type: 'input_text' | 'output_text'; text: string }
  | { type: 'input_image'; image_url: string; detail: 'auto' };

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
  usage?: ResponsesUsage;
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
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
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
  | { type: 'response.failed'; response?: ResponsesResponse; message?: string }
  | { type: 'error'; response?: ResponsesResponse; message?: string };

/** Provider reasoning state, round-tripped through an opaque Claude signature. */
export interface ReasoningState {
  type: 'reasoning';
  id?: string;
  encrypted_content: string;
  summary?: unknown;
}

// Boundary guards: JSON.parse and the provider stream hand us `unknown`.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStreamEvent(value: unknown): value is ResponseStreamEvent {
  return isRecord(value) && typeof value.type === 'string';
}

function isReasoningState(value: unknown): value is ReasoningState {
  return isRecord(value) && value.type === 'reasoning' && typeof value.encrypted_content === 'string';
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

function toolOutput(block: ContentBlock): string | ResponsesInputContent[] {
  const content = blocks(block.content ?? '');
  const prefix = block.is_error ? 'Tool error:\n' : '';
  if (!content.some(item => item.type === 'image')) return prefix + textOnly(content);
  return [
    ...(prefix ? [{ type: 'input_text' as const, text: prefix }] : []),
    ...content.map((item): ResponsesInputContent =>
      item.type === 'image' ? imageInput(item) : { type: 'input_text', text: textOnly([item]) })
  ];
}

export function toResponses(body: MessagesRequest, model: string): ResponsesRequest {
  if (!Array.isArray(body.messages)) throw new Error('messages must be an array');
  if (body.stop_sequences?.length) throw new Error('Native OpenAI workers do not yet support stop sequences');
  const format = body.output_config?.format ?? body.output_format;
  if (format != null && (format.type !== 'json_schema' || !format.schema || typeof format.schema !== 'object' || Array.isArray(format.schema))) {
    throw new Error('Unsupported output format: expected json_schema with an object schema');
  }
  const input: ResponsesInputItem[] = [];
  for (const message of body.messages) {
    const role = message.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'system') throw new Error('Unsupported message role');
    for (const block of blocks(message.content)) {
      if (block.type === 'text') {
        input.push({ role: role === 'system' ? 'developer' : role,
          content: [{ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: textOnly([block]) }] });
      } else if (block.type === 'image' && message.role === 'user') {
        input.push({ role: 'user', content: [imageInput(block)] });
      } else if (block.type === 'tool_use' && message.role === 'assistant') {
        if (!block.id || !block.name || !block.input || typeof block.input !== 'object') throw new Error('Invalid tool_use');
        input.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.input) });
      } else if (block.type === 'tool_result' && message.role === 'user') {
        if (!block.tool_use_id) throw new Error('Missing tool result ID');
        input.push({ type: 'function_call_output', call_id: block.tool_use_id,
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
    if (tool.type && tool.type !== 'custom') throw new Error(`Unsupported server tool: ${tool.type}`);
    if (typeof tool.name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name) || !tool.input_schema) throw new Error('Invalid function tool');
    return { type: 'function', name: tool.name, description: tool.description ?? '', parameters: tool.input_schema, strict: false };
  });
  const choice = body.tool_choice;
  const wanted = choice?.type ?? 'auto';
  if (wanted !== 'auto' && wanted !== 'any' && wanted !== 'none' && wanted !== 'tool') throw new Error('Unsupported tool choice');
  const effort = body.output_config?.effort ?? 'medium';
  if (!isEffort(effort)) throw new Error(`Unsupported reasoning effort: ${effort}`);
  return {
    model, instructions: textOnly(body.system ?? ''), input, tools,
    // Preserve the schema's meaning; OpenAI validates its supported strict subset.
    ...(format ? { text: { format: { type: 'json_schema' as const, name: 'claude_output', schema: format.schema, strict: true } } } : {}),
    tool_choice: wanted === 'tool' ? { type: 'function', name: choice?.name } : wanted === 'any' ? 'required' : wanted,
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
  const parse = (): unknown => {
    const value = data.join('\n');
    data = [];
    return value && value !== '[DONE]' ? JSON.parse(value) : null;
  };
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, index).replace(/\r$/, '');
      pending = pending.slice(index + 1);
      if (!line) { const event = parse(); if (event) yield event; }
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
  }
  pending += decoder.decode();
  if (pending.startsWith('data:')) data.push(pending.slice(5).trimStart());
  const event = parse();
  if (event) yield event;
}

interface Slot {
  index: number;
  block: ResponseContentBlock;
  stopped: boolean;
  arguments: string;
}

export async function fromResponses(stream: AsyncIterable<Uint8Array>, model: string, emit: Emit = () => {}): Promise<MessagesResponse> {
  const content: ResponseContentBlock[] = [];
  const slots = new Map<number, Slot>();
  let message: MessagesResponse | undefined;
  let completed = false;
  const start = (response: ResponsesResponse): MessagesResponse => {
    if (!message) {
      message = { id: response.id, type: 'message', role: 'assistant', model, content,
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } };
      emit('message_start', { message: { ...message, content: [] } });
    }
    return message;
  };
  const open = (key: number, block: ResponseContentBlock): Slot => {
    const existing = slots.get(key);
    if (existing) return existing;
    const slot = { index: content.length, block, stopped: false, arguments: '' };
    slots.set(key, slot);
    content.push(block);
    emit('content_block_start', { index: slot.index, content_block: { ...block } });
    return slot;
  };
  const delta = (slot: Slot, value: BlockDelta) => emit('content_block_delta', { index: slot.index, delta: value });
  const stop = (slot: Slot) => {
    if (!slot.stopped) emit('content_block_stop', { index: slot.index });
    slot.stopped = true;
  };
  for await (const event of readSse(stream)) {
    if (!isStreamEvent(event)) continue;
    if (event.type === 'response.created') start(event.response);
    else if (event.type === 'response.output_item.added') {
      if (!message) throw new Error('OpenAI stream omitted response.created');
      const item = event.item;
      // `kind` keeps the reported value: the declared union has no member for the
      // output types this rejects.
      const kind = item.type;
      if (item.type === 'function_call') open(event.output_index, { type: 'tool_use', id: item.call_id, name: item.name, input: {} });
      else if (item.type === 'reasoning') open(event.output_index, { type: 'thinking', thinking: '', signature: '' });
      else if (item.type !== 'message') throw new Error(`Unsupported OpenAI output: ${kind}`);
    } else if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
      const slot = open(event.output_index, { type: 'text', text: '' });
      if (slot.block.type !== 'text') throw new Error('OpenAI sent text for a non-text output');
      slot.block.text += event.delta;
      delta(slot, { type: 'text_delta', text: event.delta });
    } else if (event.type === 'response.function_call_arguments.delta') {
      const slot = slots.get(event.output_index);
      if (!slot) throw new Error('Arguments without function call');
      slot.arguments += event.delta;
      delta(slot, { type: 'input_json_delta', partial_json: event.delta });
    } else if (event.type === 'response.reasoning_summary_text.delta') {
      const slot = slots.get(event.output_index);
      if (!slot || slot.block.type !== 'thinking') throw new Error('Summary without reasoning item');
      slot.block.thinking += event.delta;
      delta(slot, { type: 'thinking_delta', thinking: event.delta });
    } else if (event.type === 'response.output_item.done') {
      const item = event.item;
      let slot = slots.get(event.output_index);
      if (item.type === 'message' && !slot) {
        const text = (item.content ?? []).map(b => {
          if (b.type === 'refusal') return b.refusal;
          if (b.type === 'output_text') return b.text;
          throw new Error(`Unsupported message output: ${b.type}`);
        }).join('\n');
        slot = open(event.output_index, { type: 'text', text: '' });
        if (slot.block.type !== 'text') throw new Error('OpenAI sent text for a non-text output');
        slot.block.text = text;
        delta(slot, { type: 'text_delta', text });
      }
      if (!slot) throw new Error('Output item ended without starting');
      if (item.type === 'function_call') {
        if (slot.block.type !== 'tool_use') throw new Error('OpenAI ended a function call on a non-tool output');
        if (!slot.arguments) delta(slot, { type: 'input_json_delta', partial_json: item.arguments });
        slot.block.input = JSON.parse(item.arguments);
      } else if (item.type === 'reasoning') {
        if (slot.block.type !== 'thinking') throw new Error('OpenAI ended reasoning on a non-thinking output');
        if (!item.encrypted_content) throw new Error('OpenAI omitted encrypted reasoning state');
        slot.block.signature = SIGNATURE_PREFIX + Buffer.from(JSON.stringify(item)).toString('base64url');
        delta(slot, { type: 'signature_delta', signature: slot.block.signature });
      }
      stop(slot);
    } else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      const started = start(event.response);
      if (event.type === 'response.incomplete' && event.response.incomplete_details?.reason !== 'max_output_tokens') {
        throw new Error(`OpenAI response incomplete: ${event.response.incomplete_details?.reason ?? 'unknown'}`);
      }
      for (const slot of slots.values()) if (!slot.stopped) throw new Error('OpenAI completed with an unfinished content block');
      const usage = event.response.usage ?? {};
      const cached = usage.input_tokens_details?.cached_tokens ?? 0;
      started.usage = { input_tokens: Math.max(0, (usage.input_tokens ?? 0) - cached),
        output_tokens: usage.output_tokens ?? 0, cache_read_input_tokens: cached, cache_creation_input_tokens: 0 };
      started.stop_reason = event.type === 'response.incomplete' ? 'max_tokens'
        : content.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
      emit('message_delta', { delta: { stop_reason: started.stop_reason, stop_sequence: null }, usage: started.usage });
      emit('message_stop', {});
      completed = true;
      break;
    } else if (event.type === 'error' || event.type === 'response.failed') {
      throw new Error(event.message ?? event.response?.error?.message ?? 'OpenAI stream failed');
    }
  }
  if (!completed || !message) throw new Error('OpenAI stream ended before completion');
  return message;
}
