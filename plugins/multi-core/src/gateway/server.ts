import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Server } from 'node:http';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  type AntigravityHarness,
  AntigravityProviderError,
} from '../../../multi-antigravity/src/harness.ts';
import { CursorProviderError } from '../../../multi-cursor/src/errors.ts';
import type { CursorHarness } from '../../../multi-cursor/src/harness.ts';
import { CodexAuthError, codexRequest } from '../../../multi-openai/src/auth.ts';
import { openaiInstructions } from '../../../multi-openai/src/instructions.ts';
import { MODELS } from '../../../multi-openai/src/models.ts';
import type { Effort, ResponsesRequest } from '../../../multi-openai/src/responses.ts';
import { forAnthropic, fromResponses, toResponses } from '../../../multi-openai/src/responses.ts';
import { validateZenKey } from '../../../multi-zen/src/auth.ts';
import { fromChat } from '../../../multi-zen/src/chat.ts';
import { zenRequest } from '../../../multi-zen/src/request.ts';
import type { AgentCatalog } from './agent-catalog.ts';
import type { ApprovalContext, NativeApprovalBridge } from './approval.ts';
import { isApprovalRequest, parseApprovalRequest } from './approval.ts';
import type { GatewayFetch } from './fetch.ts';
import type { Emit, MessagesRequest, MessagesResponse, StopReason } from './messages.ts';
import type { PermissionContext, PermissionModes } from './mode-hook.ts';
import { emitRowResponse, type NativeRows } from './native-rows.ts';
import { isNativeRowTool } from './native-rows-protocol.ts';
import type { PendingApprovalTool } from './permission-hook.ts';
import { approvalCapabilityGuard } from './permission-hook.ts';
import { estimateInputTokens } from './tokens.ts';
import { forwardObservedTools, ToolObserver } from './tool-observer.ts';
import { originalToolNames } from './tools.ts';

const OPENAI_URL = 'https://chatgpt.com/backend-api/codex/responses';
const ANTHROPIC_URL = 'https://api.anthropic.com';
const MAX_BODY = 8 * 1024 * 1024;
const STRIPPED_REQUEST_HEADERS = [
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'x-multi-gateway-token',
  'accept-encoding',
];
const STRIPPED_RESPONSE_HEADERS = [
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
];

/** What the gateway reports to `onEvent`; routing only, never credentials or bodies. */
export interface GatewayEvent {
  route:
    | 'anthropic'
    | 'openai'
    | 'openai-request'
    | 'cursor'
    | 'antigravity'
    | 'approval'
    | 'zen'
    | 'zen-request';
  model?: string;
  agentId?: string | null;
  path?: string;
  effort?: Effort;
  status?: number;
  stopReason?: StopReason | null;
  tools?: string[];
  stage?: 1 | 2;
  outcome?: 'allow' | 'deny';
  cached?: boolean;
  permissionContext?: PermissionContext;
  usage?: MessagesResponse['usage'];
}

export interface GatewayOptions {
  token: string;
  nativeRows?: NativeRows;
  enabledProviders?: readonly string[];
  authFile: string;
  fetchImpl?: GatewayFetch;
  onEvent?: (event: GatewayEvent) => void;
  timeoutMs?: number;
  cursor?: Pick<CursorHarness, 'validate' | 'handle'>;
  antigravity?: Pick<AntigravityHarness, 'validate' | 'handle'>;
  zen?: { apiKey: string };
  /** OpenAI review for GPT-originated actions, independent of Claude authentication. */
  approvalBridge?: Pick<NativeApprovalBridge, 'respond'>;
  approvalProviders?: readonly ('openai' | 'cursor')[];
  /** No Anthropic credentials: also block passthrough if no reviewer is available. */
  blockAnthropic?: boolean;
  guardAuto?: boolean;
  permissionModes?: PermissionModes;
  agentCatalog?: AgentCatalog;
}

