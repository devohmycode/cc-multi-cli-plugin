import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
  executableInvocation,
  resolveExecutable,
} from '../../multi-core/src/gateway/executable.ts';
import { terminateProcessTree } from '../../multi-core/src/gateway/process-tree.ts';

/**
 * Grok Build headless contract, captured from `grok -p --output-format streaming-json`
 * on 1.0.35. The binary's own `--help` advertises ACP session updates; it emits this
 * simpler NDJSON instead, so the recorded stream is the contract, not the help text.
 */

export interface GrokUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  reasoning_tokens?: number;
  total_tokens?: number;
}

export interface GrokToolCall {
  toolCallId: string;
  toolName?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: unknown;
}

export interface GrokResult {
  sessionId: string;
  stopReason: string;
  requestId?: string;
  usage?: GrokUsage;
  turns?: number;
  /** Billed for this invocation only; `grok usage <id>` sums a whole session. */
  costUsd?: number;
  modelUsage?: Record<string, unknown>;
}

export type GrokStreamEvent =
  | { event: 'tools'; tools: readonly string[] }
  | { event: 'thought'; text: string }
  | { event: 'text'; text: string }
  | { event: 'tool_call'; call: GrokToolCall }
  | { event: 'tool_update'; call: GrokToolCall }
  | { event: 'usage'; usage: GrokUsage }
  | { event: 'result'; result: GrokResult };

export type GrokPermissionMode = 'auto' | 'acceptEdits' | 'plan' | 'bypassPermissions';

export interface GrokRunOptions {
  cwd: string;
  prompt: string;
  signal: AbortSignal;
  model?: string;
  effort?: string;
  /** New session identity, chosen by the gateway so a run ID exists before any output. */
  session?: string;
  /** Existing session to continue; mutually exclusive with `session`. */
  resume?: string;
  mode?: GrokPermissionMode;
  tools?: readonly string[];
  disallowedTools?: readonly string[];
  allow?: readonly string[];
  deny?: readonly string[];
  /**
   * Tool names the policy claims to have removed. `--disallowed-tools` accepts an
   * unknown name and runs the tool anyway, so the announced toolset is the only
   * evidence that a removal took effect. The set legitimately grows mid-run as MCP
   * servers connect, so this is a forbidden list, never an exhaustive one.
   */
  forbiddenTools?: readonly string[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  executable?: string;
  spawn?: (...args: Parameters<typeof spawn>) => ChildProcess;
  maxOutputBytes?: number;
  onEvent?: (event: GrokStreamEvent) => void;
}

export interface GrokRunResult {
  result: GrokResult;
  /** Assistant text, accumulated from deltas: the terminal event carries none. */
  response: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

export class GrokCliError extends Error {
  readonly code: 'spawn' | 'output_limit' | 'parse' | 'policy' | 'no_terminal_result' | 'aborted';
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;

