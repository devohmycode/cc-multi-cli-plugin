import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import type { AgentOptions, Run, RunResult, SDKUserMessage, SendOptions } from '@cursor/sdk';
import type {
  Emit,
  MessagesRequest,
  MessagesResponse,
} from '../../plugins/multi/src/gateway/messages.ts';
import type { PermissionContext } from '../../plugins/multi/src/gateway/mode-hook.ts';
import {
  type CreateCursorHarnessAgent,
  CursorHarness,
} from '../../plugins/multi/src/providers/cursor/harness.ts';
import { cursorModelOptions } from '../../plugins/multi/src/providers/cursor/models.ts';
import { cursorHistoryHash } from '../../plugins/multi/src/providers/cursor/request.ts';
import { lockCursorSession } from '../../plugins/multi/src/providers/cursor/state-lock.ts';

const models = cursorModelOptions([
  { id: 'test-model', displayName: 'Test Model' },
  { id: 'other-model', displayName: 'Other Model' },
]);
const body: MessagesRequest = {
  model: models[0].model,
  messages: [{ role: 'user', content: 'first request' }],
};
const signal = () => AbortSignal.timeout(5000);
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function follow(response: MessagesResponse): MessagesRequest {
  return {
    ...body,
    messages: [
      ...(body.messages ?? []),
      { role: 'assistant', content: response.content },
      { role: 'user', content: 'second request' },
    ],
  };
}

// These offline fixtures explicitly exercise Auto unless a test supplies another mode.
class AutoTestHarness extends CursorHarness {
  override handle(
    body: MessagesRequest,
    scope: string,
    signal: AbortSignal,
    emit?: Emit,
    context: PermissionContext = { permissionMode: 'auto' },
  ) {
    return super.handle(body, scope, signal, emit, context);
  }
}

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp('/tmp/cursor-harness-test-');
  const configurations: AgentOptions[] = [];
  const sends: { id: string; prompt: string | SDKUserMessage; options?: SendOptions }[] = [];
  const resumed: string[] = [];
  const resumeConfigurations: AgentOptions[] = [];
  const results: ReturnType<typeof Promise.withResolvers<RunResult>>[] = [];
  const started = Promise.withResolvers<void>();
  let hold = false;
  let cancellations = 0;
  let closes = 0;
  let createGate: Promise<void> | undefined;
  let sendGate: Promise<void> | undefined;
  let cancelHangs = false;
  let cancelThrows = false;
  let resumeFails = false;
  let recovery: { result: RunResult; status: Run['status']; agentId: string } | undefined;
  const recoveryReads: string[] = [];
  function agent(id: string) {
    return {
      agentId: id,
      close() {
        closes++;
      },
      async send(prompt: string | SDKUserMessage, options?: SendOptions): Promise<Run> {
        sends.push({ id, prompt, options });
        started.resolve();
        const result = Promise.withResolvers<RunResult>();
        results.push(result);
        await options?.onDelta?.({ update: { type: 'summary-started' } });
        await options?.onDelta?.({ update: { type: 'text-delta', text: 'done' } });
        if (!hold) {
          result.resolve({ id: 'run', status: 'finished', result: 'done' });
        }
        await sendGate;
        return {
          id: 'run',
          agentId: id,
          status: 'running',
          wait: () => result.promise,
          cancel: () => {
            cancellations++;
            if (cancelThrows) {
              throw new Error('SDK cancellation threw');
            }
            return finishCancel(result);
          },
          async *stream() {},
          conversation: async () => [],
          supports: () => true,
          unsupportedReason: () => undefined,
          onDidChangeStatus: () => () => {},
        };
      },
    };
  }
  async function finishCancel(result: ReturnType<typeof Promise.withResolvers<RunResult>>) {
    if (cancelHangs) {
      await new Promise<void>(() => {});
    }
    result.resolve({ id: 'run', status: 'cancelled' });
  }
  const createAgent: CreateCursorHarnessAgent = async (config) => {
    configurations.push(config);
    await createGate;
    return agent(`agent-${configurations.length}`);
  };
  const config = {
    cwd: directory,
    stateDirectory: path.join(directory, 'state'),
    createAgent,
    getRun: async (id: string, cwd: string): Promise<Run> => {
      assert.equal(cwd, directory);
      recoveryReads.push(id);
      const saved = recovery;
      if (!saved) {
        throw new Error('No terminal SDK result');
      }
      return {
        id,
        agentId: saved.agentId,
        status: saved.status,
        wait: async () => saved.result,
        cancel: async () => {},
        async *stream() {},
        conversation: async () => [],
        supports: () => true,
        unsupportedReason: () => undefined,
        onDidChangeStatus: () => () => {},
      };
    },
    resumeAgent: async (id: string, config: AgentOptions) => {
      resumed.push(id);
      resumeConfigurations.push(config);
      if (resumeFails) {
        resumeFails = false;
        throw new Error('SDK resume failed');
      }
      return agent(id);
    },
  };
  const harnesses: CursorHarness[] = [];
  const make = () => {
    const harness = new AutoTestHarness(models, config);
    harnesses.push(harness);
    return harness;
  };
  t.after(async () => {
    await Promise.all(harnesses.map((harness) => harness.close()));
    await rm(directory, { recursive: true, force: true });
  });
  return {
    make,
    started: started.promise,
    configurations,
    sends,
    resumed,
    resumeConfigurations,
    recoveryReads,
    recover: (result: RunResult, status: Run['status'] = result.status, agentId = 'agent-1') => {
      recovery = { result, status, agentId };
    },
    failNextResume: () => {
      resumeFails = true;
    },
    directory,
    sessionFile: path.join(
      directory,
      'state',
      `${createHash('sha256')
        .update(JSON.stringify([directory, 'main']))
        .digest('hex')}.session.json`,
    ),
    results,
    hold: () => {
      hold = true;
    },
    cancellations: () => cancellations,
    closes: () => closes,
    delayCreate: (promise: Promise<void>) => {
      createGate = promise;
    },
    delaySend: (promise: Promise<void>) => {
      sendGate = promise;
    },
    throwCancel: () => {
      cancelThrows = true;
    },
    hangCancel: () => {
      cancelHangs = true;
    },
  };
}

