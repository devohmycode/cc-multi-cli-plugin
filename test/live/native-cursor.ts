// Opt-in: real Cursor SDK inference, then real Claude main-model and subagent tools.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Agent, Cursor } from '@cursor/sdk';
import type { Run } from '@cursor/sdk';
import { CursorBridge } from '../../plugins/multi/src/lib/native-cursor.ts';
import { cursorModelOptions } from '../../plugins/multi/src/lib/native-cursor-models.ts';
import type { MessagesRequest } from '../../plugins/multi/src/lib/native-responses.ts';

if (!process.env.CURSOR_API_KEY && (await Cursor.auth.status()).status !== 'logged-in') {
  throw new Error('Cursor SDK login required: node plugins/multi/src/native-model-gateway.ts --cursor-login');
}
const catalog = cursorModelOptions(await Cursor.models.list());
const selected = process.argv[2] ? catalog.find(o => o.model === process.argv[2] || o.worker === process.argv[2]) : catalog.find(o => o.selection.id.startsWith('composer-') && o.model.split('/').length === 3);
assert(selected, 'Choose an account model/worker from the launcher --cursor-models output');
const cwd = await mkdtemp(path.join(os.tmpdir(), 'native-cursor-live-'));
const nonce = randomBytes(8).toString('hex');
const bridge = new CursorBridge([selected], { cwd });
try {
  const request: MessagesRequest = { model: selected.model, messages: [{ role: 'user', content:
    'Call the supplied Probe tool once with value hello. Wait for its result, then repeat the returned secret exactly. Do not guess it.' }],
    tools: [{ name: 'Probe', description: 'Retrieve the test secret', input_schema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }] };
  const first = await bridge.handle(request, 'live/probe', AbortSignal.timeout(120000));
  assert.equal(first.stop_reason, 'tool_use');
  const call = first.content.find(b => b.type === 'tool_use'); assert(call?.type === 'tool_use');
  assert.equal(call.name, 'Probe');
  const next: MessagesRequest = { ...request, messages: [...request.messages!, { role: 'assistant', content: first.content },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: `Secret: ${nonce}` }] }] };
  const result = await bridge.handle(next, 'live/probe', AbortSignal.timeout(120000));
  assert.equal(result.stop_reason, 'end_turn');
  assert(result.content.some(b => b.type === 'text' && b.text.includes(nonce)));
  console.log('PASS: real SDK callback paused and received the Claude-format tool result.');

  let pausedRun: Run | undefined;
  const cancellable = new CursorBridge([selected], { cwd, createAgent: async config => {
    const agent = await Agent.create(config);
    return { close: () => agent.close(), send: async (message, config) => {
      pausedRun = await agent.send(message, config); return pausedRun;
    } };
  } });
  try {
    await cancellable.handle(request, 'live/cancel', AbortSignal.timeout(120000));
    await cancellable.close();
    assert.equal((await pausedRun!.wait()).status, 'cancelled');
    console.log('PASS: gateway shutdown cancels a real SDK run waiting for a tool result.');
  } finally { await cancellable.close(); }

  await writeFile(path.join(cwd, 'fixture.txt'), `alpha ${nonce}\n`);
  const launcher = fileURLToPath(new URL('../../plugins/multi/src/native-model-gateway.ts', import.meta.url));
  async function run(args: string[]) {
    const child = spawn(process.execPath, args, { cwd, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, MULTI_NATIVE_TRACE: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_MAX_RETRIES: '0' } });
    let output = '', error = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { error += chunk; process.stderr.write(chunk); });
    const timer = setTimeout(() => {
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM'); else child.kill(); } catch {}
    }, 180000);
    try {
      const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      assert.equal(code, 0, error + '\n' + output);
      return { output, error };
    } finally { clearTimeout(timer); }
  }
  const session = randomUUID();
  const main = await run([launcher, '--', '-p', 'Read fixture.txt, then use Edit to replace alpha with beta. Preserve the rest and report the complete resulting line.',
    '--model', selected.model, '--tools', 'Read,Edit', '--allowedTools', 'Read,Edit', '--strict-mcp-config', '--setting-sources', '',
    '--disable-slash-commands', '--session-id', session, '--output-format', 'stream-json', '--verbose']);
  assert.equal(await readFile(path.join(cwd, 'fixture.txt'), 'utf8'), `beta ${nonce}\n`);
  assert(main.error.includes('"tools":["Read"]'));
  assert(main.error.includes('"tools":["Edit"]'));
  const events = main.output.trim().split('\n').map(line => JSON.parse(line));
  assert(events.some(event => event.type === 'result' && !event.is_error && event.result?.includes(nonce)));
  console.log('PASS: Cursor main model requested native Claude Read/Edit and completed.');
  for (const model of ['sonnet', selected.model]) {
    const switched = await run([launcher, '--', '-p', 'Without tools, repeat the exact full resulting line of fixture.txt from the earlier conversation.',
      '--resume', session, '--model', model, '--tools', '', '--strict-mcp-config', '--setting-sources', '',
      '--disable-slash-commands', '--output-format', 'stream-json', '--verbose']);
    const events = switched.output.trim().split('\n').map(line => JSON.parse(line));
    assert(events.some(event => event.type === 'result' && !event.is_error && event.result?.includes(nonce)));
    assert(switched.error.includes(model === 'sonnet' ? '"route":"anthropic","status":200' : '"route":"cursor"'));
  }
  console.log('PASS: Cursor → Claude → Cursor with saved history and fresh gateway processes.');
  const workerTest = fileURLToPath(new URL('./native-model-gateway.ts', import.meta.url));
  const worker = await run([workerTest, selected.worker]);
  process.stdout.write(worker.output);
} finally {
  await bridge.close();
  await rm(cwd, { recursive: true, force: true });
}