  constructor(
    message: string,
    code: GrokCliError['code'],
    details: { exitCode?: number | null; signal?: NodeJS.Signals | null; stderr?: string } = {},
  ) {
    super(message);
    this.name = 'GrokCliError';
    this.code = code;
    this.exitCode = details.exitCode ?? null;
    this.signal = details.signal ?? null;
    this.stderr = details.stderr ?? '';
  }
}

const defaultMaxOutputBytes = 8 * 1024 * 1024;
// cmd.exe caps a command line at 8,191 characters when a .cmd shim cannot be
// bypassed; the fixed flags, executable path, cwd and quoting need the rest.
const windowsPromptArgumentLimitBytes = 6 * 1024;
const posixPromptArgumentLimitBytes = 128 * 1024;
const interruptGraceMs = 1500;
const terminateGraceMs = 1500;
const cancellationWaitMs = interruptGraceMs + terminateGraceMs + 1000;

function promptArgumentLimitBytes(platform: NodeJS.Platform): number {
  return platform === 'win32' ? windowsPromptArgumentLimitBytes : posixPromptArgumentLimitBytes;
}

/** Credentials of other providers never reach the native CLI. */
export function grokEnvironment(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, ...overrides, NO_COLOR: '1' };
  for (const key of Object.keys(environment)) {
    if (
      key.startsWith('ANTHROPIC_') ||
      key.startsWith('OPENAI_') ||
      key.startsWith('CURSOR_') ||
      key.startsWith('OPENCODE_') ||
      key === 'GEMINI_API_KEY' ||
      key === 'MULTI_GATEWAY_TOKEN' ||
      // An API key silently outranks the browser login and moves billing from the
      // subscription to metered xAI credit. This bridge runs on the account login.
      key === 'XAI_API_KEY'
    ) {
      delete environment[key];
    }
  }
  return environment;
}

function grokArguments(options: GrokRunOptions, promptFile: string | undefined): string[] {
  const args = promptFile ? ['--prompt-file', promptFile] : ['-p', options.prompt];
  args.push('--output-format', 'streaming-json', '--no-auto-update');
  if (options.model) {
    args.push('--model', options.model);
  }
  if (options.effort) {
    args.push('--reasoning-effort', options.effort);
  }
  if (options.mode) {
    args.push('--permission-mode', options.mode);
  }
  if (options.resume) {
    args.push('--resume', options.resume);
  } else if (options.session) {
    args.push('--session-id', options.session);
  }
  if (options.tools?.length) {
    args.push('--tools', options.tools.join(','));
  }
  if (options.disallowedTools?.length) {
    args.push('--disallowed-tools', options.disallowedTools.join(','));
  }
  for (const rule of options.allow ?? []) {
    args.push('--allow', rule);
  }
  for (const rule of options.deny ?? []) {
    args.push('--deny', rule);
  }
  args.push('--cwd', options.cwd);
  return args;
}

export async function runGrok(options: GrokRunOptions): Promise<GrokRunResult> {
  if (options.resume && options.session) {
    throw new GrokCliError('Grok resumes a session or creates one, never both', 'spawn');
  }
  const platform = options.platform ?? process.platform;
  const oversized = Buffer.byteLength(options.prompt) >= promptArgumentLimitBytes(platform);
  const directory = oversized ? await mkdtemp(path.join(os.tmpdir(), 'multi-grok-')) : undefined;
  const promptFile = directory ? path.join(directory, 'prompt.txt') : undefined;
  if (promptFile) {
    await writeFile(promptFile, options.prompt, { encoding: 'utf8', mode: 0o600 });
  }
  try {
    return await spawnGrok(options, platform, promptFile);
  } finally {
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

function startGrok(
  options: GrokRunOptions,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  promptFile: string | undefined,
): ChildProcess {
  const invocation = executableInvocation(
    resolveExecutable('grok', {
      platform,
      env: environment,
      configuredPath: options.executable,
    }),
    grokArguments(options, promptFile),
    platform,
    environment,
  );
  return (options.spawn ?? spawn)(invocation.command, invocation.args, {
    cwd: options.cwd,
    env: environment,
    detached: platform !== 'win32',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    ...invocation.options,
  });
}

function spawnGrok(
  options: GrokRunOptions,
  platform: NodeJS.Platform,
  promptFile: string | undefined,
): Promise<GrokRunResult> {
  return new Promise((resolve, reject) => {
    const environment = grokEnvironment(options.env);
    let child: ChildProcess;
    try {
      child = startGrok(options, platform, environment, promptFile);
    } catch (error) {
      reject(new GrokCliError(`Failed to start grok: ${String(error)}`, 'spawn'));
      return;
    }

    const maxOutputBytes = options.maxOutputBytes ?? defaultMaxOutputBytes;
    const stdoutDecoder = new StringDecoder('utf8');
    const parser: ParserState = { response: '', forbidden: options.forbiddenTools };
    let stdoutBuffer = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stderr = '';
    let aborted = false;
    let interruptTimer: NodeJS.Timeout | undefined;
    let terminateTimer: NodeJS.Timeout | undefined;
    let cancellationTimer: NodeJS.Timeout | undefined;
    let settled = false;

    const kill = (signal: NodeJS.Signals) => {
      if (child.pid) {
        terminateProcessTree(child.pid, { platform, signal });
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
      clearTimeout(cancellationTimer);
    };
    const fail = (error: GrokCliError) => {
      if (!parser.failure) {
        parser.failure = error;
        stop();
      }
    };
    const emit = (event: GrokStreamEvent) => {
      try {
        options.onEvent?.(event);
      } catch (error) {
        fail(new GrokCliError(`Grok event handler failed: ${String(error)}`, 'parse'));
      }
    };
    const consumeStdout = (chunk: Buffer) => {
      if (parser.failure) {
        return;
      }
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxOutputBytes) {
        fail(new GrokCliError('Grok stdout exceeded its safety limit', 'output_limit'));
        return;
      }
      stdoutBuffer += stdoutDecoder.write(chunk);
      let newline = stdoutBuffer.indexOf('\n');
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline).replace(/\r$/, '');
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        parseGrokLine(line, parser, emit, fail);
        newline = stdoutBuffer.indexOf('\n');
      }
      if (stdoutBuffer.length > maxOutputBytes) {
        fail(new GrokCliError('Grok stdout line exceeded its safety limit', 'output_limit'));
      }
    };
    const consumeStderr = (chunk: Buffer) => {
      if (parser.failure) {
        return;
      }
      stderrBytes += chunk.byteLength;
      if (stderrBytes > maxOutputBytes) {
        fail(new GrokCliError('Grok stderr exceeded its safety limit', 'output_limit'));
        return;
      }
      stderr += chunk.toString('utf8');
    };
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) {
        return;
      }
      settled = true;
      options.signal.removeEventListener('abort', onAbort);
      stdoutBuffer += stdoutDecoder.end();
      if (stdoutBuffer && !parser.failure) {
        parseGrokLine(stdoutBuffer, parser, emit, fail);
      }
      clearTimers();
      if (aborted || parser.failure || !parser.terminal) {
        kill('SIGKILL');
      }
      const safeStderr = redactStderr(stderr);
      const final = finishValue(parser, aborted, exitCode, signal, safeStderr);
      if (final instanceof GrokCliError) {
        reject(final);
        return;
      }
      resolve({ result: final, response: parser.response, exitCode, signal, stderr: safeStderr });
    };
    function onAbort() {
      if (aborted) {
        return;
      }
      aborted = true;
      child.stdout?.destroy();
      child.stderr?.destroy();
      stop();
      cancellationTimer = setTimeout(() => finish(null, null), cancellationWaitMs);
    }

    child.stdout?.on('data', consumeStdout);
    child.stderr?.on('data', consumeStderr);
    child.once('error', (error) => {
      fail(new GrokCliError(`grok failed to start: ${error.message}`, 'spawn'));
    });
    child.once('close', finish);
    options.signal.addEventListener('abort', onAbort, { once: true });
    if (options.signal.aborted) {
      onAbort();
    }
  });
}

