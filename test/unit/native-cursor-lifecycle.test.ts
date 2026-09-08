import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentOptions, Run, RunResult, SDKUserMessage } from '@cursor/sdk';
import type { MessagesRequest } from '../../plugins/multi/src/gateway/messages.ts';
import type { CreateCursorAgent } from '../../plugins/multi/src/providers/cursor/bridge.ts';
import { CursorBridge } from '../../plugins/multi/src/providers/cursor/bridge.ts';
import { cursorModelOptions } from '../../plugins/multi/src/providers/cursor/models.ts';

const options = cursorModelOptions([{ id: 'lifecycle', displayName: 'Lifecycle' }]);
const body: MessagesRequest = {
  model: options[0].model,
  messages: [{ role: 'user', content: 'Reply' }],
};
const signal = () => AbortSignal.timeout(3000);
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function activeRun(wait: Promise<RunResult>, cancel: () => Promise<void>): Run {
  return {
    id: 'run',
    agentId: 'agent',
    status: 'running',
    wait: () => wait,
    cancel,
    async *stream() {},
    conversation: async () => [],
    supports: () => true,
    unsupportedReason: () => undefined,
    onDidChangeStatus: () => () => {},
  };
}

test('one aborted observer leaves shared Cursor inference running for another observer', async (t) => {
  const started = Promise.withResolvers<void>();
  const done = Promise.withResolvers<RunResult>();
  let cancelled = 0;
  const bridge = new CursorBridge(options, {
    createAgent: async () => ({
      close: () => {},
      send: async (_prompt: string | SDKUserMessage) => {
        started.resolve();
        return activeRun(done.promise, async () => {
          cancelled++;
          done.resolve({ id: 'run', status: 'cancelled' });
        });
      },
    }),
  });
  t.after(() => bridge.close());
  const first = new AbortController();
  const second = new AbortController();
  const one = bridge.handle(body, 'shared', first.signal);
  const two = bridge.handle(body, 'shared', second.signal);
  await started.promise;
  first.abort(new Error('first observer left'));
  await assert.rejects(one, /first observer left/);
  await tick();
  assert.equal(cancelled, 0);
  done.resolve({ id: 'run', status: 'finished', result: 'done' });
  assert.deepEqual((await two).content, [{ type: 'text', text: 'done' }]);
});

test('the last aborted observer cancels the active Cursor run', async () => {
  const started = Promise.withResolvers<void>();
  const done = Promise.withResolvers<RunResult>();
  let cancelled = 0;
  const bridge = new CursorBridge(options, {
    createAgent: async () => ({
      close: () => {},
      send: async () => {
        started.resolve();
        return activeRun(done.promise, async () => {
          cancelled++;
          done.resolve({ id: 'run', status: 'cancelled' });
        });
      },
    }),
  });
  const observer = new AbortController();
  const request = bridge.handle(body, 'last', observer.signal);
  await started.promise;
  observer.abort(new Error('last observer left'));
  await assert.rejects(request, /last observer left/);
  await tick();
  assert.equal(cancelled, 1);
  await bridge.close();
});

test('a completed tool-use response leaves its Cursor callback alive between HTTP requests', async (t) => {
  let cancelled = 0;
  const createAgent: CreateCursorAgent = async (config: AgentOptions) => ({
    close: () => {},
    send: async () => {
      const tools = config.local?.customTools;
      assert(tools);
      const pending = Promise.resolve(tools.Read.execute({}, { toolCallId: 'read' }));
      void pending.catch(() => {});
      const result: Promise<RunResult> = pending.then(() => ({
        id: 'run',
        status: 'finished',
        result: 'done',
      }));
      return activeRun(result, async () => {
        cancelled++;
      });
    },
  });
  const bridge = new CursorBridge(options, { createAgent });
  t.after(() => bridge.close());
  const response = await bridge.handle(
    { ...body, tools: [{ name: 'Read', input_schema: { type: 'object' } }] },
    'callback',
    signal(),
  );
  assert.equal(response.stop_reason, 'tool_use');
  await tick();
  assert.equal(cancelled, 0);
});