function submission(id: string, prompt: string): PermissionContext {
  return {
    permissionMode: 'auto',
    submission: { id, promptHash: createHash('sha256').update(prompt).digest('hex') },
  };
}

async function interruptedManifest(f: Awaited<ReturnType<typeof fixture>>) {
  const harness = f.make();
  await harness.handle(body, 'main', signal());
  await harness.close();
  const saved = JSON.parse(await readFile(f.sessionFile, 'utf8'));
  await writeFile(
    f.sessionFile,
    JSON.stringify({
      ...saved,
      response: undefined,
      replay: undefined,
      historyLength: 0,
      historyHash: cursorHistoryHash([]),
      pending: true,
      pendingRun: {
        key: saved.replay.key,
        runId: 'run',
        historyLength: saved.historyLength,
        historyHash: saved.historyHash,
        inputTokens: saved.response.usage.input_tokens,
        model: body.model,
      },
    }),
  );
}

test('native Cursor retains an agent, sends only new history, and renders progress without executable tools', async (t) => {
  const f = await fixture(t);
  const harness = f.make();
  const response = await harness.handle(body, 'main', signal());
  assert(response.content.every((block) => block.type === 'text'));
  assert.match(JSON.stringify(response.content), /Compacting context/);
  const next = await harness.handle(follow(response), 'main', signal(), undefined, {
    permissionMode: 'plan',
  });
  assert.equal(next.stop_reason, 'end_turn');
  assert.equal(f.configurations.length, 1);
  assert.equal(f.sends[1].options?.mode, 'plan');
  assert.deepEqual(f.resumed, [f.sends[0].id]);
  assert.deepEqual(f.resumeConfigurations[0].tools, ['read', 'grep', 'glob', 'ls']);
  assert.match(JSON.stringify(f.sends[1].prompt), /second request/);
  assert.doesNotMatch(JSON.stringify(f.sends[1].prompt), /first request|Compacting context/);
  assert.equal(f.configurations[0].local?.autoReview, true);
  assert.equal(f.configurations[0].local?.customTools, undefined);
  await harness.handle(body, 'worker', signal());
  assert.equal(f.configurations.length, 2);
  assert.notEqual(f.sends[0].id, f.sends[2].id);
});

