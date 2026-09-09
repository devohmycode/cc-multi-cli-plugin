import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import test from 'node:test';
import { approvalCapabilityGuard } from '../../plugins/multi-core/src/gateway/permission-hook.ts';
import type { GatewayFetch } from '../../plugins/multi-core/src/gateway/server.ts';
import {
  createOpenAIApproval,
  discoverOpenAIReviewer,
  inspectApprovalPath,
} from '../../plugins/multi-openai/src/approval.ts';

const request = (model = 'claude-sonnet-5') => ({
  model,
  metadata: { user_id: 'test-session' },
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: '<transcript>\n' },
        { type: 'text', text: `${JSON.stringify({ user: 'Run the workspace script.' })}\n` },
        { type: 'text', text: `${JSON.stringify({ Bash: 'node task.js' })}\n` },
        { type: 'text', text: '</transcript>\n' },
        { type: 'text', text: 'Stage 1 does NOT apply user intent <severity>N</severity>' },
      ],
    },
  ],
});
const context = {
  model: 'multi/openai/gpt-5.6-luna',
  scope: 'worker-one',
  request: { messages: [{ role: 'user', content: 'Run the workspace script.' }] },
};
const sse = (output: unknown[], status = 'completed') =>
  new Response(
    `data: ${JSON.stringify({ type: 'response.completed', response: { status, output } })}\n\n`,
  );
const verdict = (outcome = 'allow') => [
  { type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ outcome }) }] },
];

async function fixture(t: TestContext) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'approval-unit-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const authFile = path.join(cwd, 'auth.json');
  await writeFile(
    authFile,
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'fake-openai', account_id: 'test-account' },
    }),
  );
  return { cwd, authFile };
}

test('runtime reviewer investigates with bounded read-only tools and uses provider auth/policy', async (t) => {
  const { cwd, authFile } = await fixture(t);
  await writeFile(path.join(cwd, 'task.js'), 'console.log("safe")');
  const requests: { input: Record<string, string>[] }[] = [];
  const bridge = await createOpenAIApproval(
    authFile,
    path.join(cwd, 'old-cwd'),
    async (url, init) => {
      assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses');
      assert.equal(init.headers.authorization, 'Bearer fake-openai');
      const body = JSON.parse(String(init.body));
      requests.push(body);
      assert.equal(body.model, 'codex-auto-review');
      assert.deepEqual(
        body.tools.map((tool: { name: string }) => tool.name),
        ['inspect_path'],
      );
      assert(body.instructions.includes('Security Policy'));
      assert(!body.instructions.includes('MANUAL_ACCEPT'));
      if (requests.length === 1) {
        return sse([
          {
            type: 'function_call',
            name: 'inspect_path',
            call_id: 'inspect1',
            arguments: '{"path":"task.js"}',
          },
        ]);
      }
      assert.equal(JSON.parse(body.input.at(-1).output).content, 'console.log("safe")');
      return new Response(
        `data: ${JSON.stringify({ type: 'response.output_item.done', item: verdict()[0] })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [] } })}\n\n`,
      );
    },
  );
  const result = await bridge.respond(request(), new AbortController().signal, { ...context, cwd });
  assert.equal(result.outcome, 'allow');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].input[0].role, 'user');
  assert.deepEqual(JSON.parse(requests[0].input[0].content).original_request, context.request);
});

