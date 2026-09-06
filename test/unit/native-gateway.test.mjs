import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNativeGateway, OPENAI_WORKERS } from '../../plugins/multi/scripts/lib/native-gateway.mjs';
import { toResponses, fromResponses, readSse, forAnthropic } from '../../plugins/multi/scripts/lib/native-responses.mjs';

const body = { model: 'multi/openai/gpt-6-astra', system: [{ type: 'text', text: 'Follow the task', cache_control: { type: 'ephemeral' } }],
  messages: [{ role: 'user', content: 'Read the fixture' }],
  tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } }] };
const sse = events => events.map(event => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join('');
const stream = events => new Response(sse(events)).body;
function events(item, deltas = []) {
  return [
    { type: 'response.created', response: { id: 'resp_test' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
    ...deltas.map(delta => ({ output_index: 0, ...delta })),
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp_test', usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 15 } } }
  ];
}
const textEvents = events({ type: 'message', content: [{ type: 'output_text', text: 'Done' }] },
  [{ type: 'response.output_text.delta', delta: 'Done' }]);

test('native conversion preserves tool IDs, error results, permissions text and tool choice', () => {
  const result = toResponses({ ...body, tool_choice: { type: 'tool', name: 'Read', disable_parallel_tool_use: true }, messages: [
    ...body.messages,
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: 'fixture' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', is_error: true, content: 'Permission denied' }] }
  ] }, 'gpt-6-astra');
  assert.equal(result.instructions, 'Follow the task');
  assert.equal(result.input[1].call_id, result.input[2].call_id);
  assert.equal(result.input[2].output, 'Tool error:\nPermission denied');
  assert.deepEqual(result.tool_choice, { type: 'function', name: 'Read' });
  assert.equal(result.parallel_tool_calls, false);
  assert.equal(result.store, false);
  assert.equal(result.tools[0].strict, false);
  assert.throws(() => toResponses({ ...body, messages: [{ role: 'user', content: [{ type: 'document' }] }] }, 'gpt'), /Unsupported/);
  assert.throws(() => toResponses({ ...body, tools: [{ type: 'web_search_20250305' }] }, 'gpt'), /Unsupported/);
});

test('Responses stream preserves native tool arguments, usage and stop reason', async () => {
  const sent = [];
  const item = { type: 'function_call', call_id: 'call_1', name: 'Read', arguments: '{"file_path":"fixture"}' };
  const result = await fromResponses(stream(events(item, [
    { type: 'response.function_call_arguments.delta', delta: '{"file_path":' },
    { type: 'response.function_call_arguments.delta', delta: '"fixture"}' }
  ])), body.model, (type, value) => sent.push({ type, ...value }));
  assert.equal(result.stop_reason, 'tool_use');
  assert.deepEqual(result.content[0].input, { file_path: 'fixture' });
  assert.equal(result.usage.input_tokens, 60);
  assert.equal(result.usage.cache_read_input_tokens, 40);
  assert.equal(sent.at(-1).type, 'message_stop');
  assert.equal(sent.filter(e => e.delta?.type === 'input_json_delta').map(e => e.delta.partial_json).join(''), item.arguments);
});

test('images retain their order and tool-result association across provider switches', () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'cGl4ZWxz' } };
  const remote = { type: 'image', source: { type: 'url', url: 'https://example.com/fixture.png' } };
  const request = { ...body, messages: [
    { role: 'user', content: [{ type: 'text', text: 'Compare' }, image, { type: 'text', text: 'with the tool image' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_image', name: 'Read', input: { file_path: 'fixture.png' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_image', is_error: true,
      content: [{ type: 'text', text: 'Partial screenshot' }, remote, { type: 'text', text: 'Capture timed out' }] }] }
  ] };
  const snapshot = structuredClone(request);
  const converted = toResponses(request, 'gpt');
  assert.deepEqual(converted.input.slice(0, 3).map(item => item.content[0].type), ['input_text', 'input_image', 'input_text']);
  assert.equal(converted.input[1].content[0].image_url, 'data:image/png;base64,cGl4ZWxz');
  assert.equal(converted.input[3].call_id, converted.input[4].call_id);
  assert.deepEqual(converted.input[4].output, [
    { type: 'input_text', text: 'Tool error:\n' }, { type: 'input_text', text: 'Partial screenshot' },
    { type: 'input_image', image_url: remote.source.url, detail: 'auto' }, { type: 'input_text', text: 'Capture timed out' }
  ]);
  assert.equal(forAnthropic(request), request);
  assert.deepEqual(request, snapshot, 'Conversion must not rewrite the stored transcript');
});

test('structured output keeps the schema intact for modern and legacy Anthropic formats', () => {
  const schema = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false };
  const format = { type: 'json_schema', schema };
  const modern = toResponses({ ...body, output_config: { format, effort: 'high' }, output_format: { type: 'ignored' } }, 'gpt');
  const legacy = toResponses({ ...body, output_format: format }, 'gpt');
  assert.deepEqual(modern.text, { format: { type: 'json_schema', name: 'claude_output', schema, strict: true } });
  assert.deepEqual(legacy.text, modern.text);
  assert.equal(modern.reasoning.effort, 'high');
  assert.equal(modern.text.format.schema, schema, 'Do not rewrite optional fields or schema constraints');
  assert.equal(toResponses(body, 'gpt').text, undefined);
});

