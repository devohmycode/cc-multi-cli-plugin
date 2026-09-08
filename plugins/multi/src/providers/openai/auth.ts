import { readFile } from 'node:fs/promises';

/** Codex's saved ChatGPT login, forwarded as OpenAI request headers. */
export interface CodexAuthHeaders {
  authorization: string;
  'chatgpt-account-id': string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function readCodexAuth(authFile: string): Promise<CodexAuthHeaders> {
  let auth: unknown;
  try {
    auth = JSON.parse(await readFile(authFile, 'utf8'));
  } catch {
    throw new Error('Cannot read Codex auth.json. Sign in with codex login first.');
  }
  const tokens = isRecord(auth) && isRecord(auth.tokens) ? auth.tokens : undefined;
  if (
    !isRecord(auth) ||
    auth.auth_mode !== 'chatgpt' ||
    typeof tokens?.access_token !== 'string' ||
    !tokens.access_token ||
    typeof tokens.account_id !== 'string' ||
    !tokens.account_id
  ) {
    throw new Error('Native OpenAI workers require a Codex ChatGPT login in auth.json.');
  }
  // Codex owns refresh and persistence. Reload its file on every request.
  return {
    authorization: `Bearer ${tokens.access_token}`,
    'chatgpt-account-id': tokens.account_id,
  };
}