test('capability guard follows exact tool origin across model switches and workers', () => {
  const input = {
    permission_mode: 'auto',
    session_id: 'session',
    tool_name: 'Bash',
    tool_input: { command: 'pwd' },
  };
  const pending = {
    session: 'session',
    model: 'multi/openai/gpt-5.6-luna',
    name: 'Bash',
    input: input.tool_input,
  };
  assert.deepEqual(approvalCapabilityGuard(input, pending, ['openai']), {});
  assert.deepEqual(
    approvalCapabilityGuard(input, { ...pending, model: 'multi/cursor/composer-2.5' }, ['cursor']),
    {},
  );
  for (const result of [
    approvalCapabilityGuard(input, pending, []),
    approvalCapabilityGuard(input, { ...pending, model: 'multi/cursor/composer' }, ['openai']),
  ]) {
    assert.equal(result.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(
      result.hookSpecificOutput?.permissionDecisionReason ?? '',
      /Auto mode is unavailable/,
    );
  }
  for (const permission_mode of [
    'default',
    'acceptEdits',
    'plan',
    'dontAsk',
    'bypassPermissions',
  ]) {
    assert.deepEqual(approvalCapabilityGuard({ ...input, permission_mode }, undefined, []), {});
  }
  assert.deepEqual(
    approvalCapabilityGuard(
      { ...input, tool_input: { ...input.tool_input, run_in_background: false } },
      pending,
      ['openai'],
    ),
    {},
  );
  assert.equal(
    approvalCapabilityGuard({ ...input, session_id: 'another-worker' }, pending, ['openai'])
      .hookSpecificOutput?.permissionDecision,
    'deny',
  );
});

test('reviewer errors, invalid output, foreign providers, and exhausted investigation cannot approve', async (t) => {
  const { cwd, authFile } = await fixture(t);
  for (const fetchImpl of [
    async () => new Response('unavailable', { status: 503 }),
    async () => sse(verdict('perhaps')),
    async () => sse([null]),
    async () => new Response('data: null\n\ndata: [DONE]\n\n'),
    async () => sse(verdict(), 'incomplete'),
    async () => sse([{ type: 'function_call', name: 'exec', call_id: 'bad', arguments: '{}' }]),
    async () =>
      sse([
        {
          type: 'function_call',
          name: 'inspect_path',
          call_id: 'read',
          arguments: '{"path":"missing"}',
        },
      ]),
  ] satisfies GatewayFetch[]) {
    const bridge = await createOpenAIApproval(authFile, cwd, fetchImpl);
    await assert.rejects(bridge.respond(request(), new AbortController().signal, context));
  }
  let calls = 0;
  const bridge = await createOpenAIApproval(authFile, cwd, async () => {
    calls++;
    return sse(verdict());
  });
  await assert.rejects(
    bridge.respond(request(), new AbortController().signal, {
      ...context,
      model: 'multi/cursor/auto',
    }),
  );
  await assert.rejects(bridge.respond(request(), new AbortController().signal));
  await assert.rejects(
    bridge.respond(request(), new AbortController().signal, { ...context, worker: true }),
  );
  await assert.rejects(
    bridge.respond(request(), new AbortController().signal, {
      ...context,
      request: { messages: [{ role: 'user', content: '界'.repeat(400000) }] },
    }),
  );
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(bridge.respond(request(), abort.signal, context));
  assert.equal(calls, 0);
});

test('investigation enforces filesystem boundary and truncation; discovery never substitutes models', async (t) => {
  const { cwd, authFile } = await fixture(t);
  await mkdir(path.join(cwd, 'workspace'));
  await writeFile(path.join(cwd, 'outside'), 'private');
  await symlink(path.join(cwd, 'outside'), path.join(cwd, 'workspace', 'escape'));
  await assert.rejects(inspectApprovalPath(path.join(cwd, 'workspace'), { path: 'escape' }));
  await assert.rejects(inspectApprovalPath(path.join(cwd, 'workspace'), { path: '../outside' }));
  await writeFile(path.join(cwd, 'workspace', 'large'), 'x'.repeat(40000));
  const data = await inspectApprovalPath(path.join(cwd, 'workspace'), { path: 'large' });
  assert(data && typeof data === 'object');
  assert('content' in data && typeof data.content === 'string');
  assert('truncated' in data);
  assert.equal(data.content.length, 32768);
  assert.equal(data.truncated, true);
  for (const [slug, expected] of [
    ['gpt-5.6-luna', false],
    ['codex-auto-review', true],
  ] as const) {
    assert.equal(
      await discoverOpenAIReviewer(authFile, async () => Response.json({ models: [{ slug }] })),
      expected,
    );
  }
  assert.equal(
    await discoverOpenAIReviewer(authFile, async () => new Response('', { status: 401 })),
    false,
  );
});