test('changed worker policy resumes native state and a failed resume never sends under the old policy', async (t) => {
  const f = await fixture(t);
  const harness = f.make();
  const response = await harness.handle(body, 'main', signal(), undefined, {
    permissionMode: 'auto',
    tools: ['Read'],
  });
  assert.deepEqual(f.configurations[0].tools, ['read', 'ls']);
  f.failNextResume();
  const next = follow(response);
  const context = { permissionMode: 'auto' as const, tools: ['Grep'] };
  await assert.rejects(harness.handle(next, 'main', signal(), undefined, context), /resume failed/);
  assert.equal(f.sends.length, 1);
  await harness.handle(next, 'main', signal(), undefined, context);
  assert.equal(f.sends.length, 2);
  assert.equal(f.sends[1].id, f.sends[0].id);
  assert.deepEqual(
    f.resumeConfigurations.map((config) => config.tools),
    [['grep'], ['grep']],
  );
  assert.equal(f.closes(), 1, 'the old SDK instance is closed once despite retry');
  assert.doesNotMatch(JSON.stringify(f.sends[1].prompt), /first request/);
});

test('returning to Auto after failed Plan resume replaces the closed SDK handle', async (t) => {
  const f = await fixture(t);
  const harness = f.make();
  const response = await harness.handle(body, 'main', signal());
  const next = follow(response);
  f.failNextResume();
  await assert.rejects(
    harness.handle(next, 'main', signal(), undefined, { permissionMode: 'plan' }),
    /resume failed/,
  );
  assert.equal(f.sends.length, 1);
  await harness.handle(next, 'main', signal());
  assert.equal(f.resumed.length, 2);
  assert.deepEqual(f.resumeConfigurations[1].tools, f.configurations[0].tools);
  assert.equal(f.sends.length, 2);
  assert.equal(f.sends[1].options?.mode, 'agent');
});

test('native Cursor changes model in one scope and resumes after another provider without replaying history', async (t) => {
  const f = await fixture(t);
  const harness = f.make();
  const first = await harness.handle(body, 'main', signal());
  const switchedRequest = { ...follow(first), model: models[1].model };
  const switched = await harness.handle(switchedRequest, 'main', signal());
  assert.equal(f.configurations.length, 1);
  assert.equal(f.sends[0].id, f.sends[1].id);
  assert.deepEqual(f.sends[1].options?.model, models[1].selection);

  await harness.handle(
    {
      ...switchedRequest,
      messages: [
        ...(switchedRequest.messages ?? []),
        { role: 'assistant', content: switched.content },
        { role: 'user', content: 'Ask the other provider to inspect the result.' },
        { role: 'assistant', content: 'The other provider inspected the result.' },
        { role: 'user', content: 'Continue with Cursor using that result.' },
      ],
    },
    'main',
    signal(),
  );
  assert.equal(f.configurations.length, 1);
  assert.equal(f.sends[1].id, f.sends[2].id);
  const appended = JSON.stringify(f.sends[2].prompt);
  assert.match(appended, /Ask the other provider|Continue with Cursor/);
  assert.doesNotMatch(appended, /first request|second request/);
});