type ParserState = {
  response: string;
  forbidden?: readonly string[];
  tools?: readonly string[];
  terminal?: GrokResult;
  failure?: GrokCliError;
};

type Emit = (event: GrokStreamEvent) => void;
type Fail = (error: GrokCliError) => void;

function finishValue(
  parser: ParserState,
  aborted: boolean,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): GrokResult | GrokCliError {
  if (parser.failure) {
    return new GrokCliError(parser.failure.message, parser.failure.code, {
      exitCode,
      signal,
      stderr,
    });
  }
  if (parser.terminal) {
    if (exitCode !== 0 || signal !== null) {
      return new GrokCliError(
        'Grok reported a terminal result with a failed process exit',
        'parse',
        {
          exitCode,
          signal,
          stderr,
        },
      );
    }
    return parser.terminal;
  }
  return new GrokCliError(
    aborted
      ? 'Grok was canceled before a terminal result was received'
      : 'Grok exited without a terminal result',
    aborted ? 'aborted' : 'no_terminal_result',
    { exitCode, signal, stderr },
  );
}

/** Unknown event types are ignored so a newer CLI stays readable. */
function parseGrokLine(line: string, parser: ParserState, emit: Emit, fail: Fail) {
  if (!line.trim()) {
    return;
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    fail(new GrokCliError(`Invalid grok NDJSON event: ${String(error)}`, 'parse'));
    return;
  }
  if (!isRecord(value) || typeof value.type !== 'string') {
    fail(new GrokCliError('Invalid grok NDJSON event envelope', 'parse'));
    return;
  }
  if (parser.terminal) {
    fail(new GrokCliError('Grok continued streaming after its terminal event', 'parse'));
    return;
  }
  parseEvent(value.type, value, parser, emit, fail);
}

