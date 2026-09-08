import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeGateway } from '../../plugins/multi/src/gateway/server.ts';

test('Cursor uses canonical session and worker identity and rejects contradictory metadata', async (t) => {
  const scopes: string[] = [];
  const server = createNativeGateway({
    token: 'test-token',
    authFile: 'unused',
    cursor: {
      validate: () => 0,
      handle: async (body, scope) => {
        scopes.push(scope);
        return {
          id: 'message',
          type: 'message',
          role: 'assistant',
          model: body.model ?? '',
          content: [{ type: 'text', text: 'done' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 1 },
        };
      },
    },
  });
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const port = address.port;
  async function request(sessionHeader?: string, metadata?: unknown, worker?: string) {
    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-multi-gateway-token': 'test-token',
        'content-type': 'application/json',
        ...(sessionHeader ? { 'x-claude-code-session-id': sessionHeader } : {}),
        ...(worker ? { 'x-claude-code-agent-id': worker } : {}),
      },
      body: JSON.stringify({
        model: 'multi/cursor/test',
        messages: [{ role: 'user', content: 'hi' }],
        metadata,
      }),
    });
    await response.text();
    return response.status;
  }
  assert.equal(await request('session-one'), 200);
  assert.equal(
    await request(undefined, {
      user_id: JSON.stringify({ session_id: 'session-one', account_uuid: 'account' }),
    }),
    200,
  );
  assert.equal(
    scopes[0],
    scopes[1],
    'metadata formatting/account fields must not change the session',
  );
  assert.equal(await request('session-one', undefined, 'worker-one'), 200);
  assert.notEqual(scopes[0], scopes[2]);
  assert.equal(await request('session-two'), 200);
  assert.notEqual(scopes[0], scopes[3]);
  assert.equal(
    await request('session-one', { user_id: JSON.stringify({ session_id: 'wrong' }) }),
    400,
  );
  assert.equal(scopes.length, 4, 'contradictory identity must fail before provider execution');
});
