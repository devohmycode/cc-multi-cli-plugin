import { spawn } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

/** Codex's saved ChatGPT login, forwarded as OpenAI request headers. */
export interface CodexAuthHeaders {
  authorization: string;
  'chatgpt-account-id': string;
}

export class CodexAuthError extends Error {}

const refreshing = new Map<string, Promise<void>>();
const renewalFailure = () =>
  new CodexAuthError('Codex could not renew the ChatGPT login. Run codex login and retry.');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function savedAuth(authFile: string) {
  let auth: unknown;
  try {
    auth = JSON.parse(await readFile(authFile, 'utf8'));
  } catch {
    throw new CodexAuthError('Cannot read Codex auth.json. Sign in with codex login first.');
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
    throw new CodexAuthError('Native OpenAI workers require a Codex ChatGPT login in auth.json.');
  }
  return {
    headers: {
      authorization: `Bearer ${tokens.access_token}`,
      'chatgpt-account-id': tokens.account_id,
    },
    canRefresh: typeof tokens.refresh_token === 'string' && tokens.refresh_token.length > 0,
    expires: tokenExpiry(tokens.access_token),
  };
}

// The JWT expiry is only a refresh hint, never proof of authentication.
function tokenExpiry(token: string): number {
  try {
    const payload: unknown = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    return isRecord(payload) && typeof payload.exp === 'number' ? payload.exp * 1000 : Infinity;
  } catch {
    return Infinity;
  }
}

export async function readCodexAuth(authFile: string): Promise<CodexAuthHeaders> {
  const saved = await savedAuth(authFile);
  if (saved.canRefresh && saved.expires <= Date.now() + 60000) {
    return renewAuth(authFile, saved.headers);
  }
  return saved.headers;
}

/** Retry only an HTTP authentication rejection, never an accepted inference stream. */
export async function codexRequest(
  authFile: string,
  signal: AbortSignal,
  send: (headers: CodexAuthHeaders) => Promise<Response>,
): Promise<Response> {
  signal.throwIfAborted();
  const headers = await waitForAuth(readCodexAuth(authFile), signal);
  signal.throwIfAborted();
  const response = await send(headers);
  if (response.status !== 401) {
    return response;
  }
  await response.body?.cancel();
  if (!(await savedAuth(authFile)).canRefresh) {
    return response;
  }
  const renewed = await waitForAuth(renewAuth(authFile, headers), signal);
  signal.throwIfAborted();
  return send(renewed);
}

async function waitForAuth(pending: Promise<CodexAuthHeaders>, signal: AbortSignal) {
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function renewAuth(authFile: string, rejected: CodexAuthHeaders): Promise<CodexAuthHeaders> {
  const filename = await realpath(authFile);
  let pending = refreshing.get(filename);
  if (!pending) {
    pending = refreshIfUnchanged(filename, rejected).finally(() => refreshing.delete(filename));
    refreshing.set(filename, pending);
  }
  await pending;
  const renewed = (await savedAuth(filename)).headers;
  if (renewed['chatgpt-account-id'] !== rejected['chatgpt-account-id']) {
    throw new CodexAuthError(
      'Codex account changed during renewal. Retry in the intended account.',
    );
  }
  if (renewed.authorization === rejected.authorization) {
    throw renewalFailure();
  }
  return renewed;
}

async function refreshIfUnchanged(authFile: string, rejected: CodexAuthHeaders) {
  // Another worker or Codex process may already have renewed the shared file.
  if ((await savedAuth(authFile)).headers.authorization !== rejected.authorization) {
    return;
  }
  if (path.basename(authFile) !== 'auth.json') {
    throw renewalFailure();
  }
  const child = spawn('codex', ['app-server', '-c', 'cli_auth_credentials_store="file"'], {
    env: { ...process.env, CODEX_HOME: path.dirname(authFile) },
    stdio: ['pipe', 'pipe', 'ignore'],
    timeout: 30000,
    killSignal: 'SIGKILL',
    windowsHide: true,
  });
  const lines = createInterface({ input: child.stdout });
  child.on('error', () => lines.close());
  child.stdin.on('error', () => lines.close());
  let bytes = 0;
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) {
      child.kill('SIGKILL');
      lines.close();
    }
  });
  const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
  send({
    id: 1,
    method: 'initialize',
    params: { clientInfo: { name: 'cc_multi_native', version: '0.1.0' } },
  });
  try {
    await refreshAccount(lines, send);
  } catch {
    // RPC errors and stderr may contain account information; never expose them.
    throw renewalFailure();
  } finally {
    lines.close();
    child.stdin.destroy();
    child.kill('SIGKILL');
  }
}

async function refreshAccount(lines: AsyncIterable<string>, send: (value: unknown) => unknown) {
  for await (const line of lines) {
    const message: unknown = JSON.parse(line);
    if (!isRecord(message) || message.error) {
      throw renewalFailure();
    }
    if (message.id === 1 && isRecord(message.result)) {
      send({ method: 'initialized' });
      send({ id: 2, method: 'account/read', params: { refreshToken: true } });
    }
    if (message.id === 2) {
      const account = isRecord(message.result) && message.result.account;
      if (!isRecord(account) || account.type !== 'chatgpt') {
        throw renewalFailure();
      }
      return;
    }
  }
  throw renewalFailure();
}
