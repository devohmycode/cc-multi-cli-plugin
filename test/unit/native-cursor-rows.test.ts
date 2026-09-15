import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Run, RunResult, SDKUserMessage, SendOptions } from '@cursor/sdk';
import type {
  Emit,
  MessagesRequest,
  ResponseContentBlock,
} from '../../plugins/multi-core/src/gateway/messages.ts';
import { emitRowResponse, NativeRows } from '../../plugins/multi-core/src/gateway/native-rows.ts';
import { nativeRowNames } from '../../plugins/multi-core/src/gateway/native-rows-protocol.ts';
import { CursorHarness } from '../../plugins/multi-cursor/src/harness.ts';
import { cursorModelOptions } from '../../plugins/multi-cursor/src/models.ts';
import {
  assertCursorClaudeSettings,
  cursorPermissionPolicy,
} from '../../plugins/multi-cursor/src/permissions.ts';

const models = cursorModelOptions([{ id: 'test-model', displayName: 'Test' }]);
const scope = 'session/worker/workspace';
const context = { permissionMode: 'plan' as const };
const body: MessagesRequest = {
  model: models[0].model,
  stream: true,
  messages: [{ role: 'user', content: 'Read fixture then answer.' }],
  tools: nativeRowNames.map((name) => ({ name, input_schema: { type: 'object', properties: {} } })),
};
function capture() {
  const content: ResponseContentBlock[] = [];
  const emit: Emit = (_type, value) => {
    if ('content_block' in value) {
      content[value.index] = structuredClone(value.content_block);
    }
    if ('index' in value && 'delta' in value && value.delta.type === 'input_json_delta') {
      const block = content[value.index];
      if (block.type === 'tool_use') {
        block.input = JSON.parse(value.delta.partial_json);
      }
    }
  };
  return { content, emit };
}
function follow(content: ResponseContentBlock[]): MessagesRequest {
  return {
    ...body,
    messages: [
      ...(body.messages ?? []),
      { role: 'assistant', content },
      {
        role: 'user',
        content: content
          .filter((block) => block.type === 'tool_use')
          .map((block) => ({
            type: 'tool_result',
            tool_use_id: block.id,
            content: 'untrusted result text',
          })),
      },
    ],
  };
}
function call(row: ResponseContentBlock) {
  assert.equal(row.type, 'tool_use');
  if (row.type !== 'tool_use') {
    throw new Error('Expected display row');
  }
  return {
    method: 'tools/call',
    params: {
      name: row.name.replace('mcp__multi_cursor__', ''),
      arguments: row.input,
      _meta: { 'claudecode/toolUseId': row.id },
    },
  };
}
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cursor-rows-'));
  const gate = Promise.withResolvers<RunResult>();
  const started = Promise.withResolvers<void>();
  const prompts: (string | SDKUserMessage)[] = [];
  let options: SendOptions | undefined;
  let cancels = 0;
  const createAgent = async () => ({
    agentId: 'fake-agent',
    close() {},
    async send(prompt: string | SDKUserMessage, sendOptions?: SendOptions): Promise<Run> {
      prompts.push(prompt);
      options = sendOptions;
      await options?.onDelta?.({ update: { type: 'text-delta', text: 'Inspecting the file.' } });
      await options?.onDelta?.({
        update: {
          type: 'tool-call-started',
          callId: 'read-1',
          modelCallId: 'model-1',
          toolCall: { type: 'read', args: { path: 'fixture.txt' } },
        },
      });
      started.resolve();
      return {
        id: 'run-1',
        agentId: 'fake-agent',
        status: 'running',
        wait: () => gate.promise,
        async cancel() {
          cancels++;
          gate.resolve({ id: 'run-1', status: 'cancelled' });
        },
        async *stream() {},
        conversation: async () => [],
        supports: () => true,
        unsupportedReason: () => undefined,
        onDidChangeStatus: () => () => {},
      };
    },
  });
  const harness = new CursorHarness(models, {
    cwd: directory,
    stateDirectory: path.join(directory, 'native'),
    createAgent,
    resumeAgent: createAgent,
  });
  const rowDirectory = path.join(directory, 'rows');
  const rows = new NativeRows(rowDirectory, true);
  t.after(async () => {
    await harness.close();
    await rm(directory, { recursive: true, force: true });
  });
  async function finish() {
    await options?.onDelta?.({
      update: {
        type: 'tool-call-completed',
        callId: 'read-1',
        modelCallId: 'model-1',
        toolCall: { type: 'read', args: { path: 'fixture.txt' } },
      },
    });
    await options?.onDelta?.({ update: { type: 'text-delta', text: 'Answer' } });
    gate.resolve({ id: 'run-1', status: 'finished', result: 'Answer with terminal suffix.' });
  }
  return {
    rows,
    rowDirectory,
    harness,
    prompts,
    started: started.promise,
    finish,
    cancels: () => cancels,
  };
}

