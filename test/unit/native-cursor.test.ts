import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentOptions, Run, RunResult, SDKUserMessage } from '@cursor/sdk';
import { CursorBridge } from '../../plugins/multi/scripts/lib/native-cursor.ts';
import type { CreateCursorAgent } from '../../plugins/multi/scripts/lib/native-cursor.ts';
import { cursorModelOptions, cursorSelection } from '../../plugins/multi/scripts/lib/native-cursor-models.ts';
import { createNativeGateway } from '../../plugins/multi/scripts/lib/native-gateway.ts';
import type { MessagesRequest, MessagesResponse, ResponseContentBlock, Emit } from '../../plugins/multi/scripts/lib/native-responses.ts';

const options = cursorModelOptions([{ id: 'test-model', displayName: 'Test Model', parameters: [
  { id: 'effort', values: [{ value: 'low' }, { value: 'high' }] }
], variants: [{ params: [{ id: 'effort', value: 'low' }], displayName: 'Low', isDefault: true }] }]);
const model = options[0].model;
const body: MessagesRequest = { model, messages: [{ role: 'user', content: 'Read then edit fixture.txt' }],
  tools: [{ name: 'Read', input_schema: { type: 'object' } }, { name: 'Edit', input_schema: { type: 'object' } }] };
const signal = () => AbortSignal.timeout(3000);
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const calls = (r: MessagesResponse) => r.content.filter((b): b is Extract<ResponseContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
function follow(request: MessagesRequest, response: MessagesResponse, text = 'Tool succeeded'): MessagesRequest {
  return { ...request, messages: [...request.messages!, { role: 'assistant', content: response.content },
    { role: 'user', content: calls(response).map(call => ({ type: 'tool_result', tool_use_id: call.id, content: text })) }] };
}

function runtime(play: (config: AgentOptions, text: (value: string) => void, aborted: AbortSignal) => Promise<string>) {
  const configs: AgentOptions[] = [], prompts: (string | SDKUserMessage)[] = [];
  let cancelled = 0, closed = 0;
  const createAgent: CreateCursorAgent = async config => {
    configs.push(config);
    return { close: () => { closed++; }, send: async (message, sendOptions) => {
      prompts.push(message);
      const abort = new AbortController();
      const result = Promise.withResolvers<RunResult>();
      let status: Run['status'] = 'running';
      const run: Run = { id: `run-${configs.length}`, agentId: `agent-${configs.length}`, get status() { return status; },
        wait: () => result.promise, cancel: async () => { cancelled++; abort.abort(); status = 'cancelled'; result.resolve({ id: run.id, status }); },
        async *stream() {}, conversation: async () => [], supports: () => true, unsupportedReason: () => undefined,
        onDidChangeStatus: () => () => {} };
      void Promise.resolve().then(() => play(config, text => { void sendOptions?.onDelta?.({ update: { type: 'text-delta', text } }); }, abort.signal))
        .then(text => { status = 'finished'; result.resolve({ id: run.id, status, result: text }); }, error => {
          status = 'error'; result.resolve({ id: run.id, status, error: { message: String(error.message) } });
        });
      return run;
    } };
  };
  return { createAgent, configs, prompts, get cancelled() { return cancelled; }, get closed() { return closed; } };
}

test('Cursor catalog preserves actual IDs and presets; effort never silently substitutes', () => {
  assert.equal(options[0].worker, 'cursor-test-model');
  assert.deepEqual(cursorSelection(options[0], 'high'), { id: 'test-model', params: [{ id: 'effort', value: 'high' }] });
  assert.throws(() => cursorSelection(options[0], 'ultracode'), /supports effort/);
  assert.equal(cursorSelection(options[1], 'high').params?.[0].value, 'low');
  assert.deepEqual(cursorModelOptions([{ id: 'auto-smart', displayName: 'Router' }]), []);
});

test('catalog cross-products stay selectable without multiplying named workers', () => {
  const catalog = cursorModelOptions([{ id: 'composer-test', displayName: 'Composer', variants: [
    { displayName: 'Default', isDefault: true, params: [{ id: 'effort', value: 'low' }, { id: 'fast', value: 'false' }] },
    { displayName: 'High', params: [{ id: 'effort', value: 'high' }, { id: 'fast', value: 'false' }] },
    { displayName: 'High Fast', params: [{ id: 'effort', value: 'high' }, { id: 'fast', value: 'true' }] }
  ] }]);
  assert.equal(catalog.length, 4);
  assert.deepEqual(catalog.filter(o => o.nativeWorker).map(o => o.worker), ['cursor-composer-test', 'cursor-composer-test-effort-high']);
  assert(catalog.some(o => o.model.includes('fast=true')));
});

test('Cursor callback waits for Claude result, streams text, and replays HTTP retries without new runs', async t => {
  let readResult: unknown, editResult: unknown;
  const fake = runtime(async (config, text) => {
    text('Reading.');
    readResult = await config.local!.customTools!.Read.execute({ file_path: 'fixture.txt' }, { toolCallId: 'read' });
    editResult = await config.local!.customTools!.Edit.execute({ old_string: 'alpha', new_string: 'beta' }, { toolCallId: 'edit' });
    text('Done.');
    return 'Done.';
  });
  const bridge = new CursorBridge(options, fake);
  t.after(() => bridge.close());
  const events: string[] = [];
  const first = await bridge.handle(body, 'session/worker', signal(), (name) => { events.push(name); });
  assert.equal(readResult, undefined, 'SDK remains paused before Claude executes Read');
  assert.deepEqual(calls(first).map(b => b.name), ['Read']);
  assert.equal(events.at(-1), 'message_stop');
  assert(events.includes('content_block_delta'));
  assert.deepEqual(await bridge.handle({ ...body, stream: true }, 'session/worker', signal()), first);
  const secondRequest = follow(body, first, 'alpha');
  const second = await bridge.handle(secondRequest, 'session/worker', signal());
  assert.deepEqual(readResult, { content: [{ type: 'text', text: 'alpha' }], isError: false });
  assert.equal(editResult, undefined);
  assert.deepEqual(calls(second).map(b => b.name), ['Edit']);
  const done = await bridge.handle(follow(secondRequest, second), 'session/worker', signal());
  assert.equal(done.stop_reason, 'end_turn');
  assert.deepEqual(done.content, [{ type: 'text', text: 'Done.' }]);
  assert.equal(fake.configs.length, 1);
  assert.deepEqual(fake.configs[0].tools, ['mcp']);
  assert.deepEqual(fake.configs[0].mcpServers, {});
  assert.deepEqual(fake.configs[0].local!.settingSources, []);
  assert.equal(fake.configs[0].local!.enableAgentRetries, false);
  assert.equal(fake.configs[0].systemPrompt, undefined, 'No account-gated system prompt override');
  assert.equal(fake.closed, 1);
});

test('simultaneous retries share an in-flight request', async t => {
  const fake = runtime(async () => { await tick(); return 'one'; });
  const bridge = new CursorBridge(options, fake); t.after(() => bridge.close());
  const [one, two] = await Promise.all([bridge.handle(body, 'same', signal()), bridge.handle(body, 'same', signal())]);
  assert.deepEqual(one, two);
  assert.equal(fake.configs.length, 1);
});

test('late parallel callbacks are delivered once and retain their own results', async t => {
  let values: unknown[] = [];
  const fake = runtime(async config => {
    const one = config.local!.customTools!.Read.execute({ file_path: 'a' }, { toolCallId: 'a' });
    await tick();
    const two = config.local!.customTools!.Read.execute({ file_path: 'b' }, { toolCallId: 'b' });
    values = await Promise.all([one, two]);
    return 'Both read';
  });
  const bridge = new CursorBridge(options, fake); t.after(() => bridge.close());
  const one = await bridge.handle(body, 'parallel', signal());
  await tick();
  const req = follow(body, one, 'A');
  const two = await bridge.handle(req, 'parallel', signal());
  assert.notEqual(calls(one)[0].id, calls(two)[0].id);
  const done = await bridge.handle(follow(req, two, 'B'), 'parallel', signal());
  assert.equal(done.stop_reason, 'end_turn');
  assert.deepEqual(values, ['A', 'B'].map(text => ({ content: [{ type: 'text', text }], isError: false })));
});

test('permission denial is returned as an error; a different worker cannot settle the callback', async t => {
  let value: unknown;
  const fake = runtime(async config => {
    value = await config.local!.customTools!.Edit.execute({}, { toolCallId: 'edit' });
    return 'Permission denied';
  });
  const bridge = new CursorBridge(options, fake); t.after(() => bridge.close());
  const first = await bridge.handle(body, 'owner', signal());
  const req = follow(body, first, 'Permission denied');
  const last = req.messages!.at(-1)!;
  assert(Array.isArray(last.content)); last.content[0].is_error = true;
  await assert.rejects(bridge.handle(req, 'other-worker', signal()), /mismatch/);
  assert.equal(value, undefined);
  await bridge.handle(req, 'owner', signal());
  assert.deepEqual(value, { content: [{ type: 'text', text: 'Permission denied' }], isError: true });
});

test('separate workers with identical prompts create isolated runs', async t => {
  const fake = runtime(async config => {
    await config.local!.customTools!.Read.execute({}, { toolCallId: 'same-sdk-id' }); return 'done';
  });
  const bridge = new CursorBridge(options, fake); t.after(() => bridge.close());
  const [a, b] = await Promise.all(['a', 'b'].map(scope => bridge.handle(body, scope, signal())));
  assert.notEqual(calls(a)[0].id, calls(b)[0].id);
  assert.equal(fake.configs.length, 2);
});

test('disconnect cancels inference and does not report completion', async t => {
  const fake = runtime(async (_config, _text, aborted) => {
    await new Promise<void>(resolve => aborted.addEventListener('abort', () => resolve(), { once: true })); return '';
  });
  const bridge = new CursorBridge(options, fake); t.after(() => bridge.close());
  const abort = new AbortController();
  const result = bridge.handle(body, 'cancel', abort.signal);
  await tick(); abort.abort();
  await assert.rejects(result);
  await tick();
  assert.equal(fake.cancelled, 1);
  assert.equal(fake.closed, 1);
});

test('closing the gateway cancels SDK callbacks waiting between HTTP requests', async () => {
  const fake = runtime(async config => { await config.local!.customTools!.Edit.execute({}, {}); return 'done'; });
  const bridge = new CursorBridge(options, fake);
  await bridge.handle(body, 'waiting', signal());
  await bridge.close();
  assert.equal(fake.cancelled, 1);
  assert.equal(fake.closed, 1);
});

test('SDK failure after partial text remains an explicit failure', async t => {
  const fake = runtime(async (_config, text) => { text('Partial'); await tick(); throw new Error('SDK failed'); });
  const bridge = new CursorBridge(options, fake); t.after(() => bridge.close());
  const events: string[] = [];
  await assert.rejects(bridge.handle(body, 'fail', signal(), name => { events.push(name); }), /SDK failed/);
  assert(events.includes('content_block_delta'));
  assert(!events.includes('message_stop'));
});

test('restart and compacted history start from the supplied Claude transcript', async t => {
  const fake = runtime(async () => 'Continued without executing anything');
  const bridge = new CursorBridge(options, fake); t.after(() => bridge.close());
  const history: MessagesRequest = { ...body, messages: [
    { role: 'user', content: 'Compacted summary: fixture has been edited to beta.' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'cursor_old', name: 'Edit', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'cursor_old', content: 'Already edited to beta' }] }
  ] };
  await bridge.handle(history, 'resumed', signal());
  assert(JSON.stringify(fake.prompts[0]).includes('Already edited to beta'));
  assert(JSON.stringify(fake.prompts[0]).includes('never repeat'));
});

