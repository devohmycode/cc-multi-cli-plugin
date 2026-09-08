import type { InteractionUpdate } from '@cursor/sdk';

type ToolCall = Extract<InteractionUpdate, { type: 'tool-call-started' }>['toolCall'];
const escapeCharacter = String.fromCharCode(27);
const bell = String.fromCharCode(7);
const terminalSequence = new RegExp(
  `${escapeCharacter}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${escapeCharacter}${bell}]*(?:${bell}|${escapeCharacter}\\\\))`,
  'g',
);

function oneLine(value: string) {
  return value
    .replaceAll(terminalSequence, '')
    .replaceAll(/[\p{Cc}]/gu, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function toolSummary(toolCall: ToolCall) {
  if (toolCall.type === 'shell') {
    return `Shell: ${oneLine(toolCall.args.command)}`;
  }
  if ('path' in toolCall.args && typeof toolCall.args.path === 'string') {
    return `${toolCall.type}: ${oneLine(toolCall.args.path)}`;
  }
  if (toolCall.type === 'mcp' && toolCall.args.toolName) {
    return `MCP: ${oneLine(toolCall.args.toolName)}`;
  }
  return toolCall.type;
}

// Keep previews small in Claude's transcript; SDK results remain the full record.
function preview(value: string, language: string, label = '') {
  const clean = value
    .replaceAll(terminalSequence, '')
    .replaceAll(/[^\S\n]/gu, ' ')
    .replaceAll(/[\p{Cc}\p{Cf}]/gu, (character) => (character === '\n' ? '\n' : ''))
    .trim();
  if (!clean) {
    return '';
  }
  const bounded = clean.split('\n').slice(0, 12).join('\n').slice(0, 1200);
  // A longer fence prevents output containing Markdown fences from escaping.
  const runs = bounded.match(/`+/g) ?? [];
  const fence = '`'.repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
  const suffix = bounded.length < clean.length ? '\n… (truncated)' : '';
  return `${label ? `\n${label}:` : ''}\n${fence}${language}\n${bounded}${suffix}\n${fence}`;
}

function successDetails(toolCall: ToolCall) {
  if (toolCall.result?.status !== 'success') {
    return '';
  }
  if (toolCall.type === 'shell') {
    const { executionTime, stdout, stderr } = toolCall.result.value;
    const elapsed =
      Number.isFinite(executionTime) && executionTime >= 0
        ? ` (${Math.round(executionTime)} ms)`
        : '';
    return `${elapsed}${preview(stdout, 'text', 'stdout')}${preview(stderr, 'text', 'stderr')}`;
  }
  if (toolCall.type === 'edit') {
    const { linesAdded, linesRemoved, diffString } = toolCall.result.value;
    const counts = [
      typeof linesAdded === 'number' ? `+${linesAdded}` : '',
      typeof linesRemoved === 'number' ? `-${linesRemoved}` : '',
    ]
      .filter(Boolean)
      .join(' ');
    return `${counts ? ` (${counts} lines)` : ''}${preview(diffString ?? '', 'diff')}`;
  }
  return '';
}

function completion(toolCall: ToolCall) {
  if (!toolCall.result) {
    return `[Cursor] ${toolSummary(toolCall)} completed.`;
  }
  if (toolCall.result.status === 'success') {
    if (toolCall.type === 'shell') {
      return `[Cursor] Shell completed (exit ${toolCall.result.value.exitCode}).${successDetails(toolCall)}`;
    }
    return `[Cursor] ${toolSummary(toolCall)} completed.${successDetails(toolCall)}`;
  }
  const error = typeof toolCall.result.error === 'string' ? toolCall.result.error : '';
  if (/denied|blocked|rejected/i.test(error)) {
    return `[Cursor] ${toolSummary(toolCall)} was denied.`;
  }
  return `[Cursor] ${toolSummary(toolCall)} failed.`;
}

/** Formats public SDK progress only; it never creates executable Claude tool calls. */
export function formatCursorProgress(update: InteractionUpdate): string | undefined {
  switch (update.type) {
    case 'tool-call-started':
      return `[Cursor] ${toolSummary(update.toolCall)} started.`;
    case 'tool-call-completed':
      return completion(update.toolCall);
    case 'summary-started':
      return '[Cursor] Compacting context…';
    case 'summary-completed':
      return '[Cursor] Context compacted.';
    default:
      return undefined;
  }
}