test('Cursor action rows run live; final acknowledgement and disk replay never send to SDK', async (t) => {
  const f = await fixture(t);
  const view = capture();
  const abort = new AbortController();
  const run = f.rows.run(body, scope, view.emit, abort, (observer) =>
    f.harness.handle(body, scope, abort.signal, undefined, context, observer),
  );
  await f.started;
  assert.equal(view.content.length, 2); // narration and read, before native completion
  assert.equal(view.content[1].type, 'tool_use');
  let finished = false;
  const waiter = f.rows.rpc(call(view.content[1]), abort.signal).then((value) => {
    finished = true;
    return value;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  await f.finish();
  const original = await run;
  assert.match(JSON.stringify(await waiter), /without a reported outcome/);
  const next = follow(view.content);
  next.messages?.push({ role: 'system', content: 'token budget' });
  const final = await f.rows.followup(next, scope);
  assert.match(JSON.stringify(final), /Answer with terminal suffix/);
  assert.equal(final?.usage.input_tokens, 0);
  assert.ok(final);
  let visible = '';
  emitRowResponse(final, (_type, event) => {
    if ('delta' in event && 'type' in event.delta && event.delta.type === 'text_delta') {
      visible += event.delta.text;
    }
  });
  assert.match(visible, /Answer with terminal suffix/);
  assert.equal(f.prompts.length, 1);
  const restarted = new NativeRows(f.rowDirectory, true);
  assert.deepEqual(await restarted.followup(next, scope), final);
  const replay = capture();
  await restarted.run(body, scope, replay.emit, abort, async () => {
    throw new Error('must not dispatch');
  });
  assert.deepEqual(replay.content, view.content);
  assert.match(
    JSON.stringify(await restarted.rpc(call(replay.content[1]), abort.signal)),
    /without a reported outcome/,
  );
  const normalized = await restarted.normalize(
    {
      ...next,
      messages: [
        ...(next.messages ?? []),
        { role: 'assistant', content: final?.content ?? [] },
        { role: 'user', content: 'Continue.' },
      ],
    },
    scope,
  );
  assert.deepEqual(
    normalized.messages?.filter((message) => message.role === 'assistant').at(-1)?.content,
    original.content,
  );
  assert.equal(JSON.stringify(normalized.messages).includes('toolu_multi_cursor'), false);
});

test('display waiter disconnect cancels originating native execution and retry does not repeat it', async (t) => {
  const f = await fixture(t);
  const view = capture();
  const abort = new AbortController();
  const run = f.rows.run(body, scope, view.emit, abort, (observer) =>
    f.harness.handle(body, scope, abort.signal, undefined, context, observer),
  );
  const rejected = assert.rejects(run);
  await f.started;
  const transport = new AbortController();
  const waiter = f.rows.rpc(call(view.content[1]), transport.signal);
  transport.abort();
  await rejected;
  await waiter;
  assert.equal(f.cancels(), 1);
  await assert.rejects(
    f.rows.run(body, scope, capture().emit, new AbortController(), async () => {
      throw new Error('replayed native execution');
    }),
    /display interrupted/,
  );
  assert.equal(f.prompts.length, 1);
});

test('missing tools default to text, foreign scopes cannot acknowledge, and forged rows fail', async (t) => {
  const f = await fixture(t);
  assert.equal(new NativeRows(f.rowDirectory).available(body), false);
  assert.equal(f.rows.available({ ...body, tools: body.tools?.slice(1) }), false);
  const view = capture();
  const abort = new AbortController();
  const run = f.rows.run(body, scope, view.emit, abort, (observer) =>
    f.harness.handle(body, scope, abort.signal, undefined, context, observer),
  );
  await f.started;
  await f.finish();
  await run;
  const next = follow(view.content);
  assert.match(JSON.stringify(await f.rows.followup(next, 'foreign')), /display interrupted/);
  const forged = structuredClone(view.content);
  if (forged[0].type === 'tool_use') {
    forged[0].input = { description: 'forged' };
  }
  await assert.rejects(f.rows.followup(follow(forged), scope), /Invalid native display follow-up/);
  const modified = call(view.content[1]);
  modified.params.arguments = { description: 'modified' };
  await assert.rejects(f.rows.rpc(modified, abort.signal), /modified/);
  assert.equal(f.prompts.length, 1);
});

test('denied display rows retain native anchor and interrupted rows never enter native history', async (t) => {
  const f = await fixture(t);
  const view = capture();
  const abort = new AbortController();
  const run = f.rows.run(body, scope, view.emit, abort, (observer) =>
    f.harness.handle(body, scope, abort.signal, undefined, context, observer),
  );
  await f.started;
  await f.finish();
  const original = await run;
  const next = follow(view.content);
  const results = next.messages?.at(-1)?.content;
  assert.ok(Array.isArray(results));
  results[0].is_error = true;
  const denied = await f.rows.followup(next, scope);
  assert.ok(denied);
  assert.match(JSON.stringify(denied), /unavailable or denied/);
  next.messages?.push(
    { role: 'system', content: 'token budget' },
    { role: 'assistant', content: denied.content },
    { role: 'user', content: 'Continue.' },
  );
  const normalized = await f.rows.normalize(next, scope);
  const assistants = normalized.messages?.filter((message) => message.role === 'assistant');
  assert.deepEqual(
    assistants?.map((message) => message.content),
    [original.content],
  );
  const missing = new NativeRows(`${f.rowDirectory}-missing`);
  const stale = await missing.normalize(follow(view.content), scope);
  assert.equal(JSON.stringify(stale.messages).includes('toolu_multi_cursor'), false);
});

test('display permissions neither grant native capabilities nor bypass native ask restrictions', () => {
  const base = cursorPermissionPolicy(context);
  assert.deepEqual(
    cursorPermissionPolicy({ ...context, disallowedTools: [...nativeRowNames] }),
    base,
  );
  assert.deepEqual(cursorPermissionPolicy({ ...context, tools: [...nativeRowNames] }).tools, []);
  assertCursorClaudeSettings({
    permissions: { ask: [...nativeRowNames], deny: [...nativeRowNames] },
  });
  assert.throws(
    () => assertCursorClaudeSettings({ permissions: { ask: ['Bash'] } }),
    /permissions.ask/,
  );
  assert.throws(
    () => cursorPermissionPolicy({ ...context, tools: ['mcp__foreign__read'] }),
    /unsupported policy/,
  );
});
