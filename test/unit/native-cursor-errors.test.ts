import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AuthenticationError, ConfigurationError, NetworkError, RateLimitError } from '@cursor/sdk';
import type { Emit, MessagesRequest } from '../../plugins/multi/src/gateway/messages.ts';
import { createNativeGateway } from '../../plugins/multi/src/gateway/server.ts';
import {
  CursorProviderError,
  cursorFailure,
  sanitizeCursorErrorMessage,
} from '../../plugins/multi/src/providers/cursor/errors.ts';
import { CursorHarness } from '../../plugins/multi/src/providers/cursor/harness.ts';
import { cursorModelOptions } from '../../plugins/multi/src/providers/cursor/models.ts';

test('Cursor SDK classes preserve the provider error contract', () => {
  const authentication = cursorFailure(new AuthenticationError('Bearer secret-token'));
  assert.equal(authentication.status, 401);
  assert.equal(authentication.message, 'Bearer [redacted]');
  assert.equal(cursorFailure(new RateLimitError('slow down')).status, 429);
  assert.equal(cursorFailure(new NetworkError('service unavailable')).status, 503);
  assert.equal(cursorFailure(new ConfigurationError('bad model')).status, 400);
});

test('stable SDK codes retain context, cancellation, and correlation detail', () => {
  assert.equal(
    cursorFailure({ code: 'context_length_exceeded', message: 'prompt too large' }).status,
    400,
  );
  assert.equal(
    cursorFailure({ name: 'AbortError', code: 'aborted', message: 'stopped' }).status,
    499,
  );
  const error = new NetworkError('temporary', { code: 'unavailable', requestId: 'req-123' });
  assert.deepEqual(cursorFailure(error), {
    status: 503,
    code: 'unavailable',
    requestId: 'req-123',
    message: 'temporary',
  });
});

test('sanitization removes credential carriers and bounds diagnostics', () => {
  const message = sanitizeCursorErrorMessage(
    'Bearer top-secret https://user:pass@example.com/x?api_key=secret\nline',
  );
  assert.equal(
    message,
    'Bearer [redacted] https://[redacted]@example.com/x?api_key=[redacted] line',
  );
  assert.ok(message.length <= 500);
});

test('CursorProviderError keeps a structured failure and original cause', () => {
  const cause = new AuthenticationError('unauthorized');
  const error = new CursorProviderError(cause);
  assert.equal(error.failure.status, 401);
  assert.equal(error.cause, cause);
});

test('credential redaction precedes message and correlation truncation', () => {
  const previous = process.env.CURSOR_API_KEY;
  const secret = 'synthetic-cursor-key-for-redaction';
  process.env.CURSOR_API_KEY = secret;
  try {
    const error = new CursorProviderError({
      message: `${'x'.repeat(490)}${secret}`,
      code: `${'y'.repeat(70)}${secret}`,
      requestId: secret,
    });
    assert.doesNotMatch(error.message, /synthetic/);
    assert.equal(error.failure.requestId, '[redacted]');
  } finally {
    if (previous === undefined) {
      delete process.env.CURSOR_API_KEY;
    } else {
      process.env.CURSOR_API_KEY = previous;
    }
  }
});

test('gateway preserves Cursor status and SSE failure terminal event', async (t) => {
  const payload = {
    model: 'multi/cursor/test-model',
    messages: [{ role: 'user', content: 'hello' }],
    stream: false,
  };
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cursor-errors-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const makeHarness = (code: string) => {
    const harness = new CursorHarness(
      cursorModelOptions([{ id: 'test-model', displayName: 'Test' }]),
      {
        cwd: directory,
        stateDirectory: path.join(directory, code),
        createAgent: async () => ({
          agentId: 'agent',
          close: () => {},
          send: async () => ({
            id: 'run',
            agentId: 'agent',
            status: 'error',
            wait: async () => ({
              id: 'run',
              status: 'error',
              requestId: 'req-42',
              error: { code, message: 'Bearer sdk-secret' },
            }),
            cancel: async () => {},
            async *stream() {},
            conversation: async () => [],
            supports: () => true,
            unsupportedReason: () => undefined,
            onDidChangeStatus: () => () => {},
          }),
        }),
      },
    );
    t.after(() => harness.close());
    // This fixture tests error translation with an explicit native Auto policy.
    return {
      validate: (body: MessagesRequest) => harness.validate(body, { permissionMode: 'auto' }),
      handle: (body: MessagesRequest, scope: string, signal: AbortSignal, emit?: Emit) =>
        harness.handle(body, scope, signal, emit, { permissionMode: 'auto' }),
    };
  };
  const server = createNativeGateway({
    token: 'local',
    authFile: '/does-not-exist',
    cursor: makeHarness('AUTH_TOKEN_EXPIRED'),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const request = (body: unknown) =>
    fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: 'POST',
      headers: { 'x-multi-gateway-token': 'local' },
      body: JSON.stringify(body),
    });
  const response = await request(payload);
  assert.equal(response.status, 401);
  const json = await response.text();
  assert.match(json, /authentication_error/);
  assert.match(json, /AUTH_TOKEN_EXPIRED/);
  assert.doesNotMatch(json, /sdk-secret/);

  const streamServer = createNativeGateway({
    token: 'local',
    authFile: '/does-not-exist',
    cursor: makeHarness('RESOURCE_EXHAUSTED'),
  });
  await new Promise<void>((resolve) => streamServer.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    streamServer.closeAllConnections();
    await new Promise<void>((resolve) => streamServer.close(() => resolve()));
  });
  const streamAddress = streamServer.address();
  assert(streamAddress && typeof streamAddress !== 'string');
  const streamResponse = await fetch(`http://127.0.0.1:${streamAddress.port}/v1/messages`, {
    method: 'POST',
    headers: { 'x-multi-gateway-token': 'local' },
    body: JSON.stringify({ ...payload, stream: true }),
  });
  assert.equal(streamResponse.status, 200);
  const sse = await streamResponse.text();
  assert.match(sse, /event: error/);
  assert.doesNotMatch(sse, /message_stop/);
  assert.match(sse, /RESOURCE_EXHAUSTED/);
  assert.match(sse, /rate_limit_error/);
  assert.doesNotMatch(sse, /sdk-secret/);
});
