import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApprovalContext } from '../../plugins/multi/src/gateway/approval.ts';
import { createCursorApproval } from '../../plugins/multi/src/providers/cursor/approval.ts';
import { cursorModelOptions } from '../../plugins/multi/src/providers/cursor/models.ts';

const models = cursorModelOptions([{ id: 'composer-2.5', displayName: 'Composer 2.5' }]);
const context: ApprovalContext = {
  model: models[0].model,
  scope: 'session/worker',
  cwd: process.cwd(),
  request: { messages: [{ role: 'user', content: 'Check the fixture' }] },
  worker: true,
  rootRequest: {
    messages: [{ role: 'user', content: 'Investigate the fixture without changing it' }],
  },
};
function request(action: Record<string, unknown> = { Bash: 'printf test' }, stage = 1) {
  return {
    model: 'claude-sonnet-5',
    metadata: { user_id: 'session' },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '<transcript>\n' },
          { type: 'text', text: `${JSON.stringify({ user: 'Check the fixture' })}\n` },
          { type: 'text', text: `${JSON.stringify(action)}\n` },
          { type: 'text', text: '</transcript>\n' },
          {
            type: 'text',
            text: `${stage === 1 ? 'Stage 1 does NOT apply user intent' : 'Review the classification process and follow it carefully.'}\n<severity>N</severity>`,
          },
        ],
      },
    ],
  };
}

test('Cursor native verdict uses its originating worker context and the existing classifier adapter', async () => {
  let calls = 0;
  const bridge = await createCursorApproval(models, process.cwd(), async (input) => {
    calls++;
    assert.deepEqual(input.selection, models[0].selection);
    assert.deepEqual(input.context, context);
    assert.equal(input.cwd, context.cwd);
    assert.deepEqual(input.action.action, { Bash: 'printf test' });
    return { model: 'cursor-auto-review', outcome: 'deny' };
  });
  const signal = new AbortController().signal;
  const denied = await bridge.respond(request(), signal, context);
  assert.equal(denied.outcome, 'deny');
  assert.deepEqual(denied.message.content, [{ type: 'text', text: '<severity>100</severity>' }]);
  const repeated = await bridge.respond(request(undefined, 2), signal, context);
  assert.equal(repeated.cached, true);
  assert.equal(calls, 1);
});

test('Cursor review rejects foreign providers, missing worker authority and unsupported actions before review', async () => {
  let calls = 0;
  const bridge = await createCursorApproval(models, process.cwd(), async () => {
    calls++;
    return { model: 'cursor-auto-review', outcome: 'allow' };
  });
  const signal = new AbortController().signal;
  for (const invalid of [
    undefined,
    { ...context, model: 'multi/openai/gpt-6-astra' },
    { ...context, rootRequest: undefined },
  ]) {
    await assert.rejects(bridge.respond(request(), signal, invalid));
  }
  await assert.rejects(
    bridge.respond(request({ Edit: { file_path: '/tmp/test' } }), signal, context),
    /Bash actions only/,
  );
  assert.equal(calls, 0);
});

test('Cursor review cannot accept generic model text or malformed verdicts as native approval', async () => {
  for (const verdict of [
    'allow',
    { model: 'composer-2.5', outcome: 'allow' },
    { model: 'cursor-auto-review', outcome: 'unknown' },
  ]) {
    const bridge = await createCursorApproval(models, process.cwd(), async () => verdict);
    await assert.rejects(
      bridge.respond(request(), new AbortController().signal, context),
      /no valid verdict/,
    );
  }
});
