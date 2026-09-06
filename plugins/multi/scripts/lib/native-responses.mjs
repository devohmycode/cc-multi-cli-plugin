// Anthropic Messages <-> OpenAI Responses, for native Claude Code workers.
const SIGNATURE_PREFIX = 'multi-openai:';

// Only rewrite Claude-bound history when it contains our provider's opaque state.
export function forAnthropic(body) {
  let changed = false;
  const messages = body.messages?.map(message => {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) return message;
    const content = message.content.filter(block => {
      const foreign = block.type === 'thinking' && block.signature?.startsWith(SIGNATURE_PREFIX);
      changed ||= foreign;
      return !foreign;
    });
    return { ...message, content };
  }).filter(message => !Array.isArray(message.content) || message.content.length);
  return changed ? { ...body, messages } : body;
}

function blocks(value) {
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  if (!Array.isArray(value)) throw new Error('Expected text or content blocks');
  return value;
}

function textOnly(value) {
  return blocks(value).map(block => {
    if (block.type !== 'text' || typeof block.text !== 'string') {
      throw new Error(`Unsupported text content: ${block.type}`);
    }
    return block.text;
  }).join('\n');
}

function imageInput(block) {
  const source = block.source;
  let image_url;
  if (source?.type === 'base64') {
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(source.media_type)
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

function toolOutput(block) {
  const content = blocks(block.content ?? '');
  const prefix = block.is_error ? 'Tool error:\n' : '';
  if (!content.some(item => item.type === 'image')) return prefix + textOnly(content);
  return [
    ...(prefix ? [{ type: 'input_text', text: prefix }] : []),
    ...content.map(item => item.type === 'image' ? imageInput(item) : { type: 'input_text', text: textOnly([item]) })
  ];
}

export function toResponses(body, model) {
  if (!Array.isArray(body.messages)) throw new Error('messages must be an array');
  if (body.stop_sequences?.length) throw new Error('Native OpenAI workers do not yet support stop sequences');
  const format = body.output_config?.format ?? body.output_format;
  if (format != null && (format.type !== 'json_schema' || !format.schema || typeof format.schema !== 'object' || Array.isArray(format.schema))) {
    throw new Error('Unsupported output format: expected json_schema with an object schema');
  }
  const input = [];
  for (const message of body.messages) {
    if (!['user', 'assistant', 'system'].includes(message.role)) throw new Error('Unsupported message role');
    for (const block of blocks(message.content)) {
      if (block.type === 'text') {
        input.push({ role: message.role === 'system' ? 'developer' : message.role,
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
        const item = JSON.parse(Buffer.from(block.signature.slice(SIGNATURE_PREFIX.length), 'base64url').toString());
        if (item.type !== 'reasoning' || typeof item.encrypted_content !== 'string') throw new Error('Invalid reasoning state');
        input.push({ type: 'reasoning', id: item.id, encrypted_content: item.encrypted_content, summary: item.summary ?? [] });
      } else if (block.type === 'redacted_thinking' && message.role === 'assistant') {
        continue;
      } else {
        throw new Error(`Unsupported native worker content: ${block.type}`);
      }
    }
  }
  const tools = (body.tools ?? []).map(tool => {
    if (tool.type && tool.type !== 'custom') throw new Error(`Unsupported server tool: ${tool.type}`);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name) || !tool.input_schema) throw new Error('Invalid function tool');
    return { type: 'function', name: tool.name, description: tool.description ?? '', parameters: tool.input_schema, strict: false };
  });
  const choice = body.tool_choice;
  if (choice && !['auto', 'any', 'none', 'tool'].includes(choice.type)) throw new Error('Unsupported tool choice');
  const effort = body.output_config?.effort ?? 'medium';
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new Error(`Unsupported reasoning effort: ${effort}`);
  return {
    model, instructions: textOnly(body.system ?? ''), input, tools,
    // Preserve the schema's meaning; OpenAI validates its supported strict subset.
    ...(format ? { text: { format: { type: 'json_schema', name: 'claude_output', schema: format.schema, strict: true } } } : {}),
    tool_choice: choice?.type === 'tool' ? { type: 'function', name: choice.name }
      : choice?.type === 'any' ? 'required' : choice?.type ?? 'auto',
    parallel_tool_calls: !choice?.disable_parallel_tool_use,
    reasoning: { effort, summary: 'auto' }, include: ['reasoning.encrypted_content'],
    // Codex's subscription endpoint requires store:false and streamed responses.
    // ponytail: max_tokens is not accepted there; use bounded tasks until provider-side caps exist.
    store: false, stream: true
  };
}

export async function* readSse(stream) {
  const decoder = new TextDecoder();
  let pending = '';
  let data = [];
  const parse = () => {
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

export async function fromResponses(stream, model, emit = () => {}) {
  const content = [];
  const slots = new Map();
  let message;
  let completed = false;
  const start = response => {
    if (message) return;
    message = { id: response.id, type: 'message', role: 'assistant', model, content,
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } };
    emit('message_start', { message: { ...message, content: [] } });
  };
  const open = (key, block) => {
    if (slots.has(key)) return slots.get(key);
    const slot = { index: content.length, block, stopped: false, arguments: '' };
    slots.set(key, slot);
    content.push(block);
    emit('content_block_start', { index: slot.index, content_block: { ...block } });
    return slot;
  };
  const delta = (slot, value) => emit('content_block_delta', { index: slot.index, delta: value });
  const stop = slot => {
    if (!slot.stopped) emit('content_block_stop', { index: slot.index });
    slot.stopped = true;
  };
  for await (const event of readSse(stream)) {
    if (event.type === 'response.created') start(event.response);
    else if (event.type === 'response.output_item.added') {
      if (!message) throw new Error('OpenAI stream omitted response.created');
      const item = event.item;
      if (item.type === 'function_call') open(event.output_index, { type: 'tool_use', id: item.call_id, name: item.name, input: {} });
      else if (item.type === 'reasoning') open(event.output_index, { type: 'thinking', thinking: '', signature: '' });
      else if (item.type !== 'message') throw new Error(`Unsupported OpenAI output: ${item.type}`);
    } else if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
      const slot = open(event.output_index, { type: 'text', text: '' });
      slot.block.text += event.delta;
      delta(slot, { type: 'text_delta', text: event.delta });
    } else if (event.type === 'response.function_call_arguments.delta') {
      const slot = slots.get(event.output_index);
      if (!slot) throw new Error('Arguments without function call');
      slot.arguments += event.delta;
      delta(slot, { type: 'input_json_delta', partial_json: event.delta });
    } else if (event.type === 'response.reasoning_summary_text.delta') {
      const slot = slots.get(event.output_index);
      if (!slot) throw new Error('Summary without reasoning item');
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
        slot.block.text = text;
        delta(slot, { type: 'text_delta', text });
      }
      if (!slot) throw new Error('Output item ended without starting');
      if (item.type === 'function_call') {
        if (!slot.arguments) delta(slot, { type: 'input_json_delta', partial_json: item.arguments });
        slot.block.input = JSON.parse(item.arguments);
      } else if (item.type === 'reasoning') {
        if (!item.encrypted_content) throw new Error('OpenAI omitted encrypted reasoning state');
        slot.block.signature = SIGNATURE_PREFIX + Buffer.from(JSON.stringify(item)).toString('base64url');
        delta(slot, { type: 'signature_delta', signature: slot.block.signature });
      }
      stop(slot);
    } else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      start(event.response);
      if (event.type === 'response.incomplete' && event.response.incomplete_details?.reason !== 'max_output_tokens') {
        throw new Error(`OpenAI response incomplete: ${event.response.incomplete_details?.reason ?? 'unknown'}`);
      }
      for (const slot of slots.values()) if (!slot.stopped) throw new Error('OpenAI completed with an unfinished content block');
      const usage = event.response.usage ?? {};
      const cached = usage.input_tokens_details?.cached_tokens ?? 0;
      message.usage = { input_tokens: Math.max(0, (usage.input_tokens ?? 0) - cached),
        output_tokens: usage.output_tokens ?? 0, cache_read_input_tokens: cached, cache_creation_input_tokens: 0 };
      message.stop_reason = event.type === 'response.incomplete' ? 'max_tokens'
        : content.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
      emit('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: message.usage });
      emit('message_stop', {});
      completed = true;
      break;
    } else if (event.type === 'error' || event.type === 'response.failed') {
      throw new Error(event.message ?? event.response?.error?.message ?? 'OpenAI stream failed');
    }
  }
  if (!completed) throw new Error('OpenAI stream ended before completion');
  return message;
}
