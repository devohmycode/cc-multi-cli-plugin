import { type ChildProcess, spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

type AntigravityStatus =
  | 'SUCCESS'
  | 'ERROR'
  | 'CANCELED'
  | 'INTERRUPTED'
  | 'INVALID'
  | 'WAITING'
  | 'RUNNING';

export interface AntigravityUsage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
}

interface AntigravityInit {
  cwd?: string;
  tools?: string[];
  permission_mode?: string;
  model?: string;
  agent?: string;
  [key: string]: unknown;
}

interface AntigravityStepUpdate {
  conversation_id?: string;
  step_index?: number;
  state?: string;
  step_type?: string;
  tool_name?: string;
  text_delta?: string;
  duration_seconds?: number;
  usage?: AntigravityUsage;
  tool_info?: Record<string, unknown>;
  subagent_info?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AntigravityResult {
  conversation_id: string;
  status: AntigravityStatus;
  response: string;
  error?: string;
  duration_seconds?: number;
  num_turns?: number;
  usage?: AntigravityUsage;
  [key: string]: unknown;
}

export type AntigravityStreamEvent =
  | { event: 'init'; conversation_id: string; init: AntigravityInit }
  | { event: 'step_update'; step_update: AntigravityStepUpdate }
  | { event: 'result'; result: AntigravityResult };

export interface AntigravityRunOptions {
  cwd: string;
  prompt: string;
  signal: AbortSignal;
  model?: string;
  effort?: 'low' | 'medium' | 'high';
  conversation?: string;
  agent?: string;
  mode?: 'plan';
  newProject?: boolean;
  printTimeout?: string;
  env?: NodeJS.ProcessEnv;
  executable?: string;
  maxOutputBytes?: number;
  onEvent?: (event: AntigravityStreamEvent) => void;
}

export interface AntigravityRunResult {
  result: AntigravityResult;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

export class AntigravityCliError extends Error {
  readonly code: 'spawn' | 'output_limit' | 'parse' | 'no_terminal_result' | 'aborted';
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;

