// Opt-in unmodified Claude CLI check. All model replies are local fixtures; no provider usage.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { MessagesResponse } from '../../plugins/multi-core/src/gateway/messages.ts';
import { PermissionModes } from '../../plugins/multi-core/src/gateway/mode-hook.ts';
import { hookCommand } from '../../plugins/multi-core/src/gateway/permission-hook.ts';
import type { GatewayEvent } from '../../plugins/multi-core/src/gateway/server.ts';
import { createNativeGateway } from '../../plugins/multi-core/src/gateway/server.ts';

const root = await mkdtemp('/tmp/mode-hook-cli-');
const worktree = process.argv.includes('--worktree');
if (worktree) {
  await promisify(execFile)('git', ['init', '--quiet', root]);
  await promisify(execFile)(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'Fixture',
    ],
    { cwd: root },
  );
}
const definitions = {
  'proof-worker': {
    description: 'Offline fixture',
    prompt: 'Reply OK',
    tools: [],
    permissionMode: 'plan',
    model: 'multi/cursor/worker',
  },
};
const modes = new PermissionModes(async () => definitions);
const events: GatewayEvent[] = [];
let mainCalls = 0;
const server = createNativeGateway({
  token: 'proof-token',
  authFile: 'unused',
  permissionModes: modes,
  onEvent: (e) => events.push(e),
  cursor: {
    validate: () => 0,
    async handle(body, _scope, _signal, emit) {
      const worker = body.model?.endsWith('/worker');
      const delegate = !worker && mainCalls++ === 0;
      const result: MessagesResponse = {
        id: 'msg_proof',
        type: 'message',
        role: 'assistant',
        model: body.model ?? '',
        content: delegate
          ? [
              {
                type: 'tool_use',
                id: 'toolu_proof',
                name: 'Agent',
                input: {
                  subagent_type: 'proof-worker',
                  description: 'Offline check',
                  prompt: 'Reply OK',
                  ...(worktree ? { isolation: 'worktree' } : {}),
                },
              },
            ]
          : [{ type: 'text', text: 'OFFLINE_MODE_OK' }],
        stop_reason: delegate ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      };
      if (emit) {
        emit('message_start', { message: { ...result, content: [], stop_reason: null } });
        const block = result.content[0];
        assert(block.type === 'text' || block.type === 'tool_use');
        emit('content_block_start', {
          index: 0,
          content_block:
            block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} },
        });
        emit('content_block_delta', {
          index: 0,
          delta:
            block.type === 'text'
              ? { type: 'text_delta', text: block.text }
              : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
        });
        emit('content_block_stop', { index: 0 });
        emit('message_delta', {
          delta: { stop_reason: result.stop_reason, stop_sequence: null },
          usage: result.usage,
        });
        emit('message_stop', {});
      }
      return result;
    },
  },
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const command = hookCommand(
  new URL('../../plugins/multi-core/src/gateway/mode-hook.ts', import.meta.url),
);
await writeFile(
  `${root}/settings.json`,
  JSON.stringify({
    hooks: Object.fromEntries(
      ['UserPromptSubmit', 'SubagentStart'].map((name) => [
        name,
        [{ hooks: [{ type: 'command', command, timeout: 10 }] }],
      ]),
    ),
  }),
);
const address = server.address();
assert(address && typeof address !== 'string');
const child = spawn(
  'claude',
  [
    '-p',
    'Reply OFFLINE_MODE_OK',
    '--model',
    'multi/cursor/main',
    '--permission-mode',
    'default',
    '--tools',
    'Agent',
    '--allowedTools',
    'Agent',
    '--agents',
    JSON.stringify(definitions),
    '--settings',
    `${root}/settings.json`,
    '--setting-sources',
    '',
    '--strict-mcp-config',
  ],
  {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      CLAUDE_CONFIG_DIR: root,
      ANTHROPIC_AUTH_TOKEN: 'offline-proof',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      ANTHROPIC_CUSTOM_HEADERS: 'x-multi-gateway-token: proof-token',
      MULTI_GATEWAY_TOKEN: 'proof-token',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_MAX_RETRIES: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let stdout = '';
let stderr = '';
child.stdout.on('data', (v) => (stdout += v));
child.stderr.on('data', (v) => (stderr += v));
const timer = setTimeout(() => child.kill('SIGTERM'), 30000);
const code = await new Promise<number | null>((resolve, reject) => {
  child.on('exit', resolve);
  child.on('error', reject);
});
clearTimeout(timer);
server.closeAllConnections();
server.close();
await writeFile(`${root}/report.json`, JSON.stringify({ code, stdout, stderr, events }, null, 2));
console.log(`Offline hook proof: ${root}/report.json`);
assert.equal(code, 0);
assert(events.some((e) => e.agentId && e.permissionContext?.permissionMode === 'plan'));
assert(events.some((e) => !e.agentId && e.permissionContext?.permissionMode === 'default'));
assert(events.some((e) => !e.agentId && e.permissionContext?.submission?.promptHash));
assert(events.every((e) => !e.agentId || !e.permissionContext?.submission));
if (worktree) {
  assert(
    events.some((e) => e.agentId && e.permissionContext?.cwd && e.permissionContext.cwd !== root),
    'Worktree worker hook must identify its actual workspace',
  );
}
