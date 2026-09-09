import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export class ZenAuthError extends Error {}

export function validateZenKey(value: string): string {
  if (!/^[\x21-\x7e]+$/.test(value)) {
    throw new ZenAuthError('Invalid OpenCode Zen API key.');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function authFile(): string {
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(dataHome, 'opencode', 'auth.json');
}

/** Read only the OpenCode Zen API key; credentials stay owned by OpenCode. */
export async function readZenKey(): Promise<string | undefined> {
  const configured = process.env.OPENCODE_API_KEY;
  if (configured !== undefined) {
    return validateZenKey(configured);
  }

  let source: string;
  try {
    source = await readFile(authFile(), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw new ZenAuthError('Cannot read OpenCode auth.json.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new ZenAuthError('OpenCode auth.json is invalid.');
  }
  if (!isRecord(parsed) || parsed.opencode === undefined) {
    return undefined;
  }
  const entry = parsed.opencode;
  if (
    !isRecord(entry) ||
    entry.type !== 'api' ||
    typeof entry.key !== 'string' ||
    !entry.key.trim()
  ) {
    throw new ZenAuthError('OpenCode auth.json has invalid Zen API credentials.');
  }
  return validateZenKey(entry.key);
}
