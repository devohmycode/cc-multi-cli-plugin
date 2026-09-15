import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MessagesResponse } from './messages.ts';
import {
  isNativeRowTool,
  type NativeRowRecord,
  nativeRowExchange,
} from './native-rows-protocol.ts';

export function rowDigest(value: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(value) ?? 'undefined')
    .digest('hex');
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function response(value: unknown): value is MessagesResponse {
  return (
    object(value) &&
    typeof value.id === 'string' &&
    value.type === 'message' &&
    value.role === 'assistant' &&
    typeof value.model === 'string' &&
    value.stop_reason === 'end_turn' &&
    value.stop_sequence === null &&
    Array.isArray(value.content) &&
    value.content.every(
      (block) => object(block) && block.type === 'text' && typeof block.text === 'string',
    ) &&
    object(value.usage) &&
    typeof value.usage.input_tokens === 'number' &&
    typeof value.usage.output_tokens === 'number'
  );
}
function validRow(value: unknown) {
  if (
    !object(value) ||
    typeof value.id !== 'string' ||
    !nativeRowExchange(value.id) ||
    typeof value.name !== 'string' ||
    !isNativeRowTool(value.name) ||
    !object(value.input) ||
    typeof value.input.description !== 'string'
  ) {
    return false;
  }
  return (
    value.result === undefined ||
    (object(value.result) &&
      typeof value.result.text === 'string' &&
      typeof value.result.error === 'boolean')
  );
}
function record(value: unknown): value is NativeRowRecord {
  return (
    object(value) &&
    value.version === 1 &&
    typeof value.id === 'string' &&
    /^[a-f0-9]{32}$/.test(value.id) &&
    typeof value.scope === 'string' &&
    typeof value.model === 'string' &&
    Array.isArray(value.rows) &&
    value.rows.length <= 2048 &&
    value.rows.every(validRow) &&
    (value.original === undefined || response(value.original)) &&
    (value.final === undefined || response(value.final))
  );
}
export class NativeRowsStore {
  readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
  }
  async prepare() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
  }
  file(scope: string, id: string) {
    return path.join(this.directory, `${rowDigest(scope)}-${id}.json`);
  }
  async load(scope: string, id: string) {
    const value = await readJson(this.file(scope, id));
    if (value === undefined) {
      return undefined;
    }
    if (
      !record(value) ||
      value.scope !== scope ||
      value.id !== id ||
      value.rows.some((row) => nativeRowExchange(row.id) !== id)
    ) {
      throw new Error('Invalid native display record');
    }
    return value;
  }
  async save(value: NativeRowRecord) {
    await this.write(this.file(value.scope, value.id), value);
  }
  async index(key: string): Promise<string | undefined> {
    const value = await readJson(path.join(this.directory, `${key}.index`));
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) {
      throw new Error('Invalid native display index');
    }
    return value;
  }
  async locate(id: string) {
    const scope = await readJson(path.join(this.directory, `${id}.scope`));
    return typeof scope === 'string' ? this.load(scope, id) : undefined;
  }
  async rememberScope(id: string, scope: string) {
    await this.write(path.join(this.directory, `${id}.scope`), scope);
  }
  async remember(key: string, id: string) {
    await this.write(path.join(this.directory, `${key}.index`), id);
  }
  private async write(file: string, value: unknown) {
    const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, file);
  }
}
async function readJson(file: string): Promise<unknown> {
  try {
    const text = await readFile(file, 'utf8');
    if (text.length > 40 * 1024 * 1024) {
      throw new Error('Native display record too large');
    }
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}