test('shutdown closes an SDK callback wait even when cancel throws synchronously', async () => {
  const started = Promise.withResolvers<void>();
  let closed = 0;
  const bridge = new CursorBridge(options, {
    createAgent: async () => ({
      close: () => {
        closed++;
      },
      send: async () => {
        started.resolve();
        return activeRun(new Promise<RunResult>(() => {}), () => {
          throw new Error('cancel failed');
        });
      },
    }),
  });
  void bridge.handle(body, 'sync-cancel', signal()).catch(() => {});
  await started.promise;
  await bridge.close();
  assert.equal(closed, 1);
});

test('shutdown bounds a delayed SDK cancellation before closing the agent', async () => {
  const started = Promise.withResolvers<void>();
  let closed = 0;
  const bridge = new CursorBridge(options, {
    createAgent: async () => ({
      close: () => {
        closed++;
      },
      send: async () => {
        started.resolve();
        return activeRun(new Promise<RunResult>(() => {}), async () => new Promise<void>(() => {}));
      },
    }),
  });
  void bridge.handle(body, 'delayed-cancel', signal()).catch(() => {});
  await started.promise;
  const before = Date.now();
  await bridge.close();
  assert(Date.now() - before < 1500);
  assert.equal(closed, 1);
});

test('late SDK startup closes an agent after bounded bridge shutdown', async () => {
  const starting = Promise.withResolvers<void>();
  const created = Promise.withResolvers<{
    close: () => void;
    send: () => Promise<Run>;
  }>();
  let closed = 0;
  const bridge = new CursorBridge(options, {
    createAgent: async () => {
      starting.resolve();
      const agent = await created.promise;
      return {
        close: () => {
          closed++;
          agent.close();
        },
        send: agent.send,
      };
    },
  });
  const observer = new AbortController();
  const request = bridge.handle(body, 'late-start', observer.signal);
  await starting.promise;
  observer.abort(new Error('cancel startup'));
  await assert.rejects(request, /cancel startup/);
  await bridge.close();
  created.resolve({
    close: () => {},
    send: async () =>
      activeRun(Promise.resolve({ id: 'late', status: 'finished' }), async () => {}),
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  assert.equal(closed, 1);
});

test('late SDK send is cancelled and does not close the agent twice', async () => {
  const sent = Promise.withResolvers<Run>();
  let cancelled = 0;
  let closed = 0;
  const bridge = new CursorBridge(options, {
    createAgent: async () => ({
      close: () => {
        closed++;
      },
      send: async () => sent.promise,
    }),
  });
  const observer = new AbortController();
  const request = bridge.handle(body, 'late-send', observer.signal);
  await tick();
  observer.abort(new Error('cancel send'));
  await assert.rejects(request, /cancel send/);
  await bridge.close();
  sent.resolve(
    activeRun(Promise.resolve({ id: 'late', status: 'finished' }), async () => {
      cancelled++;
    }),
  );
  await tick();
  assert.equal(cancelled, 1);
  assert.equal(closed, 1);
});

test('cached event replay aborts cleanly before listener registration completes', async (t) => {
  const bridge = new CursorBridge(options, {
    createAgent: async () => ({
      close: () => {},
      send: async () =>
        activeRun(
          Promise.resolve({ id: 'replay', status: 'finished', result: 'done' }),
          async () => {},
        ),
    }),
  });
  t.after(() => bridge.close());
  await bridge.handle(body, 'replay', signal(), () => {});
  const observer = new AbortController();
  const reason = new Error('replay observer left');
  await assert.rejects(
    bridge.handle(body, 'replay', observer.signal, () => {
      observer.abort(reason);
    }),
    /replay observer left/,
  );
});
