import { createHash } from 'node:crypto';
import type {
  ContentBlock,
  MessagesRequest,
  RequestMessage,
} from '../../multi-core/src/gateway/messages.ts';
import { estimateTextTokens } from '../../multi-core/src/gateway/tokens.ts';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

const PREAMBLE =
  'You are the Grok Build coding agent displayed inside Claude Code. Complete the task ' +
  'using your native tools and permissions, verify changes, and report results and any ' +
  'denied actions. Previously recorded actions are complete; do not repeat them. Do not ' +
  'spawn child agents or external coding CLIs.';

/** Cache markers are transport metadata; moving them must not fork native history. */
export function grokHistoryHash(messages: MessagesRequest['messages']): string {
  const normalize = (content: unknown): unknown =>
    Array.isArray(content)
      ? content.map((block) => {
          if (!block || typeof block !== 'object') {
            return block;
          }
          const { cache_control: _cache, ...rest } = block as ContentBlock;
          if (rest.type === 'text' && typeof rest.text === 'string') {
            // Identity follows the prompt actually sent: a retry that only carries a
            // fresh reminder is the same request, and must not run a second time.
            return { ...rest, text: withoutClaudeReminders(rest.text) };
          }
          return rest.type === 'tool_result' ? { ...rest, content: normalize(rest.content) } : rest;
        })
      : content;
  return hash(messages?.map((message) => ({ ...message, content: normalize(message.content) })));
}

/**
 * Claude's system reminders are instructions addressed to Claude: catalogues of
 * its deferred tools, MCP servers, skills and subagents, none of which this
 * provider can call. Measured on a live session, they were 99% of a flattened
 * prompt — 95,011 characters out of 95,852 for a one-word message — and they
 * describe capabilities the provider does not have, which is misleading as well
 * as expensive. They are dropped.
 *
 * Recalled memories are the exception: unlike the repository's own AGENTS.md,
 * which the CLI reads for itself, their content exists nowhere the provider can
 * reach. `native-grok-request.test.ts` pins both halves against the block
 * openings a live session produced, so a change upstream fails a test instead of
 * silently dropping or forwarding the wrong thing.
 */
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const RECALLED_MEMORIES = /Below are some potentially helpful\/relevant pieces of information/i;

function withoutClaudeReminders(text: string): string {
  return text.replace(SYSTEM_REMINDER, (block) => (RECALLED_MEMORIES.test(block) ? block : ''));
}

function blockText(block: ContentBlock, allowReasoning: boolean, role: string): string {
  if (block.type === 'text' && typeof block.text === 'string') {
    return withoutClaudeReminders(block.text);
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
    throw new Error('Grok CLI does not accept provider-owned reasoning content');
  }
  throw new Error(`Grok CLI does not support content block ${block.type}`);
}

function toolUseText(block: ContentBlock, role: string): string {
  if (role !== 'assistant' || typeof block.id !== 'string' || typeof block.name !== 'string') {
    throw new Error('Grok CLI requires assistant tool_use blocks');
  }
  return `[tool use ${block.name}] ${JSON.stringify(block.input ?? {})}`;
}

function toolResultText(block: ContentBlock, role: string): string {
  if (role !== 'user' || typeof block.tool_use_id !== 'string' || block.content === undefined) {
    throw new Error('Grok CLI requires tool_result content');
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
          throw new Error('Grok CLI requires valid content blocks');
        }
        return blockText(block as ContentBlock, allowReasoning, role);
      })
      .join('');
  }
  if (content === undefined) {
    return '';
  }
  throw new Error('Grok CLI requires string or array content');
}

function messageText(message: RequestMessage): string {
  if (!['user', 'assistant', 'system'].includes(message.role)) {
    throw new Error(`Grok CLI does not support ${message.role} messages`);
  }
  const content = contentText(message.content, message.role === 'assistant', message.role);
  // A turn that carried nothing but reminders has no content left to forward.
  return content.trim() ? `${message.role}: ${content}` : '';
}

/**
 * Convert Messages context into one authenticated Grok prompt: a fixed preamble plus
 * the conversation text. The CLI applies its own system prompt and reads the repo's
 * AGENTS.md natively, so Claude's `system` is never forwarded. Native tools stay in
 * the CLI.
 */
export function prepareGrokRequest(body: MessagesRequest, model = body.model ?? '') {
  validateRequest(body);
  const conversation = (body.messages ?? []).map(messageText).filter(Boolean).join('\n');
  if (!conversation) {
    throw new Error('Grok requires a conversation with content');
  }
  const prompt = [PREAMBLE, conversation].join('\n\n');
  return { prompt, inputTokens: estimateTextTokens(prompt), model };
}

function validateRequest(body: MessagesRequest) {
  if (!Array.isArray(body.messages) || !body.messages.length) {
    throw new Error('Grok requires a conversation');
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
    throw new Error('Grok requires valid conversation messages');
  }
  if (body.output_config?.format || body.output_format) {
    // The CLI has --json-schema, but only for a whole single-turn run; it cannot
    // carry a Messages schema through a native tool loop.
    throw new Error('Grok CLI does not support strict Messages output schemas');
  }
  if (body.tool_choice && body.tool_choice.type !== 'auto') {
    throw new Error('Grok CLI only supports its native automatic tools');
  }
  if (
    body.thinking !== undefined &&
    (!body.thinking ||
      typeof body.thinking !== 'object' ||
      !['enabled', 'disabled', 'adaptive'].includes(body.thinking.type) ||
      (body.thinking.budget_tokens !== undefined &&
        (!Number.isSafeInteger(body.thinking.budget_tokens) || body.thinking.budget_tokens < 0)))
  ) {
    throw new Error('Grok requires a valid thinking configuration');
  }
  if (body.stop_sequences?.length) {
    throw new Error('Grok CLI does not support Messages stop sequences');
  }
}