function parseEvent(
  type: string,
  value: Record<string, unknown>,
  parser: ParserState,
  emit: Emit,
  fail: Fail,
) {
  if (type === 'available_commands') {
    parseTools(value, parser, emit, fail);
  } else if (type === 'thought' || type === 'text') {
    parseDelta(type, value, parser, emit, fail);
  } else if (type === 'tool_call' || type === 'tool_call_update') {
    parseToolCall(type, value, emit, fail);
  } else if (type === 'usage') {
    parseUsageEvent(value, emit, fail);
  } else if (type === 'end') {
    parseTerminal(value, parser, emit, fail);
  }
}

/**
 * The announced toolset is the only evidence that a removal took effect: the CLI
 * accepts unknown `--disallowed-tools` names and runs the tool anyway. Every
 * announcement is checked, because the set grows once MCP servers connect.
 */
function parseTools(value: Record<string, unknown>, parser: ParserState, emit: Emit, fail: Fail) {
  const tools = stringArray(value.tools);
  if (!tools) {
    fail(new GrokCliError('Invalid grok available_commands event', 'parse'));
    return;
  }
  const forbidden = new Set(parser.forbidden ?? []);
  const breach = tools.filter((tool) => forbidden.has(tool));
  if (breach.length) {
    fail(
      new GrokCliError(
        `Grok did not apply the session tool policy: ${breach.join(', ')} remains available`,
        'policy',
      ),
    );
    return;
  }
  if (parser.tools && sameTools(parser.tools, tools)) {
    return;
  }
  parser.tools = tools;
  emit({ event: 'tools', tools });
}

function parseDelta(
  type: 'thought' | 'text',
  value: Record<string, unknown>,
  parser: ParserState,
  emit: Emit,
  fail: Fail,
) {
  if (typeof value.data !== 'string') {
    fail(new GrokCliError(`Invalid grok ${type} event`, 'parse'));
    return;
  }
  if (type === 'text') {
    parser.response += value.data;
  }
  emit({ event: type, text: value.data });
}

function parseToolCall(
  type: 'tool_call' | 'tool_call_update',
  value: Record<string, unknown>,
  emit: Emit,
  fail: Fail,
) {
  if (typeof value.toolCallId !== 'string' || !value.toolCallId) {
    fail(new GrokCliError(`Invalid grok ${type} event`, 'parse'));
    return;
  }
  const call: GrokToolCall = {
    toolCallId: value.toolCallId,
    toolName: optionalString(value.toolName),
    title: optionalString(value.title),
    kind: optionalString(value.kind),
    status: optionalString(value.status),
    rawInput: value.rawInput,
    rawOutput: value.rawOutput,
    content: value.content,
  };
  emit({ event: type === 'tool_call' ? 'tool_call' : 'tool_update', call });
}

function parseUsageEvent(value: Record<string, unknown>, emit: Emit, fail: Fail) {
  const usage = parseUsage(value.usage);
  if (!usage) {
    fail(new GrokCliError('Invalid grok usage event', 'parse'));
    return;
  }
  // `signature` carries provider-owned reasoning state; it stays at this boundary.
  emit({ event: 'usage', usage });
}

function parseTerminal(
  value: Record<string, unknown>,
  parser: ParserState,
  emit: Emit,
  fail: Fail,
) {
  if (typeof value.sessionId !== 'string' || typeof value.stopReason !== 'string') {
    fail(new GrokCliError('Invalid grok end event', 'parse'));
    return;
  }
  const result: GrokResult = {
    sessionId: value.sessionId,
    stopReason: value.stopReason,
    requestId: optionalString(value.requestId),
    usage: parseUsage(value.usage),
    turns: optionalCount(value.num_turns),
    costUsd: optionalCost(value.total_cost_usd),
    modelUsage: isRecord(value.modelUsage) ? value.modelUsage : undefined,
  };
  parser.terminal = result;
  emit({ event: 'result', result });
}

function redactStderr(value: string): string {
  return value
    .replaceAll(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replaceAll(/([?&](?:api[_-]?key|token|password)=)[^&\s]+/gi, '$1[redacted]');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function optionalCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function optionalCost(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    return undefined;
  }
  return value as string[];
}

function sameTools(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((tool, index) => tool === right[index]);
}

function parseUsage(value: unknown): GrokUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const usage: GrokUsage = {};
  for (const key of [
    'input_tokens',
    'output_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
    'reasoning_tokens',
    'total_tokens',
  ] as const) {
    const count = optionalCount(value[key]);
    if (count !== undefined) {
      usage[key] = count;
    }
  }
  return usage;
}