/** Rejected before any provider call; answered as HTTP 400 rather than 502. */
class BadRequest extends Error {}
class UpstreamFailure extends Error {
  status: number;
  retryAfter: string | null;
  constructor(status: number, retryAfter: string | null, provider = 'OpenAI') {
    const authHelp = provider === 'OpenAI' ? ' Renew the Codex login.' : ' Check the Zen API key.';
    super(`${provider} returned HTTP ${status}.${status === 401 ? authHelp : ''}`);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function authenticated(actual: string | string[] | undefined, expected: string): boolean {
  const a = Buffer.from(String(actual ?? ''));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(', ') : value;
}

interface ProviderRequest {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  body: MessagesRequest;
  parsed: Record<string, unknown>;
  raw: Buffer;
  url: URL;
  signal: AbortSignal;
  abort: AbortController;
  agentId?: string;
  identity: ReturnType<typeof requestIdentity>;
  permissionContext?: PermissionContext;
  emit: Emit;
  remember: (tool: { id: string; name: string; input: unknown }) => void;
  startStream: () => void;
}

export function createNativeGateway({
  token,
  nativeRows,
  enabledProviders,
  authFile,
  fetchImpl = fetch,
  onEvent = () => {},
  timeoutMs,
  cursor,
  antigravity,
  zen,
  approvalBridge,
  approvalProviders = approvalBridge ? ['openai'] : [],
  blockAnthropic,
  guardAuto,
  permissionModes,
  agentCatalog,
}: GatewayOptions): Server {
  if (!token) {
    throw new Error('Gateway token required');
  }
  if (zen) {
    validateZenKey(zen.apiKey);
  }
  const fallbackSession = randomUUID();
  const approvalContexts = new Map<string, ApprovalContext>();
  const pendingTools = new Map<string, PendingApprovalTool>();
  const reviewCandidates = new Map<
    string,
    { tool: PendingApprovalTool; context: ApprovalContext }
  >();
  function nativeReviewSession(session: unknown) {
    if (blockAnthropic || typeof session !== 'string' || !session) {
      return false;
    }
    const contexts = [...approvalContexts.values()].filter(
      (context) => JSON.parse(context.scope)[0] === session,
    );
    // Headerless worker reviews need origin matching only when this session has
    // external execution. Native Claude owns its classifier format and retries.
    return contexts.length > 0 && contexts.every((context) => !context.model.startsWith('multi/'));
  }
  const matchesBashAction = (
    candidate: { tool: PendingApprovalTool; context: ApprovalContext },
    action: unknown,
  ) => {
    if (
      !isRecord(candidate.tool.input) ||
      typeof candidate.tool.input.command !== 'string' ||
      typeof action !== 'string'
    ) {
      return false;
    }
    if (candidate.tool.input.command === action) {
      return true;
    }
    // Claude's classifier omits its redundant current-workspace `cd` prefix.
    return (
      typeof candidate.context.cwd === 'string' &&
      /^[A-Za-z0-9_./-]+$/.test(candidate.context.cwd) &&
      candidate.tool.input.command === `cd ${candidate.context.cwd} && ${action}`
    );
  };
  function permissionHook(parsed: Record<string, unknown>) {
    const id = typeof parsed.tool_use_id === 'string' ? parsed.tool_use_id : '';
    const pending = pendingTools.get(id);
    pendingTools.delete(id);
    if (
      nativeRows &&
      pending?.model.startsWith('multi/cursor/') &&
      pending.session === parsed.session_id &&
      pending.name === parsed.tool_name &&
      isNativeRowTool(pending.name)
    ) {
      return {};
    }
    if (
      pending?.scope &&
      pending.session === parsed.session_id &&
      pending.name === parsed.tool_name &&
      typeof parsed.cwd === 'string' &&
      path.isAbsolute(parsed.cwd)
    ) {
      const context = approvalContexts.get(pending.scope);
      if (context?.model === pending.model) {
        evictOldest(reviewCandidates, 512);
        reviewCandidates.set(id, { tool: pending, context: { ...context, cwd: parsed.cwd } });
      }
    }
    if (nativeReviewSession(parsed.session_id)) {
      return {};
    }
    return approvalCapabilityGuard(parsed, pending, approvalProviders, !blockAnthropic);
  }
  function retainContext(
    approvalScope: string,
    external: string,
    body: MessagesRequest,
    identity: string | undefined,
    agentId: string | undefined,
  ) {
    for (const [id, candidate] of reviewCandidates) {
      if (candidate.context.scope === approvalScope) {
        reviewCandidates.delete(id);
      }
    }
    // Each worker retains its own current request; provider switches replace it.
    approvalContexts.delete(approvalScope);
    evictOldest(approvalContexts, 128);
    approvalContexts.set(approvalScope, {
      model: external,
      request: body,
      scope: approvalScope,
      worker: Boolean(agentId),
      rootRequest: agentId
        ? approvalContexts.get(JSON.stringify([identity, 'main']))?.request
        : undefined,
    });
  }
  function pendingReview(parsed: Record<string, unknown>, sourceSession: string) {
    const { action } = parseApprovalRequest(parsed);
    const name = Object.keys(action)[0];
    const candidates = [...reviewCandidates.values()].filter(
      (candidate) =>
        candidate.tool.session === sourceSession &&
        candidate.tool.name === name &&
        (name !== 'Bash' || matchesBashAction(candidate, action[name])),
    );
    if (candidates.length !== 1) {
      throw new BadRequest('Missing or ambiguous pending review action');
    }
    return candidates[0].context;
  }
  async function handleHarness(exchange: ProviderRequest, provider: 'cursor' | 'antigravity') {
    const { res, body, url, signal, agentId, emit, identity } = exchange;
    const bridge = { cursor, antigravity }[provider];
    if (!bridge) {
      const unavailable = {
        cursor: 'Cursor SDK is not signed in. Run the launcher with --cursor-login first.',
        antigravity:
          'Antigravity is unavailable. Enable its experimental CLI integration in the launcher.',
      };
      throw new BadRequest(unavailable[provider]);
    }
    const scope = identity.scope ?? JSON.stringify([fallbackSession, agentId ?? 'main']);
    const rowScope = JSON.stringify([
      scope,
      path.resolve(exchange.permissionContext?.cwd ?? process.cwd()),
    ]);
    if (provider === 'cursor' && (await prepareNativeRows(exchange, rowScope, nativeRows))) {
      return;
    }
    const nativeBody = exchange.body;
    const inputTokens = validateHarness(exchange, provider, bridge);
    if (url.pathname === '/v1/messages/count_tokens') {
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-multi-token-count': 'estimate',
      });
      return res.end(JSON.stringify({ input_tokens: inputTokens }));
    }
    exchange.startStream();
    if (
      provider === 'cursor' &&
      (await runNativeRows(exchange, scope, rowScope, nativeRows, cursor))
    ) {
      return;
    }
    const result = await bridge.handle(
      nativeBody,
      scope,
      signal,
      body.stream ? emit : undefined,
      exchange.permissionContext,
    );
    rememberResult(exchange, result);
    onEvent({
      route: provider,
      agentId,
      model: body.model,
      stopReason: result.stop_reason,
      tools: result.content.filter((b) => b.type === 'tool_use').map((b) => b.name),
    });
    sendResult(exchange, result);
  }
  async function handleOpenAI(exchange: ProviderRequest, externalModel: string) {
    const { req, res, body, url, signal, abort, agentId, emit } = exchange;
    const request = openaiRequest(exchange, externalModel);
    request.prompt_cache_key = createHash('sha256')
      .update(
        JSON.stringify([
          'openai',
          exchange.identity.session || fallbackSession,
          agentId ?? 'main',
          request.model,
        ]),
      )
      .digest('hex');
    if (url.pathname === '/v1/messages/count_tokens') {
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-multi-token-count': 'estimate',
      });
      return res.end(JSON.stringify({ input_tokens: estimateInputTokens(request) }));
    }
    const toolNames = originalToolNames(body);
    onEvent({
      route: 'openai-request',
      agentId,
      model: request.model,
      effort: request.reasoning.effort,
    });
    const headers = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      originator: 'cc_multi_native',
      session_id: String(
        agentId ?? header(req.headers['x-claude-code-session-id']) ?? fallbackSession,
      ),
    };
    const upstream = await codexRequest(authFile, signal, (auth) =>
      fetchImpl(OPENAI_URL, {
        method: 'POST',
        headers: { ...headers, ...auth },
        body: JSON.stringify(request),
        signal,
        redirect: 'error',
      }),
    );
    if (!upstream.ok) {
      // Do not print upstream bodies or credentials in gateway diagnostics.
      onEvent({ route: 'openai', status: upstream.status });
      await upstream.body?.cancel();
      throw new UpstreamFailure(upstream.status, upstream.headers.get('retry-after'));
    }
    if (!upstream.body) {
      throw new Error('OpenAI returned no response stream.');
    }
    exchange.startStream();
    const result = await fromResponses(
      upstream.body,
      externalModel,
      body.stream ? emit : undefined,
      { toolNames, stopSequences: body.stop_sequences, inputTokens: estimateInputTokens(request) },
    );
    rememberResult(exchange, result);
    if (result.stop_reason === 'stop_sequence') {
      abort.abort();
    }
    onEvent({
      route: 'openai',
      agentId,
      stopReason: result.stop_reason,
      tools: result.content.filter((b) => b.type === 'tool_use').map((b) => b.name),
    });
    sendResult(exchange, result);
  }
  async function handleZen(exchange: ProviderRequest) {
    const { res, body, url, signal, agentId, emit } = exchange;
    if (!zen?.apiKey) {
      throw new BadRequest('Zen is not configured. Set OPENCODE_API_KEY or connect OpenCode Zen.');
    }
    const prepared = prepareZenRequest(exchange, fallbackSession);
    if (url.pathname === '/v1/messages/count_tokens') {
      res.writeHead(200, { 'content-type': 'application/json', 'x-multi-token-count': 'estimate' });
      return res.end(JSON.stringify({ input_tokens: prepared.inputTokens }));
    }
    onEvent({ route: 'zen-request', agentId, model: body.model });
    const upstream = await fetchImpl(`https://opencode.ai/zen/v1/${prepared.endpoint}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${zen.apiKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'x-opencode-session': prepared.cacheKey,
        'x-opencode-client': 'cc-multi-cli-plugin',
      },
      body: JSON.stringify(prepared.body),
      signal,
      redirect: 'error',
    });
    if (!upstream.ok) {
      onEvent({ route: 'zen', agentId, status: upstream.status });
      await upstream.body?.cancel();
      throw new UpstreamFailure(upstream.status, upstream.headers.get('retry-after'), 'Zen');
    }
    if (!upstream.body) {
      throw new Error('Zen returned no response stream.');
    }
    exchange.startStream();
    const options = {
      toolNames: originalToolNames(body),
      stopSequences: body.stop_sequences,
      signaturePrefix: prepared.signaturePrefix,
      requireUsage: true,
      inputTokens: prepared.inputTokens,
    };
    const translate = prepared.endpoint === 'responses' ? fromResponses : fromChat;
    const result = await translate(
      upstream.body,
      String(body.model),
      body.stream ? emit : undefined,
      options,
    );
    rememberResult(exchange, result);
    if (result.stop_reason === 'stop_sequence') {
      exchange.abort.abort();
    }
    onEvent({
      route: 'zen',
      agentId,
      model: body.model,
      stopReason: result.stop_reason,
      usage: result.usage,
    });
    sendResult(exchange, result);
  }
  async function handleAnthropic(exchange: ProviderRequest) {
    const { req, res, body, url, raw, signal } = exchange;
    const headers = anthropicHeaders(req);
    const cleaned = forAnthropic(body);
    let forwarded: Buffer | undefined;
    if (req.method === 'POST') {
      forwarded = cleaned === body ? raw : Buffer.from(JSON.stringify(cleaned));
    }
    const upstream = await fetchImpl(ANTHROPIC_URL + url.pathname + url.search, {
      method: req.method ?? 'GET',
      headers,
      body: forwarded,
      signal,
      redirect: 'error',
    });
    onEvent({ route: 'anthropic', status: upstream.status, model: body.model });
    const responseHeaders = Object.fromEntries(upstream.headers);
    for (const name of STRIPPED_RESPONSE_HEADERS) {
      delete responseHeaders[name];
    }
    res.writeHead(upstream.status, responseHeaders);
    if (guardAuto && upstream.ok && body.tools?.length) {
      await forwardObservedTools(upstream, res, exchange.remember, signal);
    } else if (upstream.body) {
      await pipeline(Readable.fromWeb(upstream.body), res);
    } else {
      res.end();
    }
  }
  async function handleReview(exchange: ProviderRequest, context: ApprovalContext | undefined) {
    const { req, res, parsed, url, signal, agentId } = exchange;
    if (!approvalBridge) {
      throw new Error('Approval bridge unavailable');
    }
    if (url.pathname !== '/v1/messages' || req.method !== 'POST') {
      throw new BadRequest('Anthropic passthrough is disabled');
    }
    const result = await approvalBridge.respond(parsed, signal, context);
    const worker = context ? JSON.parse(context.scope)[1] : agentId;
    onEvent({
      route: 'approval',
      model: result.message.model,
      agentId: worker === 'main' ? null : (worker ?? null),
      stage: result.stage,
      outcome: result.outcome,
      cached: result.cached,
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(result.message));
  }
  function retainRequestContext(
    { body, url, req, agentId }: ProviderRequest,
    { identity, scope }: ReturnType<typeof requestIdentity>,
    external: string,
  ) {
    if ((!guardAuto && !approvalBridge) || !scope || !body.tools?.length) {
      return;
    }
    if (url.pathname !== '/v1/messages' || req.method !== 'POST') {
      return;
    }
    retainContext(scope, external, body, identity, agentId);
  }
  function sendPermissionDecision({ req, res, parsed }: ProviderRequest) {
    if (req.method !== 'POST') {
      throw new BadRequest('Permission hook requires POST');
    }
    const decision = permissionHook(parsed);
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(decision));
  }
  async function recordMode(exchange: ProviderRequest) {
    if (!permissionModes || exchange.req.method !== 'POST') {
      throw new BadRequest('Mode hook is unavailable');
    }
    try {
      await permissionModes.record(exchange.parsed);
    } catch (error) {
      throw new BadRequest(reason(error));
    }
    exchange.res.writeHead(200, { 'content-type': 'application/json' });
    return exchange.res.end('{}');
  }
  async function dispatch(
    exchange: ProviderRequest,
    metadata: ReturnType<typeof requestIdentity>,
    external: string | null,
  ) {
    const { parsed } = exchange;
    const classification = isApprovalRequest(parsed);
    if (classification) {
      if (!external && nativeReviewSession(metadata.session)) {
        return handleAnthropic(exchange);
      }
      return dispatchReview(exchange, metadata, external);
    }
    retainRequestContext(exchange, metadata, String(exchange.body.model ?? ''));
    if (!external && blockAnthropic) {
      throw new BadRequest('Anthropic is not signed in. Select an external model.');
    }
    return forwardProvider(exchange, external);
  }
  async function dispatchReview(
    exchange: ProviderRequest,
    metadata: ReturnType<typeof requestIdentity>,
    external: string | null,
  ) {
    // Native classification may omit the worker header or retry with a working
    // model ID. The pending action, not that ID or the current parent, owns review.
    let context = metadata.scope ? approvalContexts.get(metadata.scope) : undefined;
    if (guardAuto) {
      context = pendingReview(exchange.parsed, metadata.session);
    }
    const openai = context?.model.startsWith('multi/openai/');
    if (approvalBridge && (openai || (!guardAuto && !context))) {
      return handleReview(exchange, context);
    }
    const nativeClaude =
      context && (!context.model.startsWith('multi/') || context.model.startsWith('multi/zen/'));
    if (openai || external || blockAnthropic || (context && !nativeClaude)) {
      throw new BadRequest(
        'Automatic review cannot use ordinary external inference. No matching provider reviewer is enabled.',
      );
    }
    return handleAnthropic(exchange);
  }
  async function forwardProvider(exchange: ProviderRequest, external: string | null) {
    const { body, agentId, url } = exchange;
    const route = providerRoute(external);
    let permissionContext: PermissionContext | undefined;
    if (
      permissionModes &&
      ['cursor', 'antigravity'].includes(route) &&
      url.pathname === '/v1/messages'
    ) {
      try {
        permissionContext = permissionModes.resolve(exchange.identity.session, agentId);
        exchange.permissionContext = permissionContext;
      } catch (error) {
        throw new BadRequest(reason(error));
      }
    }
    onEvent({
      route,
      model: body.model,
      agentId: agentId ?? null,
      path: url.pathname,
      permissionContext,
    });
    if (!external) {
      return handleAnthropic(exchange);
    }
    if (route === 'cursor' || route === 'antigravity') {
      return handleHarness(exchange, route);
    }
    if (external.startsWith('multi/zen/')) {
      return handleZen(exchange);
    }
    return handleOpenAI(exchange, external);
  }
  return http.createServer(async (req, res) => {
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) {
        abort.abort();
      }
    });
    let heartbeat: NodeJS.Timeout | undefined;
    let sourceModel = '';
    let sourceSession = '';
    let sourceScope: string | undefined;
    const observer = new ToolObserver((tool) => remember(tool));
    const remember = (tool: { id: string; name: string; input: unknown }) => {
      if (!guardAuto || !sourceSession) {
        return;
      }
      evictOldest(pendingTools, 512);
      pendingTools.set(tool.id, {
        model: sourceModel,
        session: sourceSession,
        name: tool.name,
        input: tool.input,
        scope: sourceScope,
      });
    };
    const emit: Emit = (type, value) => {
      if (guardAuto) {
        observer.event({ type, ...value });
      }
      return res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
    };
    try {
      if (!authorizeRequest(req, res, token, guardAuto)) {
        return;
      }
      const url = new URL(req.url ?? '', 'http://localhost');
      const { raw, parsed, body } = await readRequest(req, agentCatalog);
      if (url.pathname === '/multi/native-mcp') {
        return await handleNativeMcp(req, res, parsed, abort.signal, nativeRows);
      }
      const external = externalModel(body.model);
      assertProviderEnabled(external, enabledProviders);
      const signal = providerSignal(abort.signal, external, timeoutMs);
      const agentId = header(req.headers['x-claude-code-agent-id']);
      const metadata = requestIdentity(
        parsed,
        agentId,
        header(req.headers['x-claude-code-session-id']),
      );
      sourceModel = String(body.model ?? '');
      sourceSession = metadata.session;
      sourceScope = metadata.scope;
      const exchange: ProviderRequest = {
        req,
        res,
        body,
        parsed,
        identity: metadata,
        raw,
        url,
        signal,
        abort,
        agentId,
        emit,
        remember,
        startStream: () => {
          if (!body.stream) {
            return;
          }
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          res.flushHeaders();
          heartbeat = setInterval(() => emit('ping', {}), 15000);
        },
      };
      if (url.pathname === '/multi/permission') {
        return sendPermissionDecision(exchange);
      }
      if (url.pathname === '/multi/mode') {
        return await recordMode(exchange);
      }
      await dispatch(exchange, metadata, external);
    } catch (error) {
      abort.abort();
      failResponse(res, emit, error);
    } finally {
      clearInterval(heartbeat);
    }
  });
}

class RequestTooLarge extends Error {}

function providerSignal(disconnected: AbortSignal, model: string | null, timeoutMs?: number) {
  // Native harness runs follow the client connection rather than an HTTP deadline.
  if (model?.startsWith('multi/cursor/') || model?.startsWith('multi/antigravity/')) {
    return disconnected;
  }
  if (
    (model?.startsWith('multi/openai/') || model?.startsWith('multi/zen/')) &&
    timeoutMs === undefined
  ) {
    return disconnected;
  }
  return AbortSignal.any([disconnected, AbortSignal.timeout(timeoutMs ?? 180000)]);
}

async function readRequest(req: http.IncomingMessage, catalog?: AgentCatalog) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      throw new RequestTooLarge();
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  let parsed: unknown;
  try {
    parsed = raw.length ? JSON.parse(raw.toString('utf8')) : {};
  } catch {
    throw new BadRequest('Invalid JSON');
  }
  if (!isRecord(parsed) || (parsed.model !== undefined && typeof parsed.model !== 'string')) {
    throw new BadRequest('Expected an object with a string model');
  }
  const body: MessagesRequest = isApprovalRequest(parsed)
    ? parsed
    : (catalog?.compact(parsed) ?? parsed);
  return { raw: body === parsed ? raw : Buffer.from(JSON.stringify(body)), parsed, body };
}

function providerRoute(
  model: string | null,
): 'cursor' | 'antigravity' | 'openai' | 'anthropic' | 'zen' {
  if (model?.startsWith('multi/cursor/')) {
    return 'cursor';
  }
  if (model?.startsWith('multi/antigravity/')) {
    return 'antigravity';
  }
  if (model?.startsWith('multi/zen/')) {
    return 'zen';
  }
  return model ? 'openai' : 'anthropic';
}
function errorStatus(error: unknown): number {
  if (error instanceof CodexAuthError) {
    return 401;
  }
  if (error instanceof BadRequest) {
    return 400;
  }
  if (error instanceof UpstreamFailure) {
    return error.status;
  }
  if (error instanceof CursorProviderError || error instanceof AntigravityProviderError) {
    return error.failure.status;
  }
  return 502;
}

function rememberResult(exchange: ProviderRequest, result: MessagesResponse) {
  if (exchange.body.stream) {
    return;
  }
  for (const tool of result.content) {
    if (tool.type === 'tool_use') {
      exchange.remember(tool);
    }
  }
}
function sendResult(exchange: ProviderRequest, result: MessagesResponse) {
  if (!exchange.body.stream) {
    exchange.res.writeHead(200, { 'content-type': 'application/json' });
  }
  exchange.res.end(exchange.body.stream ? undefined : JSON.stringify(result));
}

function evictOldest<T>(cache: Map<string, T>, capacity: number) {
  const oldest = cache.keys().next();
  if (cache.size >= capacity && !oldest.done) {
    cache.delete(oldest.value);
  }
}

function requestIdentity(
  parsed: Record<string, unknown>,
  agentId?: string,
  sessionHeader?: string,
) {
  const rawIdentity =
    isRecord(parsed.metadata) && typeof parsed.metadata.user_id === 'string'
      ? parsed.metadata.user_id
      : undefined;
  let session = '';
  if (rawIdentity) {
    try {
      const metadata: unknown = JSON.parse(rawIdentity);
      if (isRecord(metadata) && typeof metadata.session_id === 'string') {
        session = metadata.session_id;
      }
    } catch {
      /* Unknown identity cannot grant auto capability. */
    }
  }
  if (session && sessionHeader && session !== sessionHeader) {
    throw new BadRequest('Session header and metadata disagree');
  }
  session = session || sessionHeader || '';
  const identity = session || rawIdentity;
  return {
    identity,
    session,
    scope: identity ? JSON.stringify([identity, agentId ?? 'main']) : undefined,
  };
}

function prepareZenRequest(exchange: ProviderRequest, fallbackSession: string) {
  const { req, body, url, identity, agentId } = exchange;
  try {
    if (
      req.method !== 'POST' ||
      !['/v1/messages', '/v1/messages/count_tokens'].includes(url.pathname)
    ) {
      throw new Error('Zen requires POST /v1/messages or /v1/messages/count_tokens');
    }
    // Zen uses this for sticky upstream routing. Claude identity survives restarts;
    // no per-request nonce is inserted into the prompt or cache key.
    const cacheKey = createHash('sha256')
      .update(
        JSON.stringify([
          identity.session || fallbackSession,
          agentId ?? 'main',
          body.model,
          process.cwd(),
        ]),
      )
      .digest('hex');
    return { ...zenRequest(body, cacheKey), cacheKey };
  } catch (error) {
    throw new BadRequest(reason(error));
  }
}

function openaiRequest(exchange: ProviderRequest, externalModel: string): ResponsesRequest {
  const { req, body, url } = exchange;
  try {
    const model = Object.values(MODELS).find((model) => externalModel === `multi/openai/${model}`);
    if (!model) {
      throw new Error('Unknown native OpenAI model');
    }
    if (
      !['/v1/messages', '/v1/messages/count_tokens'].includes(url.pathname) ||
      req.method !== 'POST'
    ) {
      throw new Error('External models require POST /v1/messages or /v1/messages/count_tokens');
    }
    const request = toResponses(body, model);
    return { ...request, instructions: openaiInstructions(request.instructions) };
  } catch (error) {
    throw new BadRequest(reason(error));
  }
}

function anthropicHeaders(req: http.IncomingMessage) {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const single = header(value);
    if (single !== undefined && !STRIPPED_REQUEST_HEADERS.includes(name)) {
      headers[name] = single;
    }
  }
  headers['accept-encoding'] = 'identity';
  return headers;
}

function authorizeRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  token: string,
  guardAuto?: boolean,
) {
  if (req.headers.origin || !authenticated(req.headers['x-multi-gateway-token'], token)) {
    res.writeHead(403);
    res.end('Forbidden');
    return false;
  }
  const url = new URL(req.url ?? '', 'http://localhost');
  if (
    ![
      '/v1/messages',
      '/v1/messages/count_tokens',
      '/v1/models',
      '/api/hello',
      '/multi/mode',
      '/multi/native-mcp',
      ...(guardAuto ? ['/multi/permission'] : []),
    ].includes(url.pathname) ||
    !['POST', 'GET', 'HEAD'].includes(req.method ?? '')
  ) {
    res.writeHead(404);
    res.end('Not found');
    return false;
  }
  return true;
}

function failResponse(res: http.ServerResponse, emit: Emit, error: unknown) {
  if (res.destroyed) {
    return;
  }
  const status = errorStatus(error);
  if (error instanceof RequestTooLarge) {
    res.writeHead(413);
    res.end('Request too large');
    return;
  }
  const errorTypes: Record<number, string> = {
    400: 'invalid_request_error',
    401: 'authentication_error',
    403: 'permission_error',
    404: 'not_found_error',
    429: 'rate_limit_error',
    503: 'overloaded_error',
  };
  const failure = {
    type: 'error',
    error: {
      type: errorTypes[status] ?? 'api_error',
      message: `Native gateway: ${reason(error)}`,
    },
  };
  if (error instanceof UpstreamFailure && error.retryAfter && !res.headersSent) {
    res.setHeader('retry-after', error.retryAfter);
  }
  if (res.headersSent) {
    emit('error', { error: failure.error });
    res.end();
  } else {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(failure));
  }
}

function assertProviderEnabled(model: string | null, enabled: readonly string[] | undefined) {
  if (model && enabled && !enabled.includes(model.split('/')[1])) {
    throw new BadRequest('This provider plugin is not enabled for this session.');
  }
}

async function handleNativeMcp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  parsed: Record<string, unknown>,
  signal: AbortSignal,
  nativeRows?: NativeRows,
) {
  if (!nativeRows || req.method !== 'POST') {
    res.writeHead(405);
    return res.end();
  }
  if (parsed.id === undefined) {
    res.writeHead(202);
    return res.end();
  }
  let result: unknown;
  try {
    result = {
      jsonrpc: '2.0',
      id: parsed.id,
      result: await nativeRows.rpc(parsed, signal),
    };
  } catch (error) {
    result = {
      jsonrpc: '2.0',
      id: parsed.id,
      error: { code: -32602, message: reason(error) },
    };
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  return res.end(JSON.stringify(result));
}

async function prepareNativeRows(exchange: ProviderRequest, scope: string, rows?: NativeRows) {
  if (!rows) {
    return false;
  }
  if (exchange.url.pathname === '/v1/messages') {
    const reply = await rows.followup(exchange.body, scope);
    if (reply) {
      exchange.startStream();
      if (exchange.body.stream) {
        emitRowResponse(reply, exchange.emit);
      }
      sendResult(exchange, reply);
      return true;
    }
  }
  exchange.body = await rows.normalize(exchange.body, scope);
  return false;
}
async function runNativeRows(
  exchange: ProviderRequest,
  scope: string,
  rowScope: string,
  rows: NativeRows | undefined,
  cursor: GatewayOptions['cursor'],
) {
  if (!cursor || !rows?.available(exchange.body) || !exchange.body.stream) {
    return false;
  }
  const result = await rows.run(
    exchange.body,
    rowScope,
    exchange.emit,
    exchange.abort,
    (observer) =>
      cursor.handle(
        exchange.body,
        scope,
        exchange.signal,
        undefined,
        exchange.permissionContext,
        observer,
      ),
  );
  sendResult(exchange, result);
  return true;
}

function externalModel(model: unknown) {
  return typeof model === 'string' && model.startsWith('multi/') ? model : null;
}
function validateHarness(
  exchange: ProviderRequest,
  provider: string,
  bridge: NonNullable<GatewayOptions['cursor'] | GatewayOptions['antigravity']>,
) {
  try {
    if (
      !['/v1/messages', '/v1/messages/count_tokens'].includes(exchange.url.pathname) ||
      exchange.req.method !== 'POST'
    ) {
      throw new Error(`${provider} requires POST /v1/messages or /v1/messages/count_tokens`);
    }
    return bridge.validate(exchange.body, exchange.permissionContext);
  } catch (error) {
    throw new BadRequest(reason(error));
  }
}