test('validation rejects unsupported features and counts without SDK inference', () => {
  const fake = runtime(async () => 'unused');
  const bridge = new CursorBridge(options, fake);
  assert(bridge.validate(body) > 0);
  for (const invalid of [ { ...body, model: 'multi/cursor/missing' }, { ...body, stop_sequences: ['STOP'] },
    { ...body, tool_choice: { type: 'any' } }, { ...body, output_format: { type: 'json_schema', schema: {} } } ]) {
    assert.throws(() => bridge.validate(invalid));
  }
  assert.equal(fake.configs.length, 0);
});

test('moving Claude cache markers does not invalidate a tool continuation; edited history does', async t => {
  const fake = runtime(async config => { await config.local!.customTools!.Read.execute({}, { toolCallId: 'read' }); return 'done'; });
  const bridge = new CursorBridge(options, fake); t.after(() => bridge.close());
  const request: MessagesRequest = { ...body, messages: [{ role: 'user', content: [{ type: 'text', text: 'Read', cache_control: { type: 'ephemeral' } }] }] };
  const first = await bridge.handle(request, 'cache', signal());
  const next = follow(request, first);
  next.messages = structuredClone(next.messages);
  const content = next.messages![0].content; assert(Array.isArray(content)); delete content[0].cache_control;
  const edited = structuredClone(next); const changed = edited.messages![0].content; assert(Array.isArray(changed)); changed[0].text = 'Different branch';
  await assert.rejects(bridge.handle(edited, 'cache', signal()), /different conversation branch/);
  assert.equal((await bridge.handle(next, 'cache', signal())).stop_reason, 'end_turn');
});