  constructor(
    message: string,
    code: AntigravityCliError['code'],
    details: { exitCode?: number | null; signal?: NodeJS.Signals | null; stderr?: string } = {},
  ) {
    super(message);
    this.name = 'AntigravityCliError';
    this.code = code;
    this.exitCode = details.exitCode ?? null;
    this.signal = details.signal ?? null;
    this.stderr = details.stderr ?? '';
  }
}

const defaultMaxOutputBytes = 8 * 1024 * 1024;
const promptArgumentLimitBytes = 128 * 1024;
const interruptGraceMs = 1500;
const terminateGraceMs = 1500;

export function runAntigravity(options: AntigravityRunOptions): Promise<AntigravityRunResult> {
  const promptOnStdin = Buffer.byteLength(options.prompt) >= promptArgumentLimitBytes;
  const args = promptOnStdin
    ? ['--input-format', 'stream-json', '--output-format', 'stream-json']
    : ['-p', options.prompt, '--output-format', 'stream-json'];
  args.push('--disable-slash-commands');
  if (options.model) {
    args.push('--model', options.model);
  }
  if (options.effort) {
    args.push('--effort', options.effort);
  }
  if (options.conversation) {
    args.push('--conversation', options.conversation);
  }
  if (options.agent) {
    args.push('--agent', options.agent);
  }
  args.push('--add-dir', options.cwd);
  if (options.newProject ?? !options.conversation) {
    args.push('--new-project');
  }
  if (options.mode) {
    args.push('--mode', options.mode);
  }
  if (options.printTimeout) {
    args.push('--print-timeout', options.printTimeout);
  }
  // Native Ask/Deny config is bypassed on purpose: headless Ask is a denial and
  // nobody using this gateway maintains native config. Claude's rules and the
  // gateway's own pre-tool hook are the only enforcement that matters.
  args.push('--dangerously-skip-permissions');

  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(options.executable ?? 'agy', args, {
        cwd: options.cwd,
        env: antigravityEnvironment(options.env),
        detached: process.platform === 'linux',
        shell: false,
        stdio: [promptOnStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      reject(new AntigravityCliError(`Failed to start agy: ${String(error)}`, 'spawn'));
      return;
    }

    const maxOutputBytes = options.maxOutputBytes ?? defaultMaxOutputBytes;
    const stdoutDecoder = new StringDecoder('utf8');
    let stdoutBuffer = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stderr = '';
    const parser: ParserState = { initSeen: false };
    let aborted = false;
    let interruptTimer: NodeJS.Timeout | undefined;
    let terminateTimer: NodeJS.Timeout | undefined;
    let settled = false;

    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) {
        return;
      }
      try {
        if (process.platform === 'linux') {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch {
        // The process may have exited between escalation steps.
      }
    };
    const stop = () => {
      kill('SIGINT');
      interruptTimer = setTimeout(() => {
        kill('SIGTERM');
        terminateTimer = setTimeout(() => kill('SIGKILL'), terminateGraceMs);
      }, interruptGraceMs);
    };
    const clearTimers = () => {
      clearTimeout(interruptTimer);
      clearTimeout(terminateTimer);
    };
    const fail = (error: AntigravityCliError) => {
      if (!parser.failure) {
        parser.failure = error;
        stop();
      }
    };
    const emit = (event: AntigravityStreamEvent) => {
      try {
        options.onEvent?.(event);
      } catch (error) {
        fail(
          new AntigravityCliError(`Antigravity event handler failed: ${String(error)}`, 'parse'),
        );
      }
    };
    const consumeStdout = (chunk: Buffer) => {
      if (parser.failure) {
        return;
      }
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxOutputBytes) {
        fail(
          new AntigravityCliError('Antigravity stdout exceeded its safety limit', 'output_limit'),
        );
        return;
      }
      stdoutBuffer += stdoutDecoder.write(chunk);
      let newline = stdoutBuffer.indexOf('\n');
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline).replace(/\r$/, '');
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        parseLine(line, parser, emit, fail);
        newline = stdoutBuffer.indexOf('\n');
      }
      if (stdoutBuffer.length > maxOutputBytes) {
        fail(
          new AntigravityCliError(
            'Antigravity stdout line exceeded its safety limit',
            'output_limit',
          ),
        );
      }
    };
    const consumeStderr = (chunk: Buffer) => {
      if (parser.failure) {
        return;
      }
      stderrBytes += chunk.byteLength;
      if (stderrBytes > maxOutputBytes) {
        fail(
          new AntigravityCliError('Antigravity stderr exceeded its safety limit', 'output_limit'),
        );
        return;
      }
      stderr += chunk.toString('utf8');
    };
    const onAbort = () => {
      if (!aborted) {
        aborted = true;
        stop();
      }
    };
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) {
        return;
      }
      settled = true;
      options.signal.removeEventListener('abort', onAbort);
      stdoutBuffer += stdoutDecoder.end();
      if (stdoutBuffer && !parser.failure) {
        parseLine(stdoutBuffer, parser, emit, fail);
      }
      clearTimers();
      if (aborted || parser.failure || !parser.terminal) {
        kill('SIGKILL');
      }
      const safeStderr = redactStderr(stderr);
      const final = finishValue(parser, aborted, exitCode, signal, safeStderr);
      if (final instanceof AntigravityCliError) {
        reject(final);
        return;
      }
      resolve({ result: final, exitCode, signal, stderr: safeStderr });
    };

    child.stdout?.on('data', consumeStdout);
    child.stderr?.on('data', consumeStderr);
    child.once('error', (error) => {
      fail(new AntigravityCliError(`agy failed to start: ${error.message}`, 'spawn'));
    });
    child.stdin?.on('error', (error) => {
      fail(new AntigravityCliError(`agy stdin failed: ${error.message}`, 'spawn'));
    });
    child.once('close', finish);
    options.signal.addEventListener('abort', onAbort, { once: true });
    if (options.signal.aborted) {
      onAbort();
    }
    if (promptOnStdin && !parser.failure) {
      child.stdin?.end(
        `${JSON.stringify({ event: 'user', message: { content: options.prompt } })}\n`,
      );
    }
  });
}

type ParserState = {
  conversationId?: string;
  initSeen: boolean;
  terminal?: AntigravityResult;
  failure?: AntigravityCliError;
};

function finishValue(
  parser: ParserState,
  aborted: boolean,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): AntigravityResult | AntigravityCliError {
  if (parser.failure) {
    return new AntigravityCliError(parser.failure.message, parser.failure.code, {
      exitCode,
      signal,
      stderr,
    });
  }
  if (parser.terminal) {
    if (parser.terminal.status === 'SUCCESS' && (exitCode !== 0 || signal !== null)) {
      return new AntigravityCliError(
        'Antigravity reported success with a failed process exit',
        'parse',
        { exitCode, signal, stderr },
      );
    }
    return parser.terminal;
  }
  return new AntigravityCliError(
    aborted
      ? 'Antigravity was canceled before a terminal result was received'
      : 'Antigravity exited without a terminal result',
    aborted ? 'aborted' : 'no_terminal_result',
    { exitCode, signal, stderr },
  );
}

