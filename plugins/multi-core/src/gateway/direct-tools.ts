import type { MessagesRequest } from './messages.ts';

/** Keep deferred schemas out of provider requests until Claude has discovered or used them. */
export function isDirectToolAvailable(body: MessagesRequest, name: string): boolean {
  if (body.tool_choice?.type === 'tool' && body.tool_choice.name === name) {
    return true;
  }
  for (const message of body.messages ?? []) {
    if (!Array.isArray(message.content)) {
      continue;
    }
    for (const block of message.content) {
      if (blockHasToolName(block, name)) {
        return true;
      }
    }
  }
  return false;
}

function blockHasToolName(
  block: { type: string; name?: string; tool_name?: string; content?: unknown },
  name: string,
): boolean {
  if (
    (block.type === 'tool_reference' && block.tool_name === name) ||
    (block.type === 'tool_use' && block.name === name)
  ) {
    return true;
  }
  if (!Array.isArray(block.content)) {
    return false;
  }
  return block.content.some(
    (child) =>
      typeof child === 'object' &&
      child !== null &&
      !Array.isArray(child) &&
      blockHasToolName(
        child as { type: string; name?: string; tool_name?: string; content?: unknown },
        name,
      ),
  );
}