test('duplicate SDK callback IDs reuse a single native tool request', async t => {
  let results: unknown[] = [];
  const fake = runtime(async config => {
    const tool = config.local!.customTools!.Read;
    results = await Promise.all([tool.execute({}, { toolCallId: 'same' }), tool.execute({}, { toolCallId: 'same' })]);
    return 'done';
  });
  const bridge = new CursorBridge(options, fake); t.after(() => bridge.close());
  const first = await bridge.handle(body, 'dedupe', signal());
  assert.equal(calls(first).length, 1);
  await bridge.handle(follow(body, first), 'dedupe', signal());
  assert.deepEqual(results[0], results[1]);
});

test('tool_choice none prevents every SDK execution tool, and prompt images stay attachments', async t => {
  const fake = runtime(async () => 'image received');
  const bridge = new CursorBridge(options, fake); t.after(() => bridge.close());
  await bridge.handle({ ...body, tool_choice: { type: 'none' }, messages: [{ role: 'user', content: [
    { type: 'text', text: 'Describe this' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'cGl4ZWxz' } }
  ] }] }, 'image', signal());
  assert.deepEqual(fake.configs[0].tools, []);
  assert.deepEqual(Object.keys(fake.configs[0].local!.customTools!), []);
  const prompt = fake.prompts[0]; assert(typeof prompt !== 'string');
  assert.deepEqual(prompt.images, [{ data: 'cGl4ZWxz', mimeType: 'image/png' }]);
});

