import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { toResponses, fromResponses, forAnthropic } from './native-responses.mjs';

export const MODELS = {
  'openai-native': 'gpt-6-astra',
  'openai-sol': 'gpt-5.6-sol',
  'openai-terra': 'gpt-5.6-terra',
  'openai-luna': 'gpt-5.6-luna'
};
export const OPENAI_WORKERS = Object.freeze(Object.fromEntries(Object.entries(MODELS).flatMap(([name, model]) =>
  ['', 'low', 'medium', 'high', 'xhigh', 'max'].map(level =>
    [level ? `${name}-${level}` : name, { model, effort: level || 'medium' }]))));
const OPENAI_URL = 'https://chatgpt.com/backend-api/codex/responses';
const ANTHROPIC_URL = 'https://api.anthropic.com';
const MAX_BODY = 8 * 1024 * 1024;

export async function readCodexAuth(authFile) {
  let auth;
  try { auth = JSON.parse(await readFile(authFile, 'utf8')); }
  catch { throw new Error('Cannot read Codex auth.json. Sign in with codex login first.'); }
  if (auth.auth_mode !== 'chatgpt' || !auth.tokens?.access_token || !auth.tokens?.account_id) {
    throw new Error('Native OpenAI workers require a Codex ChatGPT login in auth.json.');
  }
  // Codex owns refresh and persistence. Reload its file on every request.
  return { authorization: `Bearer ${auth.tokens.access_token}`, 'chatgpt-account-id': auth.tokens.account_id };
}

function authenticated(actual, expected) {
  const a = Buffer.from(String(actual ?? ''));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createNativeGateway({ token, authFile, fetchImpl = fetch, onEvent = () => {}, timeoutMs = 180000 }) {
  if (!token) throw new Error('Gateway token required');
  const fallbackSession = randomUUID();
  return http.createServer(async (req, res) => {
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(timeoutMs)]);
    let heartbeat;
    const emit = (type, value) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
    try {
      if (req.headers.origin || !authenticated(req.headers['x-multi-gateway-token'], token)) {
        res.writeHead(403); return res.end('Forbidden');
      }
      const url = new URL(req.url, 'http://localhost');
      if (!['/v1/messages', '/v1/messages/count_tokens', '/v1/models', '/api/hello'].includes(url.pathname)
          || !['POST', 'GET', 'HEAD'].includes(req.method)) {
        res.writeHead(404); return res.end('Not found');
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) { res.writeHead(413); res.end('Request too large'); return; }
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks);
      let body;
      try { body = raw.length ? JSON.parse(raw) : {}; }
      catch { res.writeHead(400); return res.end('Invalid JSON'); }
      const external = typeof body.model === 'string' && body.model.startsWith('multi/');
      const agentId = req.headers['x-claude-code-agent-id'];
      onEvent({ route: external ? 'openai' : 'anthropic', model: body.model, agentId: agentId ?? null, path: url.pathname });
      if (external) {
        let request;
        try {
          const model = Object.values(MODELS).find(model => body.model === `multi/openai/${model}`);
          if (!model) throw new Error('Unknown native OpenAI model');
          if (url.pathname !== '/v1/messages') throw new Error('Token counting is not supported for native OpenAI workers');
          request = toResponses(body, model);
        } catch (error) { error.statusCode = 400; throw error; }
        onEvent({ route: 'openai-request', agentId, model: request.model, effort: request.reasoning.effort });
        const headers = { ...await readCodexAuth(authFile), 'content-type': 'application/json', accept: 'text/event-stream',
          originator: 'cc_multi_native', 'session_id': String(agentId ?? req.headers['x-claude-code-session-id'] ?? fallbackSession) };
        const upstream = await fetchImpl(OPENAI_URL, { method: 'POST', headers, body: JSON.stringify(request), signal, redirect: 'error' });
        if (!upstream.ok) {
          // Do not print upstream bodies or credentials in gateway diagnostics.
          onEvent({ route: 'openai', status: upstream.status });
          await upstream.body?.cancel();
          throw new Error(`OpenAI returned HTTP ${upstream.status}.${upstream.status === 401 ? ' Renew the Codex login.' : ''}`);
        }
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          res.flushHeaders();
          heartbeat = setInterval(() => emit('ping', {}), 15000);
        }
        const result = await fromResponses(upstream.body, body.model, body.stream ? emit : undefined);
        onEvent({ route: 'openai', agentId, stopReason: result.stop_reason,
          tools: result.content.filter(b => b.type === 'tool_use').map(b => b.name) });
        if (!body.stream) res.writeHead(200, { 'content-type': 'application/json' });
        res.end(body.stream ? undefined : JSON.stringify(result));
      } else {
        const headers = { ...req.headers };
        for (const name of ['host', 'connection', 'content-length', 'transfer-encoding', 'x-multi-gateway-token', 'accept-encoding']) delete headers[name];
        headers['accept-encoding'] = 'identity';
        const cleaned = forAnthropic(body);
        const upstream = await fetchImpl(ANTHROPIC_URL + url.pathname + url.search, {
          method: req.method, headers, body: req.method === 'POST' ? (cleaned === body ? raw : Buffer.from(JSON.stringify(cleaned))) : undefined, signal, redirect: 'error'
        });
        onEvent({ route: 'anthropic', status: upstream.status, model: body.model });
        const responseHeaders = Object.fromEntries(upstream.headers);
        for (const name of ['content-encoding', 'content-length', 'transfer-encoding', 'connection']) delete responseHeaders[name];
        res.writeHead(upstream.status, responseHeaders);
        if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), res);
        else res.end();
      }
    } catch (error) {
      abort.abort();
      if (res.destroyed) return;
      const failure = { type: 'error', error: { type: 'api_error', message: `Native gateway: ${error.message}` } };
      if (res.headersSent) { emit('error', { error: failure.error }); res.end(); }
      else { res.writeHead(error.statusCode ?? 502, { 'content-type': 'application/json' }); res.end(JSON.stringify(failure)); }
    } finally { clearInterval(heartbeat); }
  });
}