function parseLine(
  line: string,
  parser: ParserState,
  emit: (event: AntigravityStreamEvent) => void,
  fail: (error: AntigravityCliError) => void,
) {
  if (!line.trim()) {
    return;
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    fail(new AntigravityCliError(`Invalid agy NDJSON event: ${String(error)}`, 'parse'));
    return;
  }
  if (!isRecord(value) || typeof value.event !== 'string') {
    fail(new AntigravityCliError('Invalid agy NDJSON event envelope', 'parse'));
    return;
  }
  if (value.event === 'init') {
    parseInit(value, parser, emit, fail);
  } else if (value.event === 'step_update') {
    parseStep(value, parser, emit, fail);
  } else if (value.event === 'result') {
    parseTerminal(value, parser, emit, fail);
  }
}

function parseInit(
  value: Record<string, unknown>,
  parser: ParserState,
  emit: (event: AntigravityStreamEvent) => void,
  fail: (error: AntigravityCliError) => void,
) {
  const init = record(value.init);
  if (!init || typeof value.conversation_id !== 'string' || parser.initSeen || parser.terminal) {
    fail(new AntigravityCliError('Invalid agy init event', 'parse'));
    return;
  }
  parser.conversationId = value.conversation_id;
  parser.initSeen = true;
  emit({ event: 'init', conversation_id: value.conversation_id, init });
}

function parseStep(
  value: Record<string, unknown>,
  parser: ParserState,
  emit: (event: AntigravityStreamEvent) => void,
  fail: (error: AntigravityCliError) => void,
) {
  const stepUpdate = record(value.step_update);
  if (!stepUpdate || !parser.initSeen || !matchesConversation(stepUpdate, parser.conversationId)) {
    fail(new AntigravityCliError('Invalid agy step_update event', 'parse'));
    return;
  }
  emit({ event: 'step_update', step_update: stepUpdate });
}

function parseTerminal(
  value: Record<string, unknown>,
  parser: ParserState,
  emit: (event: AntigravityStreamEvent) => void,
  fail: (error: AntigravityCliError) => void,
) {
  const result = parseResult(value.result);
  if (
    !result ||
    parser.terminal ||
    (parser.initSeen && result.conversation_id !== parser.conversationId)
  ) {
    fail(new AntigravityCliError('Invalid agy result event', 'parse'));
    return;
  }
  if (!parser.initSeen && result.status !== 'ERROR') {
    fail(new AntigravityCliError('Invalid agy result event', 'parse'));
    return;
  }
  parser.conversationId = result.conversation_id;
  parser.terminal = result;
  emit({ event: 'result', result });
}

export function antigravityEnvironment(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = { ...process.env, ...overrides };
  for (const key of Object.keys(environment)) {
    if (
      key.startsWith('ANTHROPIC_') ||
      key.startsWith('OPENAI_') ||
      key.startsWith('CURSOR_') ||
      key.startsWith('OPENCODE_') ||
      key === 'GEMINI_API_KEY' ||
      key === 'GOOGLE_GEMINI_BASE_URL' ||
      key === 'MULTI_GATEWAY_TOKEN'
    ) {
      delete environment[key];
    }
  }
  return environment;
}

function matchesConversation(value: Record<string, unknown>, conversationId: string | undefined) {
  return typeof value.conversation_id !== 'string' || value.conversation_id === conversationId;
}

function redactStderr(value: string): string {
  return value
    .replaceAll(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replaceAll(/([?&](?:api[_-]?key|token|password)=)[^&\s]+/gi, '$1[redacted]');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function parseUsage(value: unknown): AntigravityUsage | undefined {
  const usage = record(value);
  if (!usage) {
    return undefined;
  }
  const parsed: AntigravityUsage = {};
  for (const key of [
    'input_tokens',
    'output_tokens',
    'thinking_tokens',
    'cache_read_tokens',
    'total_tokens',
  ] as const) {
    if (typeof usage[key] === 'number' && Number.isSafeInteger(usage[key]) && usage[key] >= 0) {
      parsed[key] = usage[key];
    }
  }
  return parsed;
}

function parseResult(value: unknown): AntigravityResult | undefined {
  const result = record(value);
  if (
    !result ||
    typeof result.conversation_id !== 'string' ||
    typeof result.status !== 'string' ||
    !isStatus(result.status) ||
    typeof result.response !== 'string'
  ) {
    return undefined;
  }
  return {
    ...result,
    conversation_id: result.conversation_id,
    status: result.status,
    response: result.response,
    usage: parseUsage(result.usage),
  };
}

function isStatus(value: string): value is AntigravityStatus {
  return ['SUCCESS', 'ERROR', 'CANCELED', 'INTERRUPTED', 'INVALID', 'WAITING', 'RUNNING'].includes(
    value as AntigravityStatus,
  );
}