test('long tool names and image/error results survive the callback boundary', async t => {
  const name = 'mcp__' + 'long'.repeat(25);
  let returned: unknown;
  const fake = runtime(async config => {
    returned = await Object.values(config.local!.customTools!)[0].execute({}, { toolCallId: 'image' }); return 'done';
  });
  const bridge = new CursorBridge(options, fake); t.after(() => bridge.close());
  const request = { ...body, tools: [{ name, input_schema: { type: 'object' } }] };
  const first = await bridge.handle(request, 'image-result', signal());
  assert.equal(calls(first)[0].name, name);
  const next = follow(request, first);
  const result = next.messages!.at(-1)!.content; assert(Array.isArray(result));
  result[0].is_error = true;
  result[0].content = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'cGl4ZWxz' } }];
  await bridge.handle(next, 'image-result', signal());
  assert.deepEqual(returned, { isError: true, content: [{ type: 'image', data: 'cGl4ZWxz', mimeType: 'image/png' }] });
});

test('Cursor HTTP route keeps Claude credentials away from SDK and emits Messages SSE', async t => {
  const fake = runtime(async (_config, text) => { text('Hello'); return 'Hello'; });
  const bridge = new CursorBridge(options, fake);
  const server = createNativeGateway({ token: 'local', authFile: '/does-not-exist', cursor: bridge,
    fetchImpl: async () => { throw new Error('Cursor must not use OpenAI or Anthropic fetch'); } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await bridge.close(); });
  const address = server.address(); assert(address && typeof address !== 'string');
  const request = (pathname: string, payload: unknown) => fetch(`http://127.0.0.1:${address.port}${pathname}`, {
    method: 'POST', headers: { 'x-multi-gateway-token': 'local', authorization: 'Bearer claude-secret' }, body: JSON.stringify(payload)
  });
  const count = await request('/v1/messages/count_tokens', body);
  assert.equal(count.status, 200); assert.equal(count.headers.get('x-multi-token-count'), 'estimate');
  assert.equal(fake.configs.length, 0);
  const response = await request('/v1/messages', { ...body, stream: true });
  assert.equal(response.status, 200);
  const sse = await response.text();
  assert(sse.includes('event: message_stop')); assert(sse.includes('Hello'));
  assert(!JSON.stringify(fake.configs).includes('claude-secret'));
});
