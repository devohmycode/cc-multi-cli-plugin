import assert from 'node:assert/strict';
import test from 'node:test';
import { PermissionModes } from '../../plugins/multi/src/gateway/mode-hook.ts';
import { createNativeGateway } from '../../plugins/multi/src/gateway/server.ts';

test('hook snapshots resolve worker overrides, parent precedence, and next-prompt changes', async () => {
  const modes = new PermissionModes(async () => ({
    coder: {},
    planner: { permissionMode: 'plan', tools: ['Read'] },
  }));
  const prompt = (mode: string, session = 'one') =>
    modes.record({
      hook_event_name: 'UserPromptSubmit',
      session_id: session,
      permission_mode: mode,
    });
  const worker = (type: string, id = type, session = 'one') =>
    modes.record({
      hook_event_name: 'SubagentStart',
      session_id: session,
      agent_id: id,
      agent_type: type,
      cwd: '/tmp',
    });
  await prompt('default');
  await worker('planner');
  await worker('coder');
  assert.equal(modes.resolve('one', 'coder').permissionMode, 'default');
  assert.deepEqual(modes.resolve('one', 'planner'), {
    cwd: '/tmp',
    permissionMode: 'plan',
    tools: ['Read'],
    disallowedTools: undefined,
  });
  for (const mode of ['auto', 'acceptEdits', 'bypassPermissions']) {
    await prompt(mode);
    assert.equal(modes.resolve('one', 'planner').permissionMode, mode);
    assert.deepEqual(modes.resolve('one', 'planner').tools, ['Read']);
  }
  await prompt('plan');
  assert.equal(modes.resolve('one', 'coder').permissionMode, 'plan');
  await prompt('default', 'two');
  assert.throws(() => modes.resolve('two', 'planner'), /unavailable/);
  await assert.rejects(worker('unknown', 'planner'), /Cannot resolve/);
  assert.throws(() => modes.resolve('one', 'planner'), /unavailable/);
  await assert.rejects(prompt('made-up'), /unsupported/);
  assert.throws(() => modes.resolve('one'), /unavailable/);
  const bounded = new PermissionModes(async () => ({}));
  for (let i = 0; i < 4096; i++) {
    await bounded.record({
      hook_event_name: 'UserPromptSubmit',
      session_id: String(i),
      permission_mode: 'plan',
    });
  }
  await assert.rejects(
    bounded.record({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'overflow',
      permission_mode: 'auto',
    }),
    /limit reached/,
  );
  await bounded.record({
    hook_event_name: 'UserPromptSubmit',
    session_id: '0',
    permission_mode: 'auto',
  });
  assert.equal(bounded.resolve('0').permissionMode, 'auto');
});

test('authenticated hooks supply Cursor request context without prompt markers', async (t) => {
  const modes = new PermissionModes(async () => ({ coder: { permissionMode: 'plan' } }));
  const observed: string[] = [];
  let calls = 0;
  const delivered: string[] = [];
  const server = createNativeGateway({
    token: 'secret',
    authFile: 'unused',
    permissionModes: modes,
    onEvent(event) {
      if (event.permissionContext) {
        observed.push(event.permissionContext.permissionMode);
      }
    },
    cursor: {
      validate: () => 0,
      async handle(body, _scope, _signal, _emit, context) {
        calls++;
        assert(context);
        delivered.push(context.permissionMode);
        assert.equal(body.messages?.[0].content, 'unchanged');
        return {
          id: 'msg',
          type: 'message',
          role: 'assistant',
          model: body.model ?? '',
          content: [{ type: 'text', text: 'done' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    },
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  async function post(route: string, body: unknown, agent?: string, token = 'secret') {
    const result = await fetch(url + route, {
      method: 'POST',
      headers: {
        'x-multi-gateway-token': token,
        'x-claude-code-session-id': 'one',
        ...(agent ? { 'x-claude-code-agent-id': agent } : {}),
      },
      body: JSON.stringify(body),
    });
    await result.text();
    return result.status;
  }
  const body = { model: 'multi/cursor/test', messages: [{ role: 'user', content: 'unchanged' }] };
  const hook = { session_id: 'one', hook_event_name: 'UserPromptSubmit', permission_mode: 'auto' };
  assert.equal(await post('/multi/mode', hook, undefined, 'wrong'), 403);
  assert.equal(await post('/v1/messages', body), 400);
  assert.equal(await post('/multi/mode', { ...hook, permission_mode: 'default' }), 200);
  assert.equal(
    await post('/multi/mode', {
      session_id: 'one',
      hook_event_name: 'SubagentStart',
      agent_id: 'worker',
      agent_type: 'coder',
      cwd: '/tmp',
    }),
    200,
  );
  assert.equal(await post('/v1/messages', body, 'worker'), 200);
  assert.equal(await post('/multi/mode', hook), 200);
  assert.equal(await post('/v1/messages', body, 'worker'), 200);
  assert.equal(await post('/v1/messages', body), 200);
  assert.equal(await post('/v1/messages', body, 'foreign'), 400);
  assert.deepEqual(observed, ['plan', 'auto', 'auto']);
  assert.deepEqual(delivered, observed);
  assert.equal(calls, 3);
});

test('submission fingerprints authorize only fresh main prompts without exposing their text', async () => {
  const modes = new PermissionModes(async () => ({ coder: {} }));
  const hook = {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'one',
    permission_mode: 'auto',
    prompt: 'private prompt',
  };
  await modes.record(hook);
  const first = modes.resolve('one');
  assert(first.submission);
  assert.match(first.submission.promptHash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(first), /private prompt/);
  await modes.record(hook);
  const second = modes.resolve('one');
  assert.notEqual(second.submission?.id, first.submission.id);
  assert.equal(second.submission?.promptHash, first.submission.promptHash);
  await modes.record({
    hook_event_name: 'SubagentStart',
    session_id: 'one',
    agent_id: 'worker',
    agent_type: 'coder',
    cwd: '/tmp',
  });
  assert.equal(modes.resolve('one', 'worker').submission, undefined);
  await assert.rejects(modes.record({ ...hook, permission_mode: 'invalid' }));
  assert.throws(() => modes.resolve('one'), /unavailable/);
});
