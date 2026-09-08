import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApprovalContext } from '../../plugins/multi/src/gateway/approval.ts';
import { NativeApprovalBridge } from '../../plugins/multi/src/gateway/approval.ts';
import { createNativeGateway } from '../../plugins/multi/src/gateway/server.ts';

const request = (stage = 1, session = 'session-one', command = 'node harmless-test.js') => ({
  model: 'claude-sonnet-5',
  metadata: { user_id: session },
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: '<transcript>\n' },
        { type: 'text', text: `${JSON.stringify({ user: 'Run the harmless test.' })}\n` },
        { type: 'text', text: `${JSON.stringify({ Bash: command })}\n` },
        { type: 'text', text: '</transcript>\n' },
        {
          type: 'text',
          text:
            (stage === 1
              ? 'Stage 1 does NOT apply user intent'
              : 'Review the classification process and follow it carefully.') +
            '\n<severity>N</severity>',
        },
      ],
    },
  ],
});
const signal = () => new AbortController().signal;

test('native review preserves context, names actual provider, and never caches an allow', async () => {
  let calls = 0;
  const bridge = new NativeApprovalBridge(async (input) => {
    calls++;
    assert.deepEqual(input.action, { Bash: 'node harmless-test.js' });
    assert.deepEqual(input.transcript[0], { user: 'Run the harmless test.' });
    return { outcome: 'allow', model: 'codex-auto-review' };
  });
  const result = await bridge.respond(request(), signal());
  assert.equal(result.message.model, 'codex-auto-review');
  assert.equal(result.message.content[0].text, '<severity>0</severity>');
  await assert.rejects(bridge.respond(request(2), signal()), /no matching recent denial/);
  await bridge.respond(request(), signal());
  assert.equal(calls, 2);
});

test('second stage reuses only the same session and transcript denial, once', async () => {
  let calls = 0;
  const bridge = new NativeApprovalBridge(async () => {
    calls++;
    return { outcome: 'deny', model: 'codex-auto-review' };
  });
  await bridge.respond(request(), signal());
  await assert.rejects(bridge.respond(request(2, 'other-session'), signal()), /no matching/);
  await assert.rejects(
    bridge.respond(request(2, 'session-one', 'another-command'), signal()),
    /no matching/,
  );
  const changed = request(2);
  changed.messages[0].content[1].text = `${JSON.stringify({ user: 'New user instruction' })}\n`;
  await assert.rejects(bridge.respond(changed, signal()), /no matching/);
  const result = await bridge.respond(request(2), signal());
  assert.equal(result.cached, true);
  assert.equal(result.message.content[0].text, '<severity>100</severity>');
  assert.equal(calls, 1);
  await assert.rejects(bridge.respond(request(2), signal()), /no matching/);
});

test('ordinary inference and malformed classifier envelopes never reach reviewer', async () => {
  let calls = 0;
  const bridge = new NativeApprovalBridge(async () => {
    calls++;
    return { outcome: 'allow', model: 'codex-auto-review' };
  });
  const broken = request();
  broken.messages[0].content[2].text = 'not JSON';
  const future = request();
  const instruction = future.messages[0].content.at(-1);
  assert(instruction);
  instruction.text = 'Unknown protocol';
  for (const input of [
    { model: 'sonnet', messages: [{ role: 'user', content: 'hello' }] },
    { ...request(), metadata: undefined },
    { ...request(), stream: true },
    { ...request(), tools: [{}] },
    broken,
    future,
  ]) {
    await assert.rejects(bridge.respond(input, signal()));
  }
  assert.equal(calls, 0);
});

test('denial cache evicts the oldest action without allowing a second-stage review', async () => {
  const bridge = new NativeApprovalBridge(async () => ({
    outcome: 'deny',
    model: 'codex-auto-review',
  }));
  for (let index = 0; index < 65; index++) {
    await bridge.respond(request(1, 'session', `command-${index}`), signal());
  }
  await assert.rejects(
    bridge.respond(request(2, 'session', 'command-0'), signal()),
    /no matching recent denial/,
  );
  const retained = await bridge.respond(request(2, 'session', 'command-1'), signal());
  assert.equal(retained.outcome, 'deny');
  assert.equal(retained.cached, true);
});

