import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import vm from 'node:vm';
import {
  AntigravityCliError,
  type AntigravityStreamEvent,
  runAntigravity,
} from '../../plugins/multi-antigravity/src/cli.ts';

const script = `#!/bin/bash
if [[ -n "$AGY_ARGS_FILE" ]]; then printf '%s\n' "$@" > "$AGY_ARGS_FILE"; fi
prompt="$2"
if [[ "$1" == "--input-format" ]]; then prompt=""; fi
if [[ -z "$prompt" ]]; then
  IFS= read -r input
  case "$input" in *large-stdin*) prompt=large-stdin ;; esac
fi
case "$prompt" in
  missing) exit 0 ;;
  invalid) printf '%s\n' '{not-json}' ;;
  large) head -c 10000 /dev/zero ;;
  large-stdin) status=SUCCESS; code=0 ;;
  cancel) printf '%s\n' '{"event":"init","conversation_id":"cancel","init":{}}'; trap '' INT TERM; while :; do sleep 1; done ;;
  close-descendant) (trap '' INT TERM; while :; do sleep 1; done) >/dev/null 2>&1 &
    echo "$!" > "$AGY_PID_FILE"; exit 0 ;;
  error) status=ERROR; code=2 ;;
  *) status=SUCCESS; code=0 ;;
esac
printf '%s\n' '{"event":"future","ignored":true}'
printf '%s\n' '{"event":"init","conversation_id":"conv-1","init":{"model":"gemini-test"}}'
printf '%s\n' '{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"hello"}}'
printf '%s\n' "{\\"event\\":\\"result\\",\\"result\\":{\\"conversation_id\\":\\"conv-1\\",\\"status\\":\\"$status\\",\\"response\\":\\"done\\",\\"usage\\":{\\"input_tokens\\":4,\\"cache_read_tokens\\":3,\\"total_tokens\\":7}}}"
printf '%s\n' diagnostic >&2
exit "$code"
`;

const windowsScript = String.raw`const fs = require('node:fs');
const promptIndex = process.argv.indexOf('-p');
let prompt = promptIndex >= 0 ? process.argv[promptIndex + 1] : '';
if (!prompt) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => { if (input.includes('large-stdin')) prompt = 'large-stdin'; run(); });
} else { run(); }
function run() {
  if (process.env.AGY_ARGS_FILE) fs.writeFileSync(process.env.AGY_ARGS_FILE, process.argv.slice(2).join('\n') + '\n');
  if (prompt === 'missing') return process.exit(0);
  if (prompt === 'invalid') { console.log('{not-json}'); return; }
  if (prompt === 'large') { process.stdout.write('x'.repeat(10000)); return; }
  if (prompt === 'cancel') { console.log(JSON.stringify({ event: 'init', conversation_id: 'cancel', init: {} })); process.on('SIGINT', () => {}); process.on('SIGTERM', () => {}); return setInterval(() => {}, 1000); }
  if (prompt === 'close-descendant') return process.exit(0);
  const status = prompt === 'error' ? 'ERROR' : 'SUCCESS';
  console.log(JSON.stringify({ event: 'future', ignored: true }));
  console.log(JSON.stringify({ event: 'init', conversation_id: 'conv-1', init: { model: 'gemini-test' } }));
  console.log(JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'hello' } }));
  console.log(JSON.stringify({ event: 'result', result: { conversation_id: 'conv-1', status, response: 'done', usage: { input_tokens: 4, cache_read_tokens: 3, total_tokens: 7 } } }));
  console.error('diagnostic');
  process.exit(status === 'ERROR' ? 2 : 0);
}
`;

async function fakeCli(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'antigravity-cli-'));
  const executable =
    process.platform === 'win32' ? path.join(directory, 'agy.cmd') : path.join(directory, 'agy');
  if (process.platform === 'win32') {
    const fixture = path.join(directory, 'agy-fixture.cjs');
    const source = windowsScript.replaceAll('\n', '\r\n');
    await writeFile(fixture, source, 'utf8');
    const emittedSource = await readFile(fixture, 'utf8');
    assert.doesNotThrow(() => new vm.Script(emittedSource));
    assert.match(emittedSource, /join\('\\n'\)/);
    assert.doesNotMatch(emittedSource, /(?<!\r)\n/);
    const shim = `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`;
    await writeFile(executable, shim, 'utf8');
    assert.equal(await readFile(executable, 'utf8'), shim);
  } else {
    await writeFile(executable, script, 'utf8');
    await chmod(executable, 0o700);
  }
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { cwd: directory, executable };
}

const execFileAsync = promisify(execFile);

function isCliError(error: unknown): error is AntigravityCliError {
  return error instanceof AntigravityCliError;
}

test('Windows fixture emits the same NDJSON stream as the POSIX fixture', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX fixture requires Bash');
    return;
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'antigravity-fixture-'));
  const posixFixture = path.join(directory, 'agy');
  const windowsFixture = path.join(directory, 'agy-fixture.cjs');
  await writeFile(posixFixture, script, 'utf8');
  await chmod(posixFixture, 0o700);
  const windowsSource = windowsScript.replaceAll(/\r?\n/g, '\r\n');
  await writeFile(windowsFixture, windowsSource, 'utf8');
  const emittedSource = await readFile(windowsFixture, 'utf8');
  assert.doesNotThrow(() => new vm.Script(emittedSource));
  assert.match(emittedSource, /join\('\\n'\)/);
  assert.doesNotMatch(emittedSource, /(?<!\r)\n/);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const [posix, windows] = await Promise.all([
    execFileAsync(posixFixture, ['-p', 'hello']),
    execFileAsync(process.execPath, [windowsFixture, '-p', 'hello']),
  ]);
  assert.equal(windows.stdout, posix.stdout);
  assert.equal(windows.stderr, posix.stderr);
  await rm(directory, { recursive: true, force: true });
});

