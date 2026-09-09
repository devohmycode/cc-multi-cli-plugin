import { createHash } from 'node:crypto';
import type { MessagesRequest } from './messages.ts';

// Reserve our alias prefix too, so a real short name cannot shadow a long name.
// Deterministic aliases survive resume/compaction without a process-global cache.
function wireIdentifier(value: string, prefix: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Expected a nonempty tool identifier');
  }
  if (/^[a-zA-Z0-9_-]{1,64}$/.test(value) && !value.startsWith(prefix)) {
    return value;
  }
  return prefix + createHash('sha256').update(value).digest('hex').slice(0, 48);
}
export const toolName = (value: string): string => wireIdentifier(value, 'multi_tool_');
export const callId = (value: string): string => wireIdentifier(value, 'multi_call_');

export function originalToolNames(body: MessagesRequest): Map<string, string> {
  const names = new Map<string, string>();
  const add = (name: string) => {
    const alias = toolName(name);
    if (names.has(alias) && names.get(alias) !== name) {
      throw new Error('Tool alias collision');
    }
    names.set(alias, name);
  };
  for (const tool of body.tools ?? []) {
    if (tool.name) {
      add(tool.name);
    }
  }
  return names;
}
