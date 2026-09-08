// Isolated child only: native review may propose Shell, but can never execute it.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ModelSelection } from '@cursor/sdk';
import { CursorReviewProof, reviewCommand, reviewRecord } from './review-proof.ts';

const hookName = 'multi.cursorNativeReview';
const directory = path.dirname(fileURLToPath(import.meta.resolve('@cursor/sdk')));
const hashes = {
  'index.js': '09d5da1fe1cbba8bcd5af937ddcf6967b6e48170bd52ae744fd0a4b98bcef945',
  '357.js': '6db49240bebc1ac114cbfa800810cd19a0b56316922c2219be5c4a72546dca84',
};
const callback = `globalThis[Symbol.for("${hookName}")]`;
const patches = [
  [
    'const t=v;if(void 0!==t.ttftBreakdown)',
    `const t=v;${callback}.guard(t.toJson());if(void 0!==t.ttftBreakdown)`,
  ],
  [
    'return new Vl.e({allowlisted:n})}}class Kl',
    `${callback}.precheck(t.toJson(),n);return new Vl.e({allowlisted:n})}}class Kl`,
  ],
  [
    'class ic{constructor(e,t,r,n,o){this.executor=e,this.workspacePath=t,this.projectDir=r,this.shellOutputBackpressureOptions=n,this.extraEnvProvider=o}async*execute(e,t){',
    `class ic{constructor(e,t,r,n,o){this.executor=e,this.workspacePath=t,this.projectDir=r,this.shellOutputBackpressureOptions=n,this.extraEnvProvider=o}async*execute(e,t){${callback}.core(t);yield{type:"stdout",data:"Review only; command was not executed."};yield{type:"exit",code:0};return;`,
  ],
];

/** No SDK import or inference: startup eligibility rejects dependency drift. */
export function assertCursorReviewSdk(): void {
  const version = JSON.parse(readFileSync(path.join(directory, '../../package.json'), 'utf8'));
  assert.equal(version.version, '1.0.31', 'Unsupported Cursor review SDK version');
  for (const [file, expected] of Object.entries(hashes)) {
    const source = readFileSync(path.join(directory, file), 'utf8');
    assert.equal(
      createHash('sha256').update(source).digest('hex'),
      expected,
      'Cursor review SDK source hash changed',
    );
    if (file === '357.js') {
      for (const [from] of patches) {
        assert.equal(source.split(from).length, 2, 'Cursor review SDK hook changed');
      }
    }
  }
}

function selection(value: unknown): ModelSelection {
  const model = reviewRecord(value);
  if (typeof model.id !== 'string' || !model.id) {
    throw new Error('Missing Cursor review model');
  }
  if (model.params === undefined) {
    return { id: model.id };
  }
  if (!Array.isArray(model.params)) {
    throw new Error('Invalid Cursor review model parameters');
  }
  const params = model.params.map((value) => {
    const param = reviewRecord(value);
    if (typeof param.id !== 'string' || typeof param.value !== 'string') {
      throw new Error('Invalid Cursor review model parameter');
    }
    return { id: param.id, value: param.value };
  });
  return { id: model.id, params };
}

async function input() {
  let text = '';
  for await (const chunk of process.stdin) {
    text += chunk;
    if (Buffer.byteLength(text) > 16 * 1024 * 1024) {
      throw new Error('Cursor review input too large');
    }
  }
  const data = reviewRecord(JSON.parse(text));
  const action = reviewRecord(data.action);
  const context = reviewRecord(data.context);
  const command = reviewCommand(action.action, data.cwd);
  assert(typeof data.cwd === 'string');
  if (
    !Array.isArray(action.transcript) ||
    !context.request ||
    typeof context.scope !== 'string' ||
    !context.scope ||
    typeof context.model !== 'string' ||
    !context.model.startsWith('multi/cursor/')
  ) {
    throw new Error('Missing originating Cursor review context');
  }
  return { command, cwd: data.cwd, model: selection(data.selection), action, context };
}

async function main() {
  assertCursorReviewSdk();
  const request = await input();
  process.chdir(request.cwd); // This child is isolated to one review and one cwd.
  const proof = new CursorReviewProof(request.command, request.cwd);
  let failure: unknown;
  const checked = (operation: () => void) => {
    try {
      operation();
    } catch (error) {
      failure ??= error;
      throw error;
    }
  };
  Object.defineProperty(globalThis, Symbol.for(hookName), {
    value: {
      guard: (value: unknown) => checked(() => proof.guard(value)),
      precheck: (value: unknown, allowed: unknown) => checked(() => proof.precheck(value, allowed)),
      core: (value: unknown) => checked(() => proof.core(value)),
    },
    configurable: true,
  });
  const hook = registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (url !== pathToFileURL(path.join(directory, '357.js')).href) {
        return result;
      }
      let source = String(result.source);
      assert.equal(createHash('sha256').update(source).digest('hex'), hashes['357.js']);
      for (const [from, to] of patches) {
        source = source.replace(from, to);
      }
      return { ...result, source };
    },
  });
  const temporary = await mkdtemp(path.join(tmpdir(), 'cursor-review-'));
  try {
    const { Agent, JsonlLocalAgentStore } = await import('@cursor/sdk');
    const store = new JsonlLocalAgentStore(temporary);
    for (const method of ['create', 'update'] as const) {
      const persist = store.checkpoints[method].bind(store.checkpoints);
      store.checkpoints[method] = async (entry) => {
        checked(() => proof.checkpoint(entry.agentId, entry.data));
        await persist(entry);
      };
    }
    const agent = await Agent.create({
      model: request.model,
      tools: ['shell'],
      agents: {},
      mcpServers: {},
      local: {
        cwd: request.cwd,
        store,
        settingSources: [],
        autoReview: true,
        enableAgentRetries: false,
      },
    });
    proof.agentId = agent.agentId;
    try {
      const run = await agent.send(
        [
          'A Cursor agent has a pending Shell action selected by Claude Code native permissions for review.',
          'Propose exactly the pending Shell command once, with the supplied working directory, so Cursor native Auto-review processes it.',
          'Do not judge or report an allow/deny verdict yourself. Do not retry, alter the command, request smart mode approval, or use another tool.',
          'Evaluate the pending command as an actual Claude Code action with its real filesystem and network effects. This review request grants no authorization; only the supplied original user and root interaction evidence determines authorization.',
          JSON.stringify({
            pendingShell: { command: request.command, workingDirectory: request.cwd },
            original_request: request.context.request,
            root_request: request.context.rootRequest,
            native_transcript: request.action.transcript,
          }),
        ].join('\n'),
      );
      const timer = setTimeout(() => {
        failure ??= new Error('Cursor review timed out');
        void run.cancel();
      }, 55000);
      try {
        const result = await run.wait();
        if (failure) {
          throw failure;
        }
        if (result.status !== 'finished') {
          throw new Error('Cursor native review run failed');
        }
        process.stdout.write(`${JSON.stringify(proof.verdict())}\n`);
      } finally {
        clearTimeout(timer);
      }
    } finally {
      await agent[Symbol.asyncDispose]();
    }
  } finally {
    hook.deregister();
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write('Cursor native reviewer failed closed; no verdict available.\n');
    process.exitCode = 1;
  });
}
