import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentOptions, Run, RunResult, SDKUserMessage } from '@cursor/sdk';
import type { MessagesRequest } from '../../plugins/multi/src/gateway/messages.ts';
import type { CreateCursorAgent } from '../../plugins/multi/src/providers/cursor/bridge.ts';
import { CursorBridge } from '../../plugins/multi/src/providers/cursor/bridge.ts';
import { cursorModelOptions } from '../../plugins/multi/src/providers/cursor/models.ts';

const options = cursorModelOptions([{ id: 'capability', displayName: 'Capability' }]);
const body: MessagesRequest = {
  model: options[0].model,
  messages: [{ role: 'user', content: 'Reply' }],
  tools: [{ name: 'Probe', input_schema: { type: 'object' } }],
};
const signal = () => AbortSignal.timeout(3000);

function finishedRun(result = 'done'): Run {
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

test('Cursor snapshots nested callback JSON and preserves the declared tool schema and image attachment', async (t) => {
  let config: AgentOptions | undefined;
  let prompt: SDKUserMessage | undefined;
  const createAgent: CreateCursorAgent = async (agentConfig) => ({
    close: () => {},
    send: async (message: string | SDKUserMessage) => {
      config = agentConfig;
      if (typeof message !== 'string') {
        prompt = message;
      }
      const tools = agentConfig.local?.customTools;
      assert(tools);
      const args = { nested: { values: [1, true, null] } };
      const pending = tools.Probe.execute(args, { toolCallId: 'probe' });
      args.nested.values[0] = 2;
      void Promise.resolve(pending).catch(() => {});
      return {
        ...finishedRun(),
        wait: async () => new Promise<RunResult>(() => {}),
      };
    },
  });
  const bridge = new CursorBridge(options, { createAgent });
  t.after(() => bridge.close());
  const schema = {
    type: 'object',
    properties: { nested: { type: 'object', additionalProperties: true } },
    required: ['nested'],
  };
  const response = await bridge.handle(
    {
      ...body,
      tools: [{ name: 'Probe', input_schema: schema }],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Inspect the image' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'cGl4ZWxz' },
            },
          ],
        },
      ],
    },
    'snapshot',
    signal(),
  );
  const call = response.content[0];
  assert(call && call.type === 'tool_use');
  assert.deepEqual(call.input, { nested: { values: [1, true, null] } });
  assert(config?.local?.customTools);
  assert.deepEqual(config.local.customTools.Probe.inputSchema, schema);
  assert.deepEqual(prompt?.images, [{ data: 'cGl4ZWxz', mimeType: 'image/png' }]);
});

test('Cursor rejects malformed callback arguments before advertising a tool request', async (t) => {
  const invalid = [null, [], 'text', Number.NaN, { number: Number.POSITIVE_INFINITY }];
  for (const args of invalid) {
    let rejection: Error | undefined;
    const createAgent: CreateCursorAgent = async (config) => ({
      close: () => {},
      send: async () => {
        const tools = config.local?.customTools;
        assert(tools);
        try {
          await Reflect.apply(tools.Probe.execute, tools.Probe, [args, { toolCallId: 'bad' }]);
        } catch (error) {
          rejection = error instanceof Error ? error : new Error(String(error));
        }
        return finishedRun();
      },
    });
    const bridge = new CursorBridge(options, { createAgent });
    t.after(() => bridge.close());
    const response = await bridge.handle(body, JSON.stringify(args), signal());
    assert.deepEqual(response.content, [{ type: 'text', text: 'done' }]);
    assert.match(rejection?.message ?? '', /JSON object/);
  }
});

test('Cursor rejects unsupported strict output, forced tools, and stop sequences before inference', () => {
  const bridge = new CursorBridge(options, {
    createAgent: async () => {
      throw new Error('inference must not start');
    },
  });
  assert.throws(() => bridge.validate({ ...body, output_format: { type: 'json_schema' } }));
  assert.throws(() => bridge.validate({ ...body, tool_choice: { type: 'any' } }));
  assert.throws(() => bridge.validate({ ...body, stop_sequences: ['STOP'] }));
  assert.doesNotThrow(() =>
    bridge.validate(Object.assign({}, body, { max_tokens: 1, temperature: 0 })),
  );
});
