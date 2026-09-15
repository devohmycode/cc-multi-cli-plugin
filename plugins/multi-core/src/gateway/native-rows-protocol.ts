import { stripVTControlCharacters } from 'node:util';
import type { MessagesResponse } from './messages.ts';

const labels = {
  read: 'Read',
  search: 'Grep',
  edit: 'Edit',
  shell: 'Bash',
  other: 'Action',
  note: 'Message',
};
export type NativeRowKind = keyof typeof labels;
export type NativeObservation =
  | { type: 'text'; text: string }
  | { type: 'started'; id: string; kind: NativeRowKind; description: string }
  | { type: 'completed'; id: string; text: string; error: boolean };
export type NativeRowObserver = (event: NativeObservation) => void;
export const nativeRowTools = Object.entries(labels).map(([name, title]) => ({
  name,
  description:
    'Display only: observes native Cursor activity. Performs no filesystem, shell, or native harness action.',
  inputSchema: {
    type: 'object',
    properties: { description: { type: 'string' } },
    required: ['description'],
    additionalProperties: false,
  },
  _meta: { 'anthropic/alwaysLoad': true },
  annotations: {
    title,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}));
export const nativeRowNames = nativeRowTools.map((tool) => `mcp__multi_cursor__${tool.name}`);
export function isNativeRowTool(name: string) {
  return nativeRowNames.includes(name);
}
export function nativeRowExchange(id: string | undefined) {
  return /^toolu_multi_cursor_([a-f0-9]{32})_\d+$/.exec(id ?? '')?.[1];
}
export function rowText(text: string, limit = 160) {
  return stripVTControlCharacters(text)
    .replaceAll(/[\p{Cc}\p{Cf}]/gu, (character) => (character === '\n' ? '\n' : ''))
    .replaceAll(/\b(?:sk-|Bearer\s+)[A-Za-z0-9_./+-]{12,}/gi, '[redacted]')
    .slice(0, limit);
}
export interface NativeRow {
  id: string;
  name: string;
  input: { description: string };
  result?: { text: string; error: boolean };
}
export interface NativeRowRecord {
  version: 1;
  id: string;
  scope: string;
  model: string;
  rows: NativeRow[];
  original?: MessagesResponse;
  final?: MessagesResponse;
}