test('completed requests deduplicate across disk resume and follow-ups use the saved SDK agent', async (t) => {
  const f = await fixture(t);
  const first = f.make();
  const response = await first.handle(body, 'main', signal());
  const saved = JSON.parse(await readFile(f.sessionFile, 'utf8'));
  assert.equal(saved.version, 1);
  assert.equal(saved.historyLength, 1);
  assert.match(saved.historyHash, /^[a-f0-9]{64}$/);
  assert(!('history' in saved));
  assert.doesNotMatch(JSON.stringify(saved), /first request/);
  await first.close();
  const second = f.make();
  assert.deepEqual(await second.handle(body, 'main', signal()), response);
  assert.equal(f.sends.length, 1);
  await second.handle(follow(response), 'main', signal());
  assert.deepEqual(f.resumed, ['agent-1']);
  assert.equal(f.configurations.length, 1);
  assert.doesNotMatch(JSON.stringify(f.sends[1].prompt), /first request/);
});

test('one disconnected observer does not cancel a shared native run; all disconnected observers do', async (t) => {
  const f = await fixture(t);
  f.hold();
  const harness = f.make();
  const left = new AbortController();
  const right = new AbortController();
  const one = harness.handle(body, 'main', left.signal);
  const two = harness.handle(body, 'main', right.signal);
  await Promise.race([f.started, one]);
  left.abort(new Error('left disconnected'));
  await assert.rejects(one, /left disconnected/);
  assert.equal(f.cancellations(), 0);
  right.abort(new Error('right disconnected'));
  await assert.rejects(two, /right disconnected/);
  await tick();
  assert.equal(f.cancellations(), 1);
  await assert.rejects(harness.handle(body, 'main', signal()));
  assert.equal(f.sends.length, 1);
});

test('terminal cancellation is durable and a new observed prompt can continue in the same gateway', async (t) => {
  const f = await fixture(t);
  f.hold();
  const first = f.make();
  const abort = new AbortController();
  const request = first.handle(body, 'main', abort.signal);
  await Promise.race([f.started, request]);
  abort.abort(new Error('disconnect'));
  await assert.rejects(request);
  await assert.rejects(first.handle(body, 'main', signal()));
  assert.equal(JSON.parse(await readFile(f.sessionFile, 'utf8')).pending, false);
  const next = first.handle(
    { ...body, messages: [{ role: 'user', content: 'new task' }] },
    'main',
    signal(),
    undefined,
    submission('new', 'new task'),
  );
  while (f.sends.length < 2) {
    await tick();
  }
  f.results[1].resolve({ id: 'run', status: 'finished', result: 'done' });
  await next;
  assert.doesNotMatch(JSON.stringify(f.sends[1].prompt), /first request/);
  await first.close();
  await assert.rejects(f.make().handle(body, 'main', signal()), /cancelled/);
  assert.equal(f.sends.length, 2);
});

test('changed history fails explicitly and a second gateway cannot take a live scope', async (t) => {
  const f = await fixture(t);
  const harness = f.make();
  await harness.handle(body, 'main', signal());
  await assert.rejects(
    harness.handle(
      { ...body, messages: [{ role: 'user', content: 'rewritten' }] },
      'main',
      signal(),
    ),
    /history changed/,
  );
  await assert.rejects(
    f
      .make()
      .handle(
        { ...body, messages: [{ role: 'user', content: 'another request' }] },
        'main',
        signal(),
      ),
    /locked/,
  );
  assert.equal(f.sends.length, 1);
});

test('shutdown during delayed agent creation closes the late agent without sending', async (t) => {
  const f = await fixture(t);
  const gate = Promise.withResolvers<void>();
  f.delayCreate(gate.promise);
  const harness = f.make();
  const request = harness.handle(body, 'main', signal());
  void request.catch(() => {});
  while (!f.configurations.length) {
    await tick();
  }
  await harness.close();
  gate.resolve();
  await assert.rejects(request, /closed|disconnected/);
  assert.equal(f.sends.length, 0);
  assert.equal(f.closes(), 1);
});

test('repeated session cleanup cannot remove a replacement gateway lock', async (t) => {
  const f = await fixture(t);
  const harness = f.make();
  const response = await harness.handle(body, 'main', signal());
  const session = harness['sessions'].get('main');
  assert(session);
  await harness['releaseLock'](session);
  const release = await lockCursorSession(`${f.sessionFile}.lock`);
  t.after(release);
  await harness.close();
  await assert.rejects(f.make().handle(follow(response), 'main', signal()), /locked/);
  assert.equal(f.sends.length, 1);
});