test('malformed images and output formats fail before any provider call', async t => {
  const call = await gateway(t, () => assert.fail('Unexpected provider request'));
  for (const source of [undefined, { type: 'file', file_id: 'private-file' },
    { type: 'base64', media_type: 'image/svg+xml', data: 'cGl4ZWxz' },
    { type: 'base64', media_type: 'image/png', data: 'invalid?!' },
    { type: 'base64', media_type: 'image/png', data: '' },
    { type: 'url', url: 'file:///etc/passwd' }, { type: 'url', url: 'https://user:secret@example.com/image' }]) {
    const content = [{ type: 'image', source }];
    for (const value of [content, [{ type: 'tool_result', tool_use_id: 'call_image', content }]]) {
      assert.equal((await call({ ...body, messages: [{ role: 'user', content: value }] })).status, 400);
    }
  }
  for (const format of [false, { type: 'text' }, { type: 'json_schema' }, { type: 'json_schema', schema: [] }]) {
    assert.equal((await call({ ...body, output_config: { format } })).status, 400);
  }
  assert.equal((await call({ ...body, stop_sequences: ['STOP'] })).status, 400);
});

test('encrypted reasoning survives a tool round trip without a shared conversation cache', async () => {
  const item = { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Checking' }], encrypted_content: 'opaque-ciphertext' };
  const result = await fromResponses(stream(events(item, [{ type: 'response.reasoning_summary_text.delta', delta: 'Checking' }])), body.model);
  const converted = toResponses({ ...body, messages: [{ role: 'assistant', content: result.content }] }, 'gpt');
  assert.deepEqual(converted.input[0], item);
  assert.deepEqual(toResponses({ ...body, messages: [{ role: 'assistant', content: [
    { type: 'thinking', thinking: 'Private Claude state', signature: 'foreign' }, { type: 'redacted_thinking', data: 'private' }
  ] }] }, 'gpt').input, []);
});

test('switching back to Claude removes OpenAI reasoning while preserving messages and tool history', async () => {
  const reasoning = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque' };
  const reply = await fromResponses(stream(events(reasoning)), body.model);
  const claudeThought = { type: 'thinking', thinking: 'Claude state', signature: 'claude-signature' };
  const tool = { type: 'tool_use', id: 'call_read', name: 'Read', input: { file_path: 'fixture' } };
  const mixed = { ...body, messages: [
    { role: 'assistant', content: [claudeThought, { type: 'text', text: 'Original answer' }] },
    { role: 'assistant', content: reply.content },
    { role: 'assistant', content: [...reply.content, tool] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_read', content: 'fixture nonce' }] }
  ] };
  const cleaned = forAnthropic(mixed);
  assert.equal(cleaned.messages.length, 3);
  assert.deepEqual(cleaned.messages[0], mixed.messages[0]);
  assert.deepEqual(cleaned.messages[1].content, [tool]);
  assert.deepEqual(cleaned.messages[2], mixed.messages[3]);
  assert(!JSON.stringify(cleaned).includes('multi-openai:'));
  assert.equal(mixed.messages[2].content.length, 2, 'Stored transcript must not be mutated');
  assert.equal(forAnthropic(body), body, 'Unmixed Claude requests retain byte-exact passthrough');
});

test('fragmented SSE and truncated or failed responses never become successful completions', async () => {
  const bytes = new TextEncoder().encode(sse([{ type: 'example', text: 'héllo' }]));
  const input = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  const parsed = [];
  for await (const event of readSse(input)) parsed.push(event);
  assert.deepEqual(parsed, [{ type: 'example', text: 'héllo' }]);
  const refusal = await fromResponses(stream(events({ type: 'message', content: [{ type: 'refusal', refusal: 'Cannot do that' }] },
    [{ type: 'response.refusal.delta', delta: 'Cannot do that' } ])), body.model);
  assert.equal(refusal.content[0].text, 'Cannot do that');
  await assert.rejects(fromResponses(stream(textEvents.slice(0, -1)), body.model), /before completion/);
  await assert.rejects(fromResponses(stream([{ type: 'response.failed', response: { error: { message: 'Denied' } } }]), body.model), /Denied/);
});

async function gateway(t, fetchImpl) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'native-gateway-test-'));
  const authFile = path.join(cwd, 'auth.json');
  await writeFile(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'openai-secret', account_id: 'account-test' } }));
  const server = createNativeGateway({ token: 'local-test-secret', authFile, fetchImpl });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(cwd, { recursive: true, force: true }); });
  return (payload, headers = {}) => fetch(`http://127.0.0.1:${server.address().port}/v1/messages?beta=true`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-multi-gateway-token': 'local-test-secret', ...headers },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload)
  });
}

