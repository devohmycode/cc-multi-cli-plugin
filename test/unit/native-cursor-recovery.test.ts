import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentOptions, Run, RunResult, SDKUserMessage } from '@cursor/sdk';
import type { MessagesRequest } from '../../plugins/multi/src/gateway/messages.ts';
import type { CreateCursorAgent } from '../../plugins/multi/src/providers/cursor/bridge.ts';
import { CursorBridge } from '../../plugins/multi/src/providers/cursor/bridge.ts';
import { cursorModelOptions } from '../../plugins/multi/src/providers/cursor/models.ts';

const options = cursorModelOptions([{ id: 'recovery', displayName: 'Recovery' }]);
const body: MessagesRequest = {
  model: options[0].model,
  messages: [{ role: 'user', content: 'Reply' }],
};
const signal = () => AbortSignal.timeout(3000);

function finishedRun(result: string): Run {
  const outcome: RunResult = { id: 'run', status: 'finished', result };
  return {
    id: 'run',
    agentId: 'agent',
    status: 'finished',
    wait: async () => outcome,
    cancel: async () => {},
    async *stream() {},
    conversation: async () => [],
    supports: () => true,
    unsupportedReason: () => undefined,
    onDidChangeStatus: () => () => {},
  };
}

function textAgent(deltas: string[], result: string): CreateCursorAgent {
  return async () => ({
    close: () => {},
    send: async (_prompt: string | SDKUserMessage, sendOptions) => {
      for (const text of deltas) {
        void sendOptions?.onDelta?.({ update: { type: 'text-delta', text } });
      }
      return finishedRun(result);
    },
  });
}

test('Cursor terminal text fills a streamed prefix without duplicating a full stream', async (t) => {
  const cases = [
    { deltas: [], result: 'Hello world', expected: 'Hello world' },
    { deltas: ['Hello'], result: 'Hello world', expected: 'Hello world' },
    { deltas: ['Hello world'], result: 'Hello world', expected: 'Hello world' },
    {
      deltas: ['Earlier commentary. Done.'],
      result: 'Done.',
      expected: 'Earlier commentary. Done.',
    },
  ];
  for (const entry of cases) {
    const bridge = new CursorBridge(options, {
      createAgent: textAgent(entry.deltas, entry.result),
    });
    t.after(() => bridge.close());
    const response = await bridge.handle(body, entry.result, signal());
    assert.deepEqual(response.content, [{ type: 'text', text: entry.expected }]);
  }
});

test('Cursor terminal text only reconciles the segment after a callback', async (t) => {
  const createAgent: CreateCursorAgent = async (config: AgentOptions) => ({
    close: () => {},
    send: async (_prompt: string | SDKUserMessage, sendOptions) => {
      const tools = config.local?.customTools;
      assert(tools);
      void sendOptions?.onDelta?.({ update: { type: 'text-delta', text: 'Earlier commentary. ' } });
      await tools.Read.execute({}, { toolCallId: 'read' });
      void sendOptions?.onDelta?.({ update: { type: 'text-delta', text: 'Done.' } });
      return finishedRun('Done.');
    },
  });
  const bridge = new CursorBridge(options, {
    createAgent,
  });
  t.after(() => bridge.close());
  const request: MessagesRequest = {
    ...body,
    tools: [{ name: 'Read', input_schema: { type: 'object' } }],
  };
  const first = await bridge.handle(request, 'segment', signal());
  assert.equal(first.content[0]?.type, 'text');
  assert.equal(first.content[1]?.type, 'tool_use');
  const tool = first.content[1];
  assert.equal(tool.type, 'tool_use');
  const history = request.messages;
  assert(history);
  const second = await bridge.handle(
    {
      ...request,
      messages: [
        ...history,
        { role: 'assistant', content: first.content },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool.id, content: 'ok' }] },
      ],
    },
    'segment',
    signal(),
  );
  assert.deepEqual(second.content, [{ type: 'text', text: 'Done.' }]);
});

test('Cursor retries only failures before agent inference begins', async (t) => {
  let starts = 0;
  const startup = new CursorBridge(options, {
    createAgent: async () => {
      starts++;
      throw new Error('temporary unavailable');
    },
  });
  t.after(() => startup.close());
  await assert.rejects(startup.handle(body, 'startup', signal()), /temporary unavailable/);
  await assert.rejects(startup.handle(body, 'startup', signal()), /temporary unavailable/);
  assert.equal(starts, 2);

  let sends = 0;
  const afterSend = new CursorBridge(options, {
    createAgent: async () => ({
      close: () => {},
      send: async () => {
        sends++;
        throw new Error('SDK send failed');
      },
    }),
  });
  t.after(() => afterSend.close());
  await assert.rejects(afterSend.handle(body, 'send', signal()), /SDK send failed/);
  await assert.rejects(afterSend.handle(body, 'send', signal()), /SDK send failed/);
  assert.equal(sends, 1);
});

test('Cursor does not replay a failed callback continuation', async (t) => {
  let sends = 0;
  const createAgent: CreateCursorAgent = async (config: AgentOptions) => ({
    close: () => {},
    send: async () => {
      sends++;
      const tools = config.local?.customTools;
      assert(tools);
      await tools.Read.execute({}, { toolCallId: 'read' });
      throw new Error('failed after callback');
    },
  });
  const bridge = new CursorBridge(options, { createAgent });
  t.after(() => bridge.close());
  const request: MessagesRequest = {
    ...body,
    tools: [{ name: 'Read', input_schema: { type: 'object' } }],
  };
  const first = await bridge.handle(request, 'callback-retry', signal());
  const tool = first.content[0];
  assert(tool && tool.type === 'tool_use');
  const history = request.messages;
  assert(history);
  const continuation: MessagesRequest = {
    ...request,
    messages: [
      ...history,
      { role: 'assistant', content: first.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool.id, content: 'ok' }] },
    ],
  };
  await assert.rejects(
    bridge.handle(continuation, 'callback-retry', signal()),
    /failed after callback/,
  );
  await assert.rejects(
    bridge.handle(continuation, 'callback-retry', signal()),
    /failed after callback/,
  );
  assert.equal(sends, 1);
});