test('shutdown bounds hung cancellation and retains the interrupted session lock', async (t) => {
  const f = await fixture(t);
  f.hold();
  f.hangCancel();
  const harness = f.make();
  const request = harness.handle(body, 'main', signal());
  void request.catch(() => {});
  await Promise.race([f.started, request]);
  await tick();
  const before = Date.now();
  await harness.close();
  assert(Date.now() - before < 2500);
  assert.equal(f.cancellations(), 1);
  assert.equal(f.closes(), 1);
  await assert.rejects(
    f.make().handle({ ...body, system: 'different' }, 'main', signal()),
    /locked/,
  );
  f.results[0].resolve({ id: 'run', status: 'cancelled' });
  await assert.rejects(request);
  await tick();
  assert.equal(f.closes(), 1);
});

test('shutdown during delayed send cancels the eventual run and never reports success', async (t) => {
  const f = await fixture(t);
  f.hold();
  const gate = Promise.withResolvers<void>();
  f.delaySend(gate.promise);
  const harness = f.make();
  const request = harness.handle(body, 'main', signal());
  void request.catch(() => {});
  await Promise.race([f.started, request]);
  await harness.close();
  gate.resolve();
  await assert.rejects(request);
  assert.equal(f.cancellations(), 1);
});

test('failed atomic completion preserves uncertainty and never emits a successful terminal event', async (t) => {
  const f = await fixture(t);
  f.hold();
  const harness = f.make();
  const events: string[] = [];
  const request = harness.handle(body, 'main', signal(), (name) => {
    events.push(name);
  });
  await Promise.race([f.started, request]);
  const backup = `${f.sessionFile}.backup`;
  await rename(f.sessionFile, backup);
  await mkdir(f.sessionFile);
  f.results[0].resolve({ id: 'run', status: 'finished', result: 'done' });
  await assert.rejects(request);
  assert(!events.includes('message_stop'));
  assert(!events.includes('message_delta'));
  assert.equal(f.sends.length, 1);
  await rm(f.sessionFile, { recursive: true });
  await rename(backup, f.sessionFile);
  await harness.close();
  await assert.rejects(f.make().handle(body, 'main', signal()), /interrupted run/);
  assert.equal(f.sends.length, 1);
});

test('synchronous SDK cancellation errors stay inside native run cleanup', async (t) => {
  const f = await fixture(t);
  f.hold();
  f.throwCancel();
  const harness = f.make();
  const observer = new AbortController();
  const request = harness.handle(body, 'main', observer.signal);
  await Promise.race([f.started, request]);
  await tick();
  observer.abort(new Error('observer disconnected'));
  await assert.rejects(request, /observer disconnected/);
  await tick();
  assert.equal(f.cancellations(), 1);
  f.results[0].resolve({ id: 'run', status: 'cancelled' });
  await harness.close();
  assert.equal(f.closes(), 1);
});

test('abort during cached native event replay has no unhandled rejection', async (t) => {
  const f = await fixture(t);
  const harness = f.make();
  await harness.handle(body, 'main', signal());
  const observer = new AbortController();
  await assert.rejects(
    harness.handle(body, 'main', observer.signal, () => {
      observer.abort(new Error('replay disconnected'));
    }),
    /replay disconnected/,
  );
  await tick();
  assert.equal(f.sends.length, 1);
  assert.equal(f.cancellations(), 0);
});

