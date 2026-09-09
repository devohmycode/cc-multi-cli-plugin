import { createHash } from 'node:crypto';
import type {
  ContentBlock,
  MessagesRequest,
  RequestMessage,
} from '../../multi-core/src/gateway/messages.ts';
import { estimateTextTokens } from '../../multi-openai/src/tokens.ts';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Claude's billing attribution suffix changes after compaction; it is not an instruction. */
export function antigravitySystem(system: MessagesRequest['system']) {
  const billingHeader = (text: unknown) =>
    typeof text === 'string' && /^x-anthropic-billing-header: [^\r\n]*$/.test(text);
  if (Array.isArray(system)) {
    return system.filter((block) => block.type !== 'text' || !billingHeader(block.text));
  }
  return billingHeader(system) ? undefined : system;
}

/** Cache markers are transport metadata; moving them must not fork native history. */
export function antigravityHistoryHash(messages: MessagesRequest['messages']): string {
  const normalize = (content: unknown): unknown =>
    Array.isArray(content)
      ? content.map((block) => {
          if (!block || typeof block !== 'object') {
            return block;
          }
          const { cache_control: _cache, ...rest } = block as ContentBlock;
          return rest.type === 'tool_result' ? { ...rest, content: normalize(rest.content) } : rest;
        })
      : content;
  return hash(messages?.map((message) => ({ ...message, content: normalize(message.content) })));
}

function blockText(block: ContentBlock, allowReasoning: boolean, role: string): string {
  if (block.type === 'text' && typeof block.text === 'string') {
    return block.text;
  }
  if (block.type === 'tool_use') {
    return toolUseText(block, role);
  }
  if (block.type === 'tool_result') {
    return toolResultText(block, role);
  }
  if (block.type === 'thinking' || block.type === 'redacted_thinking') {
    if (allowReasoning) {
      return '';
    }
    throw new Error('Antigravity CLI does not accept provider-owned reasoning content');
  }
  throw new Error(`Antigravity CLI does not support content block ${block.type}`);
}

function toolUseText(block: ContentBlock, role: string): string {
  if (role !== 'assistant' || typeof block.id !== 'string' || typeof block.name !== 'string') {
    throw new Error('Antigravity CLI requires assistant tool_use blocks');
  }
  return `[tool use ${block.name}] ${JSON.stringify(block.input ?? {})}`;
}

function toolResultText(block: ContentBlock, role: string): string {
  if (role !== 'user' || typeof block.tool_use_id !== 'string' || block.content === undefined) {
    throw new Error('Antigravity CLI requires tool_result content');
  }
  return `[tool result ${block.tool_use_id}] ${contentText(block.content, false, 'tool_result')}`;
}

function contentText(content: unknown, allowReasoning = false, role = 'user'): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (!block || typeof block !== 'object' || Array.isArray(block)) {
          throw new Error('Antigravity CLI requires valid content blocks');
        }
        return blockText(block as ContentBlock, allowReasoning, role);
      })
      .join('');
  }
  if (content === undefined) {
    return '';
  }
  throw new Error('Antigravity CLI requires string or array content');
}

function messageText(message: RequestMessage): string {
  if (!['user', 'assistant', 'system'].includes(message.role)) {
    throw new Error(`Antigravity CLI does not support ${message.role} messages`);
  }
  return `${message.role}: ${contentText(message.content, message.role === 'assistant', message.role)}`;
}

/** Convert Messages context into one authenticated agy prompt. Native tools stay in agy. */
export function prepareAntigravityRequest(body: MessagesRequest, model = body.model ?? '') {
  validateRequest(body);
  const sections = [
    'You are the Antigravity coding agent displayed inside Claude Code.',
    'Use your native tools and permissions. Previously recorded actions are complete; do not repeat them.',
    body.system ? `system: ${contentText(antigravitySystem(body.system), false, 'system')}` : '',
    body.messages?.map(messageText).join('\n'),
  ].filter(Boolean);
  const prompt = sections.join('\n\n');
  return { prompt, inputTokens: estimateTextTokens(prompt), model };
}

function validateRequest(body: MessagesRequest) {
  if (!Array.isArray(body.messages) || !body.messages.length) {
    throw new Error('Antigravity requires a conversation');
  }
  if (
    body.messages.some(
      (message) =>
        !message ||
        typeof message !== 'object' ||
        !['user', 'assistant', 'system'].includes(message.role) ||
        (typeof message.content !== 'string' && !Array.isArray(message.content)),
    )
  ) {
    throw new Error('Antigravity requires valid conversation messages');
  }
  if (body.system !== undefined && typeof body.system !== 'string' && !Array.isArray(body.system)) {
    throw new Error('Antigravity requires valid system content');
  }
  if (body.output_config?.format || body.output_format) {
    throw new Error('Antigravity CLI does not support strict Messages output schemas');
  }
  if (body.tool_choice && body.tool_choice.type !== 'auto') {
    throw new Error('Antigravity CLI only supports its native automatic tools');
  }
  if (
    body.thinking !== undefined &&
    (!body.thinking ||
      typeof body.thinking !== 'object' ||
      !['enabled', 'disabled', 'adaptive'].includes(body.thinking.type) ||
      (body.thinking.budget_tokens !== undefined &&
        (!Number.isSafeInteger(body.thinking.budget_tokens) || body.thinking.budget_tokens < 0)))
  ) {
    throw new Error('Antigravity requires a valid thinking configuration');
  }
  if (body.stop_sequences?.length) {
    throw new Error('Antigravity CLI does not support Messages stop sequences');
  }
}

export function antigravityTerminalSuffix(streamed: string, terminal: string): string {
  if (streamed && terminal.startsWith(streamed)) {
    return terminal.slice(streamed.length);
  }
  if (streamed.endsWith(terminal)) {
    return '';
  }
  return terminal;
}
