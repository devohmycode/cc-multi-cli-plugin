import http from 'node:http';
import { originalToolNames } from './native-tools.ts';
import { estimateInputTokens } from './native-tokens.ts';
import type { Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { toResponses, fromResponses, forAnthropic } from './native-responses.ts';
import type { Effort, MessagesRequest, StopReason, StreamEventBody, StreamEventName } from './native-responses.ts';

export const MODELS = {
  'openai-native': 'gpt-6-astra',
  'openai-sol': 'gpt-5.6-sol',
  'openai-terra': 'gpt-5.6-terra',
  'openai-luna': 'gpt-5.6-luna'
};

/** A registered native worker: the OpenAI model it runs on and its reasoning effort. */
export interface Worker {
  model: string;
  effort: Effort;
}

export const OPENAI_WORKERS: Readonly<Record<string, Worker>> = Object.freeze(Object.fromEntries(Object.entries(MODELS).flatMap(([name, model]) =>
  (['', 'low', 'medium', 'high', 'xhigh', 'max'] as const).map(level =>
    [level ? `${name}-${level}` : name, { model, effort: level || 'medium' }]))));
const OPENAI_URL = 'https://chatgpt.com/backend-api/codex/responses';
const ANTHROPIC_URL = 'https://api.anthropic.com';
const MAX_BODY = 8 * 1024 * 1024;
const STRIPPED_REQUEST_HEADERS = ['host', 'connection', 'content-length', 'transfer-encoding', 'x-multi-gateway-token', 'accept-encoding'];
const STRIPPED_RESPONSE_HEADERS = ['content-encoding', 'content-length', 'transfer-encoding', 'connection'];

/** Codex's saved ChatGPT login, forwarded as OpenAI request headers. */
export interface CodexAuthHeaders {
  authorization: string;
  'chatgpt-account-id': string;
}

/** What the gateway reports to `onEvent`; routing only, never credentials or bodies. */
export interface GatewayEvent {
  route: 'anthropic' | 'openai' | 'openai-request';
  model?: string;
  agentId?: string | null;
  path?: string;
  effort?: Effort;
  status?: number;
  stopReason?: StopReason | null;
  tools?: string[];
}

export interface GatewayFetchInit {
  method: string;
  headers: Record<string, string>;
  body?: Buffer | string;
  signal: AbortSignal;
  redirect: 'error';
}

export type GatewayFetch = (url: string, init: GatewayFetchInit) => Promise<Response>;

export interface GatewayOptions {
  token: string;
  authFile: string;
  fetchImpl?: GatewayFetch;
  onEvent?: (event: GatewayEvent) => void;
  timeoutMs?: number;
}

/** Rejected before any provider call; answered as HTTP 400 rather than 502. */
class BadRequest extends Error {}
class UpstreamFailure extends Error {
  status: number;
  retryAfter: string | null;
  constructor(status: number, retryAfter: string | null) {
    super(`OpenAI returned HTTP ${status}.${status === 401 ? ' Renew the Codex login.' : ''}`);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function readCodexAuth(authFile: string): Promise<CodexAuthHeaders> {
  let auth: unknown;
  try { auth = JSON.parse(await readFile(authFile, 'utf8')); }
  catch { throw new Error('Cannot read Codex auth.json. Sign in with codex login first.'); }
  const tokens = isRecord(auth) && isRecord(auth.tokens) ? auth.tokens : undefined;
  if (!isRecord(auth) || auth.auth_mode !== 'chatgpt'
      || typeof tokens?.access_token !== 'string' || !tokens.access_token
      || typeof tokens.account_id !== 'string' || !tokens.account_id) {
    throw new Error('Native OpenAI workers require a Codex ChatGPT login in auth.json.');
  }
  // Codex owns refresh and persistence. Reload its file on every request.
  return { authorization: `Bearer ${tokens.access_token}`, 'chatgpt-account-id': tokens.account_id };
}

function authenticated(actual: string | string[] | undefined, expected: string): boolean {
  const a = Buffer.from(String(actual ?? ''));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(', ') : value;
}

export function createNativeGateway({ token, authFile, fetchImpl = fetch, onEvent = () => {}, timeoutMs = 180000 }: GatewayOptions): Server {
  if (!token) throw new Error('Gateway token required');
  const fallbackSession = randomUUID();
  return http.createServer(async (req, res) => {
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(timeoutMs)]);
    let heartbeat: NodeJS.Timeout | undefined;
    const emit = (type: StreamEventName, value: StreamEventBody) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
    try {
      if (req.headers.origin || !authenticated(req.headers['x-multi-gateway-token'], token)) {
        res.writeHead(403); return res.end('Forbidden');
      }
      const url = new URL(req.url ?? '', 'http://localhost');
      if (!['/v1/messages', '/v1/messages/count_tokens', '/v1/models', '/api/hello'].includes(url.pathname)
          || !['POST', 'GET', 'HEAD'].includes(req.method ?? '')) {
        res.writeHead(404); return res.end('Not found');
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) { res.writeHead(413); res.end('Request too large'); return; }
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks);
      let parsed: unknown;
      try { parsed = raw.length ? JSON.parse(raw.toString('utf8')) : {}; }
      catch { throw new BadRequest('Invalid JSON'); }
      if (!isRecord(parsed) || (parsed.model !== undefined && typeof parsed.model !== 'string')) throw new BadRequest('Expected an object with a string model');
      const body: MessagesRequest = parsed;
      const external = typeof body.model === 'string' && body.model.startsWith('multi/') ? body.model : null;
      const agentId = header(req.headers['x-claude-code-agent-id']);
      onEvent({ route: external ? 'openai' : 'anthropic', model: body.model, agentId: agentId ?? null, path: url.pathname });
      if (external) {
        let request;
        try {
          const model = Object.values(MODELS).find(model => external === `multi/openai/${model}`);
          if (!model) throw new Error('Unknown native OpenAI model');
          if (!['/v1/messages', '/v1/messages/count_tokens'].includes(url.pathname) || req.method !== 'POST') throw new Error('External models require POST /v1/messages or /v1/messages/count_tokens');
          request = toResponses(body, model);
        } catch (error) { throw new BadRequest(reason(error)); }
        if (url.pathname === '/v1/messages/count_tokens') {
          res.writeHead(200, { 'content-type': 'application/json', 'x-multi-token-count': 'estimate' });
          return res.end(JSON.stringify({ input_tokens: estimateInputTokens(request) }));
        }
        const toolNames = originalToolNames(body);
        onEvent({ route: 'openai-request', agentId, model: request.model, effort: request.reasoning.effort });
        const headers = { ...await readCodexAuth(authFile), 'content-type': 'application/json', accept: 'text/event-stream',
          originator: 'cc_multi_native', 'session_id': String(agentId ?? header(req.headers['x-claude-code-session-id']) ?? fallbackSession) };
        const upstream = await fetchImpl(OPENAI_URL, { method: 'POST', headers, body: JSON.stringify(request), signal, redirect: 'error' });
        if (!upstream.ok) {
          // Do not print upstream bodies or credentials in gateway diagnostics.
          onEvent({ route: 'openai', status: upstream.status });
          await upstream.body?.cancel();
          throw new UpstreamFailure(upstream.status, upstream.headers.get('retry-after'));
        }
        if (!upstream.body) throw new Error('OpenAI returned no response stream.');
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          res.flushHeaders();
          heartbeat = setInterval(() => emit('ping', {}), 15000);
        }
        const result = await fromResponses(upstream.body, external, body.stream ? emit : undefined, { toolNames, stopSequences: body.stop_sequences });
        if (result.stop_reason === 'stop_sequence') abort.abort();
        onEvent({ route: 'openai', agentId, stopReason: result.stop_reason,
          tools: result.content.filter(b => b.type === 'tool_use').map(b => b.name) });
        if (!body.stream) res.writeHead(200, { 'content-type': 'application/json' });
        res.end(body.stream ? undefined : JSON.stringify(result));
      } else {
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(req.headers)) {
          const single = header(value);
          if (single !== undefined && !STRIPPED_REQUEST_HEADERS.includes(name)) headers[name] = single;
        }
        headers['accept-encoding'] = 'identity';
        const cleaned = forAnthropic(body);
        const upstream = await fetchImpl(ANTHROPIC_URL + url.pathname + url.search, {
          method: req.method ?? 'GET', headers, body: req.method === 'POST' ? (cleaned === body ? raw : Buffer.from(JSON.stringify(cleaned))) : undefined, signal, redirect: 'error'
        });
        onEvent({ route: 'anthropic', status: upstream.status, model: body.model });
        const responseHeaders = Object.fromEntries(upstream.headers);
        for (const name of STRIPPED_RESPONSE_HEADERS) delete responseHeaders[name];
        res.writeHead(upstream.status, responseHeaders);
        if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), res);
        else res.end();
      }
    } catch (error) {
      abort.abort();
      if (res.destroyed) return;
      const status = error instanceof BadRequest ? 400 : error instanceof UpstreamFailure ? error.status : 502;
      const errorTypes: Record<number, string> = { 400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error', 404: 'not_found_error', 429: 'rate_limit_error', 503: 'overloaded_error' };
      const failure = { type: 'error', error: { type: errorTypes[status] ?? 'api_error', message: `Native gateway: ${reason(error)}` } };
      if (error instanceof UpstreamFailure && error.retryAfter && !res.headersSent) res.setHeader('retry-after', error.retryAfter);
      if (res.headersSent) { emit('error', { error: failure.error }); res.end(); }
      else { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(failure)); }
    } finally { clearInterval(heartbeat); }
  });
}