test('review errors, malformed verdicts, and cancellation cannot create approval state', async () => {
  for (const review of [
    async () => {
      throw new Error('Reviewer unavailable');
    },
    async () => ({ model: '', outcome: 'allow' as const }),
  ]) {
    const bridge = new NativeApprovalBridge(review);
    await assert.rejects(bridge.respond(request(), signal()));
    await assert.rejects(bridge.respond(request(2), signal()), /no matching/);
  }
  const abort = new AbortController();
  const bridge = new NativeApprovalBridge(async () => {
    abort.abort();
    return { outcome: 'deny', model: 'codex-auto-review' };
  });
  await assert.rejects(bridge.respond(request(), abort.signal));
  await assert.rejects(bridge.respond(request(2), signal()), /no matching/);
});

test('opt-in gateway review never forwards Anthropic traffic; authentication still applies', async (t) => {
  let fetches = 0;
  let reviews = 0;
  const routes: string[] = [];
  const server = createNativeGateway({
    token: 'test-token',
    authFile: '/unused',
    approvalBridge: new NativeApprovalBridge(async () => {
      reviews++;
      return { model: 'codex-auto-review', outcome: 'allow' };
    }),
    onEvent: (event) => routes.push(event.route),
    fetchImpl: async () => {
      fetches++;
      throw new Error('Unexpected upstream request');
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const send = (body: unknown, token = 'test-token') =>
    fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-multi-gateway-token': token },
      body: JSON.stringify(body),
    });
  assert.equal((await send(request(), 'wrong')).status, 403);
  const response = await send(request());
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { model: string }).model, 'codex-auto-review');
  // Claude retries a failed Sonnet classifier using the working model ID.
  assert.equal((await send({ ...request(), model: 'multi/openai/gpt-5.6-luna' })).status, 200);
  assert(
    (await send({ model: 'sonnet', messages: [{ role: 'user', content: 'hello' }] })).status >= 400,
  );
  assert.deepEqual(routes, ['approval', 'approval']);
  assert.equal(reviews, 2);
  assert.equal(fetches, 0);
});