test('a committed native reply survives transport loss before terminal delivery', async (t) => {
  const f = await fixture(t);
  const first = f.make();
  await assert.rejects(
    first.handle(body, 'main', signal(), (name) => {
      if (name === 'message_delta') {
        throw new Error('transport lost');
      }
    }),
    /transport lost/,
  );
  const saved = JSON.parse(await readFile(f.sessionFile, 'utf8'));
  assert.equal(saved.pending, false);
  assert.equal(saved.replay.events.at(-1)[0], 'message_stop');
  assert.deepEqual(await first.handle(body, 'main', signal()), saved.response);
  await first.close();
  const second = f.make();
  const replayed: string[] = [];
  assert.deepEqual(
    await second.handle(body, 'main', signal(), (name) => replayed.push(name)),
    saved.response,
  );
  assert.equal(replayed.at(-1), 'message_stop');
  assert.equal(f.sends.length, 1);
  assert.equal(f.resumed.length, 0);
  await second.handle(follow(saved.response), 'main', signal());
  assert.deepEqual(f.resumed, ['agent-1']);
  assert.equal(f.sends.length, 2);
});

test('a failed reply archive blocks the next send and can retry without repeating native work', async (t) => {
  const f = await fixture(t);
  const first = f.make();
  const response = await first.handle(body, 'main', signal());
  const saved = JSON.parse(await readFile(f.sessionFile, 'utf8'));
  const archive = path.join(f.directory, 'state', `${saved.replay.key}.response.json`);
  await mkdir(archive);
  await assert.rejects(first.handle(follow(response), 'main', signal()));
  assert.equal(f.sends.length, 1);
  assert.equal(JSON.parse(await readFile(f.sessionFile, 'utf8')).pending, false);
  await rm(archive, { recursive: true });
  await first.handle(follow(response), 'main', signal());
  assert.equal(f.sends.length, 2);
  await first.close();
  assert.deepEqual(await f.make().handle(body, 'main', signal()), response);
  assert.equal(f.sends.length, 2);
});

test('failed initial persistence closes the unused SDK agent and allows a safe startup retry', async (t) => {
  const f = await fixture(t);
  const gate = Promise.withResolvers<void>();
  f.delayCreate(gate.promise);
  const harness = f.make();
  const request = harness.handle(body, 'main', signal());
  while (!f.configurations.length) {
    await tick();
  }
  await mkdir(f.sessionFile);
  gate.resolve();
  await assert.rejects(request);
  assert.equal(f.sends.length, 0);
  assert.equal(f.closes(), 1);
  await rm(f.sessionFile, { recursive: true });
  await harness.handle(body, 'main', signal());
  assert.equal(f.configurations.length, 2);
  assert.equal(f.sends.length, 1);
});

test('new native dispatches recheck policy files while cached replies remain replayable', async (t) => {
  const f = await fixture(t);
  const first = f.make();
  const response = await first.handle(body, 'main', signal());
  const policy = path.join(f.directory, '.cursor', 'permissions.json');
  await mkdir(path.dirname(policy));
  await writeFile(policy, '{"deny":["Shell(rm)"]}');
  assert.deepEqual(await first.handle(body, 'main', signal()), response);
  await assert.rejects(
    first.handle(follow(response), 'main', signal()),
    /permissions.json.*unsupported/,
  );
  assert.equal(f.sends.length, 1);
  await rm(policy);
  await first.handle(follow(response), 'main', signal());
  assert.equal(f.sends.length, 2);
  assert.equal(f.configurations.length, 1);
});

test('resumed history fingerprints ignore moved cache markers and send only the new turn', async (t) => {
  const f = await fixture(t);
  const first = f.make();
  const initial: MessagesRequest = {
    ...body,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'private prior context', cache_control: { type: 'ephemeral' } },
        ],
      },
    ],
  };
  const response = await first.handle(initial, 'main', signal());
  await first.close();
  const second = f.make();
  const continued: MessagesRequest = {
    ...body,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'private prior context' }] },
      {
        role: 'assistant',
        content: response.content.map((block) => ({
          ...block,
          cache_control: { type: 'ephemeral' },
        })),
      },
      { role: 'user', content: 'new turn only' },
    ],
  };
  await second.handle(continued, 'main', signal());
  assert.deepEqual(f.resumed, ['agent-1']);
  assert.equal(f.sends.length, 2);
  assert.match(JSON.stringify(f.sends[1].prompt), /new turn only/);
  assert.doesNotMatch(
    JSON.stringify(f.sends[1].prompt),
    /private prior context|Compacting context/,
  );
  await assert.rejects(
    second.handle(
      { ...continued, messages: [{ role: 'user', content: 'edited past' }] },
      'main',
      signal(),
    ),
    /history changed/,
  );
  assert.equal(f.sends.length, 2);
});