test('Claude subscription requests retain their raw body, OAuth and beta headers', async t => {
  const raw = '{ "model": "claude-opus-4-6", "messages": [] }';
  const call = await gateway(t, async (url, options) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages?beta=true');
    assert.equal(options.body.toString(), raw);
    assert.equal(options.headers.authorization, 'Bearer claude-secret');
    assert.equal(options.headers['anthropic-beta'], 'oauth-test,tools-test');
    assert.equal(options.headers['x-multi-gateway-token'], undefined);
    assert(!JSON.stringify(options.headers).includes('openai-secret'));
    return new Response('original stream', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  const response = await call(raw, { authorization: 'Bearer claude-secret', 'anthropic-beta': 'oauth-test,tools-test' });
  assert.equal(await response.text(), 'original stream');
});

test('external route isolates provider credentials and handles simultaneous worker identities', async t => {
  const ids = [];
  const models = [];
  const call = await gateway(t, async (url, options) => {
    assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses');
    assert.equal(options.headers.authorization, 'Bearer openai-secret');
    assert(!JSON.stringify(options.headers).includes('claude-secret'));
    assert(!JSON.stringify(options.headers).includes('local-test-secret'));
    ids.push(options.headers.session_id);
    models.push(JSON.parse(options.body).model);
    return new Response(sse(textEvents), { headers: { 'content-type': 'text/event-stream' } });
  });
  const slugs = ['gpt-6-astra', 'gpt-5.6-luna'];
  const responses = await Promise.all(slugs.map((model, i) => call({ ...body, model: `multi/openai/${model}` },
    { authorization: 'Bearer claude-secret', 'x-claude-code-agent-id': ['a', 'b'][i] })));
  for (const [i, response] of responses.entries()) {
    const result = await response.json();
    assert.equal(result.model, `multi/openai/${slugs[i]}`);
    assert.equal(result.content[0].text, 'Done');
    assert.equal(result.stop_reason, 'end_turn');
  }
  assert.deepEqual(ids.sort(), ['a', 'b']);
  assert.deepEqual(models.sort(), [...slugs].sort());
});

test('browser, unauthenticated and unregistered external requests never reach a provider', async t => {
  const call = await gateway(t, () => assert.fail('Unexpected provider request'));
  assert.equal((await call(body, { origin: 'https://example.com' })).status, 403);
  assert.equal((await call(body, { 'x-multi-gateway-token': 'wrong' })).status, 403);
  for (const model of ['multi/openai/unknown', 'multi/cursor/gpt-5.6-luna']) {
    assert.equal((await call({ ...body, model }, { 'x-claude-code-agent-id': 'a' })).status, 400);
  }
  assert.equal((await call({ ...body, output_config: { effort: 'ultra' } }, { 'x-claude-code-agent-id': 'a' })).status, 400);
});

test('main GPT requests use their Claude session identity and isolated OpenAI authentication', async t => {
  const call = await gateway(t, async (_url, options) => {
    assert.equal(options.headers.session_id, 'main-session');
    assert.equal(options.headers.authorization, 'Bearer openai-secret');
    assert(!JSON.stringify(options.headers).includes('claude-secret'));
    return new Response(sse(textEvents));
  });
  const response = await call(body, { authorization: 'Bearer claude-secret', 'x-claude-code-session-id': 'main-session' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).content[0].text, 'Done');
});

test('all registered model and reasoning choices reach OpenAI without substitution', async t => {
  const call = await gateway(t, async (_url, options) => {
    const [model, effort] = options.headers.session_id.split(':');
    const request = JSON.parse(options.body);
    assert.equal(request.model, model);
    assert.equal(request.reasoning.effort, effort);
    return new Response(sse(textEvents));
  });
  for (const [name, model] of [['openai-native', 'gpt-6-astra'], ['openai-sol', 'gpt-5.6-sol'],
    ['openai-terra', 'gpt-5.6-terra'], ['openai-luna', 'gpt-5.6-luna']]) {
    assert.deepEqual(OPENAI_WORKERS[name], { model, effort: 'medium' });
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
      assert.deepEqual(OPENAI_WORKERS[`${name}-${effort}`], { model, effort });
      const response = await call({ ...body, model: `multi/openai/${model}`, output_config: { effort } },
        { 'x-claude-code-agent-id': `${model}:${effort}` });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).model, `multi/openai/${model}`);
    }
  }
});

test('a dropped downstream connection aborts external inference', async t => {
  let upstreamSignal;
  let resolveStarted;
  const started = new Promise(resolve => { resolveStarted = resolve; });
  const call = await gateway(t, async (_url, options) => {
    upstreamSignal = options.signal;
    resolveStarted();
    return new Response(new ReadableStream({ start(controller) {
      options.signal.addEventListener('abort', () => controller.error(new Error('cancelled')), { once: true });
    } }));
  });
  const pending = call({ ...body, stream: true }, { 'x-claude-code-agent-id': 'a' });
  await started;
  const response = await pending;
  await response.body.cancel();
  await new Promise(resolve => upstreamSignal.addEventListener('abort', resolve, { once: true }));
  assert(upstreamSignal.aborted);
});