test('runs agy with explicit flags and parses typed NDJSON events', async (t) => {
  const cli = await fakeCli(t);
  const argsFile = path.join(cli.cwd, 'args.txt');
  const events: AntigravityStreamEvent[] = [];
  const output = await runAntigravity({
    cwd: cli.cwd,
    executable: cli.executable,
    prompt: 'hello',
    model: 'gemini-test',
    effort: 'high',
    conversation: 'prior-conversation',
    agent: 'worker',
    mode: 'plan',
    env: { AGY_ARGS_FILE: argsFile },
    signal: AbortSignal.timeout(5000),
    onEvent: (event) => events.push(event),
  });
  assert.equal(output.result.conversation_id, 'conv-1');
  assert.equal(output.result.status, 'SUCCESS');
  assert.equal(output.result.usage?.cache_read_tokens, 3);
  assert.equal(output.exitCode, 0);
  assert.equal(output.stderr, 'diagnostic\n');
  const args = (await readFile(argsFile, 'utf8')).trim().split('\n');
  const addDirIndex = args.indexOf('--add-dir');
  assert.equal(args[addDirIndex + 1], cli.cwd);
  assert.equal(args.includes('--new-project'), false);
  assert.equal(args.includes('--dangerously-skip-permissions'), true);
  const modeIndex = args.indexOf('--mode');
  assert.equal(args[modeIndex + 1], 'plan');
  assert.deepEqual(
    events.map((event) => event.event),
    ['init', 'step_update', 'result'],
  );
});

test('starts a new conversation in an isolated Antigravity project', async (t) => {
  const cli = await fakeCli(t);
  const argsFile = path.join(cli.cwd, 'args.txt');
  await runAntigravity({
    cwd: cli.cwd,
    executable: cli.executable,
    prompt: 'hello',
    env: { AGY_ARGS_FILE: argsFile },
    signal: AbortSignal.timeout(5000),
  });
  const args = (await readFile(argsFile, 'utf8')).trim().split('\n');
  assert.equal(args.includes('--new-project'), true);
  assert.equal(args.includes('--dangerously-skip-permissions'), true);
  assert.equal(args.includes('--mode'), false);
});

test('preserves a terminal provider error even with a nonzero exit code', async (t) => {
  const cli = await fakeCli(t);
  const output = await runAntigravity({
    cwd: cli.cwd,
    executable: cli.executable,
    prompt: 'error',
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(output.result.status, 'ERROR');
  assert.equal(output.exitCode, 2);
});

test('never infers success when agy exits without a result event', async (t) => {
  const cli = await fakeCli(t);
  await assert.rejects(
    runAntigravity({
      cwd: cli.cwd,
      executable: cli.executable,
      prompt: 'missing',
      signal: AbortSignal.timeout(5000),
    }),
    (error: unknown) => isCliError(error) && error.code === 'no_terminal_result',
  );
});

test('rejects malformed or oversized output', async (t) => {
  const cli = await fakeCli(t);
  await assert.rejects(
    runAntigravity({
      cwd: cli.cwd,
      executable: cli.executable,
      prompt: 'invalid',
      signal: AbortSignal.timeout(5000),
    }),
    (error: unknown) => isCliError(error) && error.code === 'parse',
  );
  await assert.rejects(
    runAntigravity({
      cwd: cli.cwd,
      executable: cli.executable,
      prompt: 'large',
      maxOutputBytes: 100,
      signal: AbortSignal.timeout(5000),
    }),
    (error: unknown) => isCliError(error) && error.code === 'output_limit',
  );
});

test('delivers an oversized prompt through stream-json stdin', async (t) => {
  const cli = await fakeCli(t);
  const output = await runAntigravity({
    cwd: cli.cwd,
    executable: cli.executable,
    prompt: `large-stdin ${'x'.repeat(128 * 1024)}`,
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(output.result.status, 'SUCCESS');
});

test('escalates cancellation and reports missing terminal evidence as aborted', async (t) => {
  const cli = await fakeCli(t);
  const controller = new AbortController();
  const pending = runAntigravity({
    cwd: cli.cwd,
    executable: cli.executable,
    prompt: 'cancel',
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, (error: unknown) => isCliError(error) && error.code === 'aborted');
});

test('cleans an ignored-signal descendant when the CLI closes first', async (t) => {
  if (process.platform === 'win32') {
    t.skip(
      'Windows taskkill tree semantics do not provide a POSIX ignored-signal descendant equivalent',
    );
    return;
  }
  const cli = await fakeCli(t);
  const pidFile = path.join(cli.cwd, 'descendant.pid');
  await assert.rejects(
    runAntigravity({
      cwd: cli.cwd,
      executable: cli.executable,
      prompt: 'close-descendant',
      env: { AGY_PID_FILE: pidFile },
      signal: AbortSignal.timeout(5000),
    }),
    (error: unknown) => isCliError(error) && error.code === 'no_terminal_result',
  );
  const pid = Number(await readFile(pidFile, 'utf8'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});