test('incompatible and malformed manifests fail before replay or SDK resume', async (t) => {
  const f = await fixture(t);
  const first = f.make();
  await first.handle(body, 'main', signal());
  await first.close();
  const saved = JSON.parse(await readFile(f.sessionFile, 'utf8'));
  for (const patch of [
    { version: undefined, history: body.messages },
    { version: 2 },
    { historyLength: -1 },
    { historyLength: 1.5 },
    { historyHash: 'invalid' },
    { pending: 'false' },
    { replay: { key: 'invalid', events: [] } },
    {
      response: {
        id: 'fake',
        content: [{ type: 'tool_use', id: 'tool', name: 'Bash', input: {} }],
      },
    },
  ]) {
    await writeFile(f.sessionFile, JSON.stringify({ ...saved, ...patch }));
    await assert.rejects(f.make().handle(body, 'main', signal()), /incompatible or invalid state/);
  }
  assert.equal(f.sends.length, 1);
  assert.equal(f.resumed.length, 0);
});

test('native execution requires explicit permission context', async () => {
  const harness = new CursorHarness(models);
  await assert.rejects(
    harness.handle(body, 'main', signal()),
    /explicit Claude permission context/,
  );
  await harness.close();
});

test('restart recovers a terminal SDK result without sending or resuming an agent', async (t) => {
  const f = await fixture(t);
  await interruptedManifest(f);
  f.recover({ id: 'run', status: 'finished', result: 'Recovered completed edit' });
  const harness = f.make();
  const response = await harness.handle(body, 'main', signal());
  assert.deepEqual(response.content, [{ type: 'text', text: 'Recovered completed edit' }]);
  assert.equal(JSON.parse(await readFile(f.sessionFile, 'utf8')).pending, false);
  assert.equal(f.sends.length, 1);
  assert.equal(f.resumed.length, 0);
  assert.deepEqual(f.recoveryReads, ['run']);
  await harness.handle(follow(response), 'main', signal());
  assert.equal(f.sends.length, 2);
  assert.deepEqual(f.resumed, ['agent-1']);
});

test('restart refuses missing, running, or foreign SDK run evidence', async (t) => {
  const f = await fixture(t);
  await interruptedManifest(f);
  f.recover({ id: 'run', status: 'finished', result: 'unproven' }, 'running');
  await assert.rejects(f.make().handle(body, 'main', signal()), /no readable terminal result/);
  f.recover({ id: 'run', status: 'finished', result: 'foreign' }, 'finished', 'other-agent');
  await assert.rejects(f.make().handle(body, 'main', signal()), /identity/);
  const saved = JSON.parse(await readFile(f.sessionFile, 'utf8'));
  delete saved.pendingRun.runId;
  await writeFile(f.sessionFile, JSON.stringify(saved));
  await assert.rejects(f.make().handle(body, 'main', signal()), /no durable SDK run identity/);
  assert.equal(f.sends.length, 1);
  assert.equal(JSON.parse(await readFile(f.sessionFile, 'utf8')).pending, true);
});

test('recovered SDK failure stays a failed retry while a new observed turn retains native state', async (t) => {
  const f = await fixture(t);
  await interruptedManifest(f);
  f.recover({ id: 'run', status: 'error', error: { message: 'native action failed' } });
  const harness = f.make();
  await assert.rejects(harness.handle(body, 'main', signal()), /native action failed/);
  const next = { ...body, messages: [{ role: 'user', content: 'Inspect current state' }] };
  await assert.rejects(harness.handle(next, 'main', signal()), /new observed prompt/);
  await harness.handle(
    next,
    'main',
    signal(),
    undefined,
    submission('next', 'Inspect current state'),
  );
  assert.equal(f.sends.length, 2);
  assert.deepEqual(f.resumed, ['agent-1']);
  assert.doesNotMatch(JSON.stringify(f.sends[1].prompt), /first request/);
  await assert.rejects(harness.handle(body, 'main', signal()), /native action failed/);
});