test('Claude-authenticated review cannot retry through ordinary external inference', async (t) => {
  const upstream: string[] = [];
  const server = createNativeGateway({
    token: 'test-token',
    authFile: '/unused',
    blockAnthropic: false,
    guardAuto: false,
    fetchImpl: async (url) => {
      upstream.push(url);
      return Response.json({ model: 'claude-sonnet-5' });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const send = (model: string) =>
    fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-multi-gateway-token': 'test-token' },
      body: JSON.stringify({ ...request(), model }),
    });
  for (const model of ['multi/openai/gpt-5.6-luna', 'multi/cursor/composer-2.5']) {
    const response = await send(model);
    assert.equal(response.status, 400);
    assert.match(await response.text(), /cannot use ordinary external inference/);
  }
  assert.deepEqual(upstream, []);
  assert.equal((await send('claude-sonnet-5')).status, 200);
  assert.deepEqual(upstream, ['https://api.anthropic.com/v1/messages']);
});

test('gateway isolates review context by worker and blocks classifier fallback from ordinary inference', async (t) => {
  const seen: string[] = [];
  let fetches = 0;
  const bridge = new NativeApprovalBridge(async (_input, _signal, context) => {
    if (!context) {
      throw new Error('Missing worker context');
    }
    seen.push(`${context.model}:${context.scope}`);
    return { model: 'codex-auto-review', outcome: 'allow' };
  });
  const server = createNativeGateway({
    token: 'token',
    authFile: '/missing',
    approvalBridge: bridge,
    fetchImpl: async () => {
      fetches++;
      throw new Error('No inference allowed in test');
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const send = (body: unknown, worker: string) =>
    fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: 'POST',
      headers: { 'x-multi-gateway-token': 'token', 'x-claude-code-agent-id': worker },
      body: JSON.stringify(body),
    });
  const inference = {
    model: 'multi/openai/gpt-5.6-luna',
    metadata: { user_id: 'session-one' },
    messages: [{ role: 'user', content: 'Work' }],
    tools: [{ name: 'Bash', input_schema: { type: 'object', properties: {} } }],
  };
  // Missing inference auth stops upstream access, while exercising independent request contexts.
  await send(inference, 'worker-a');
  assert.equal((await send(request(), 'worker-b')).status, 502);
  assert.equal((await send({ ...request(), model: inference.model }, 'worker-a')).status, 200);
  assert.equal(seen.length, 1);
  assert(seen[0].includes('worker-a'));
  await send({ ...inference, model: 'multi/cursor/auto' }, 'worker-b');
  await send(request(), 'worker-b');
  assert(seen[1].startsWith('multi/cursor/auto:'));
  assert.equal(fetches, 0);
});

test('headerless classifier uses pending worker context and rejects ambiguous actions', async (t) => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const dir = await mkdtemp('/tmp/approval-scope-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    `${dir}/auth.json`,
    JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'fake', account_id: 'fake' } }),
  );
  const contexts: ApprovalContext[] = [];
  let next = { id: 'tool-a', command: 'node a.js' };
  const server = createNativeGateway({
    token: 'token',
    authFile: `${dir}/auth.json`,
    guardAuto: true,
    approvalBridge: new NativeApprovalBridge(async (_input, _signal, context) => {
      assert(context);
      contexts.push(context);
      return { model: 'codex-auto-review', outcome: 'allow' };
    }),
    fetchImpl: async () => {
      const item = {
        type: 'function_call',
        call_id: next.id,
        name: 'Bash',
        arguments: JSON.stringify({ command: next.command }),
      };
      return new Response(
        [
          { type: 'response.created', response: { id: 'response' } },
          { type: 'response.output_item.added', output_index: 0, item },
          { type: 'response.output_item.done', output_index: 0, item },
          {
            type: 'response.completed',
            response: { id: 'response', usage: { input_tokens: 1, output_tokens: 1 } },
          },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(''),
      );
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const send = (body: unknown, endpoint = '/v1/messages', worker?: string) =>
    fetch(`http://127.0.0.1:${address.port}${endpoint}`, {
      method: 'POST',
      headers: {
        'x-multi-gateway-token': 'token',
        ...(worker ? { 'x-claude-code-agent-id': worker } : {}),
      },
      body: JSON.stringify(body),
    });
  const session = JSON.stringify({ session_id: 'session-one' });
  const prepare = async (
    worker: string,
    command: string,
    permissionMode = 'auto',
    pendingCommand = command,
    cwd = dir,
  ) => {
    next = { id: `tool-${worker}`, command: pendingCommand };
    const inference = await send(
      {
        model: 'multi/openai/gpt-5.6-luna',
        metadata: { user_id: session },
        messages: [{ role: 'user', content: worker }],
        tools: [
          {
            name: 'Bash',
            input_schema: { type: 'object', properties: { command: { type: 'string' } } },
          },
        ],
      },
      '/v1/messages',
      worker,
    );
    assert.equal(inference.status, 200);
    await inference.json();
    const guard = await send(
      {
        session_id: 'session-one',
        tool_use_id: `tool-${worker}`,
        tool_name: 'Bash',
        tool_input: { command: pendingCommand },
        cwd,
        permission_mode: permissionMode,
      },
      '/multi/permission',
    );
    assert.deepEqual(await guard.json(), {});
  };
  await prepare('worker-a', 'node a.js');
  await prepare('worker-b', 'node b.js', 'plan', `cd ${dir} && node b.js`);
  assert.equal(contexts.length, 0, 'Permission hooks must never invoke review');
  assert.equal((await send(request(1, session, 'node b.js'))).status, 200);
  assert(contexts[0].scope.includes('worker-b'));
  assert.equal(contexts[0].cwd, dir);
  assert.equal(contexts[0].request.messages?.[0].content, 'worker-b');
  await prepare('worker-b', 'node b.js', 'plan', 'cd /other-workspace && node b.js');
  assert.equal((await send(request(1, session, 'node b.js'))).status, 400);
  await prepare(
    'worker-b',
    'node b.js',
    'plan',
    'cd /tmp/unsafe;pwd && node b.js',
    '/tmp/unsafe;pwd',
  );
  assert.equal((await send(request(1, session, 'node b.js'))).status, 400);
  await prepare('worker-b', 'node b.js', 'plan', `cd ${dir} && node b.js`);
  assert.equal((await send(request(1, session, 'node b.js'))).status, 200);
  await prepare('worker-a', 'node b.js');
  assert.equal((await send(request(1, session, 'node b.js'))).status, 400);
  assert.equal(contexts.length, 2);
});
