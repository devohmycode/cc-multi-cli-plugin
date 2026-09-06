// Opt-in live test: uses existing Claude and Codex subscriptions.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OPENAI_WORKERS } from '../lib/native-gateway.ts';

/** The Claude Code stream-json events this reproducer inspects. */
interface ClaudeEvent {
  type: string;
  subtype?: string;
  result?: string;
  is_error?: boolean;
  subagent_stats?: { completed?: number };
  permission_denials?: unknown;
  apiKeySource?: string;
}

/** One `[native] ` trace line the gateway writes to stderr. */
interface TraceEvent { route?: string; model?: string; effort?: string }

const worker = process.argv[2] ?? 'openai-native';
assert(Object.hasOwn(OPENAI_WORKERS, worker), 'Pass a registered native worker name');
const launcher = fileURLToPath(new URL('../native-model-gateway.ts', import.meta.url));
const cwd = await mkdtemp(path.join(os.tmpdir(), 'native-live-smoke-'));
const nonce = randomBytes(6).toString('hex');
await writeFile(path.join(cwd, 'fixture.txt'), `alpha ${nonce}\n`);
try {
  const child = spawn(process.execPath, [launcher, '--', '-p',
    `Delegate to ${worker}: read fixture.txt, then use Edit to replace alpha with beta while preserving the remaining text. Have the worker report the exact resulting line. Wait for completion. Do not read or edit the file yourself.`,
    '--model', 'sonnet', '--effort', 'low', '--system-prompt', 'You coordinate a small native subagent integration test. Use the requested worker and report its result.',
    '--tools', 'Agent,Read,Edit', '--allowedTools', 'Agent,Read,Edit',
    '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands',
    '--no-session-persistence', '--output-format', 'stream-json', '--verbose'
  ], { cwd, detached: true, env: { ...process.env, MULTI_NATIVE_TRACE: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_MAX_RETRIES: '0', CLAUDE_CODE_MAX_TURNS: '8' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', diagnostics = '';
  assert(child.stdout && child.stderr, 'Piped child streams');
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { diagnostics += chunk; process.stderr.write(chunk); });
  const timer = setTimeout(() => { try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); } catch {} }, 120000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  clearTimeout(timer);
  const events: ClaudeEvent[] = output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const results = events.filter(e => e.type === 'result').map(e => ({ result: e.result, is_error: e.is_error,
    subagent_stats: e.subagent_stats, permission_denials: e.permission_denials }));
  const content = await readFile(path.join(cwd, 'fixture.txt'), 'utf8');
  console.log(JSON.stringify({ code, results, fileCorrect: content === `beta ${nonce}\n`,
    auth: events.find(e => e.type === 'system' && e.subtype === 'init')?.apiKeySource }, null, 2));
  assert.equal(code, 0);
  assert.equal(content, `beta ${nonce}\n`);
  assert(results.some(e => !e.is_error && e.result?.includes(nonce)));
  assert(diagnostics.includes('"route":"anthropic","status":200'));
  const { model, effort } = OPENAI_WORKERS[worker];
  assert(diagnostics.includes(`"model":"multi/openai/${model}"`));
  const requests: TraceEvent[] = diagnostics.split('\n').filter(line => line.startsWith('[native] '))
    .map(line => JSON.parse(line.slice('[native] '.length))).filter((event: TraceEvent) => event.route === 'openai-request');
  assert(requests.length >= 3, 'Expected external tool calls and completion');
  assert(requests.every(request => request.model === model && request.effort === effort), 'Wrong upstream model or effort');
  assert(diagnostics.includes('"tools":["Read"]'));
  assert(diagnostics.includes('"tools":["Edit"]'));
  console.log(`PASS: real Claude parent + ${worker} (${model}, ${effort}) + native Read/Edit + completion.`);
} finally { await rm(cwd, { recursive: true, force: true }); }