test('external compaction uses only a new hook-confirmed prompt and preserves SDK state', async (t) => {
  const f = await fixture(t);
  const first = f.make();
  await first.handle(body, 'main', signal(), undefined, submission('initial', 'first request'));
  await first.close();
  const harness = f.make();
  const compacted: MessagesRequest = {
    ...body,
    messages: [
      { role: 'user', content: 'Compacted summary containing already completed actions' },
      { role: 'assistant', content: 'Summary acknowledged' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Continue ' },
          { type: 'text', text: 'safely' },
        ],
      },
    ],
  };
  await assert.rejects(
    harness.handle(
      compacted,
      'main',
      signal(),
      undefined,
      submission('initial', 'Continue safely'),
    ),
    /new observed prompt/,
  );
  await harness.handle(
    compacted,
    'main',
    signal(),
    undefined,
    submission('fresh', 'Continue safely'),
  );
  assert.equal(f.configurations.length, 1);
  assert.deepEqual(f.resumed, ['agent-1']);
  assert.match(JSON.stringify(f.sends[1].prompt), /Continue/);
  assert.doesNotMatch(
    JSON.stringify(f.sends[1].prompt),
    /Compacted summary|first request|Summary acknowledged/,
  );
  const changed = { ...compacted, messages: [{ role: 'user', content: 'Continue safely' }] };
  await assert.rejects(
    harness.handle(changed, 'main', signal(), undefined, submission('fresh', 'Continue safely')),
    /new observed prompt/,
  );
  assert.equal(f.sends.length, 2);
});

test('rewritten history uses a unique retained response anchor but rejects changed instructions', async (t) => {
  const f = await fixture(t);
  const harness = f.make();
  const response = await harness.handle(body, 'main', signal());
  const next: MessagesRequest = {
    ...body,
    messages: [
      { role: 'user', content: 'Rewritten or compacted earlier context' },
      { role: 'assistant', content: response.content },
      { role: 'user', content: 'New anchored task' },
    ],
  };
  await harness.handle(next, 'main', signal());
  assert.doesNotMatch(JSON.stringify(f.sends[1].prompt), /Rewritten|first request/);
  await assert.rejects(
    harness.handle(
      { ...next, system: 'changed instructions' },
      'main',
      signal(),
      undefined,
      submission('changed', 'New anchored task'),
    ),
    /instructions changed/,
  );
});

test('idle agent eviction retains disk state and resumes the original native agent', async (t) => {
  const f = await fixture(t);
  const harness = f.make();
  const first = await harness.handle(body, 'main', signal());
  for (let index = 0; index < 32; index++) {
    await harness.handle(body, `worker-${index}`, signal());
  }
  assert.equal(f.closes(), 1);
  await harness.handle(follow(first), 'main', signal());
  assert.equal(f.configurations.length, 33);
  assert.equal(f.resumed.at(-1), 'agent-1');
});

test('settled exchange eviction replays disk replies without repeating native work', async (t) => {
  const f = await fixture(t);
  const harness = f.make();
  let request = body;
  const first = await harness.handle(request, 'main', signal());
  let response = first;
  for (let index = 0; index < 256; index++) {
    request = {
      ...body,
      messages: [
        ...(request.messages ?? []),
        { role: 'assistant', content: response.content },
        { role: 'user', content: `turn ${index}` },
      ],
    };
    response = await harness.handle(request, 'main', signal());
  }
  assert.deepEqual(await harness.handle(body, 'main', signal()), first);
  assert.equal(f.sends.length, 257);
});
