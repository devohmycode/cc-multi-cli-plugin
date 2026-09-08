#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { ApprovalContext, NativeApprovalBridge } from './gateway/approval.ts';
import type { GatewayEvent } from './gateway/server.ts';
import { createNativeGateway } from './gateway/server.ts';
import { createCursorApproval } from './providers/cursor/approval.ts';
import { CursorBridge } from './providers/cursor/bridge.ts';
import type { CursorModelOption } from './providers/cursor/models.ts';
import { cursorModelOptions, cursorPickerOptions } from './providers/cursor/models.ts';
import { createOpenAIApproval, discoverOpenAIReviewer } from './providers/openai/approval.ts';
import { readCodexAuth } from './providers/openai/auth.ts';
import { MODELS, OPENAI_WORKERS } from './providers/openai/models.ts';
import type { Effort } from './providers/openai/responses.ts';

/** One `--agents` entry: an external worker using Claude Code's native tools. */
interface AgentDefinition {
  description: string;
  prompt: string;
  model: string;
  tools: string[];
  effort?: Effort;
}

/** One `/model` entry the launched session offers. */
interface ModelOption {
  model: string;
  label: string;
  description: string;
}

interface LaunchSettings {
  modelPicker: { options: ModelOption[] };
  permissions?: Record<string, unknown>;
  [key: string]: unknown;
}

async function main() {
  const args = process.argv.slice(2);
  await handleCommand(args[0]);
  const { cursorModels, cursorSignedIn } = await discoverCursor(args[0] === '--cursor-models');
  if (args[0] === '--cursor-models') {
    printCursorModels(cursorModels, cursorSignedIn);
    return;
  }
  if (args[0] === '--') {
    args.shift();
  }
  if (process.env.ANTHROPIC_BASE_URL) {
    throw new Error(
      'Start without ANTHROPIC_BASE_URL; this launcher supplies the central gateway.',
    );
  }
  const anthropic = await anthropicSignedIn();
  if (args.some((arg) => arg === '--agents' || arg.startsWith('--agents='))) {
    throw new Error('This launcher supplies --agents; use agent files for additional agents.');
  }
  const cursorPicker = cursorModels.length
    ? cursorPickerOptions(cursorModels, process.env.MULTI_CURSOR_EXTRA_MODELS)
    : [];
  const authFile = path.join(
    process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    'auth.json',
  );
  const { codexSignedIn, openaiReview } = await discoverOpenAI(authFile, anthropic);
  const token = randomBytes(32).toString('hex');
  const cursor = cursorModels.length ? new CursorBridge(cursorModels) : undefined;
  const { approvalBridge, approvalProviders } = await discoverApprovals(
    authFile,
    cursorModels,
    anthropic,
    openaiReview,
  );
  const server = createNativeGateway({
    token,
    authFile,
    cursor,
    approvalBridge,
    approvalProviders,
    blockAnthropic: !anthropic,
    guardAuto: !anthropic,
    onEvent:
      process.env.MULTI_NATIVE_TRACE === '1'
        ? (event: GatewayEvent) => process.stderr.write(`[native] ${JSON.stringify(event)}\n`)
        : undefined,
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Gateway did not bind a local port.');
  }
  const agents = workerDefinitions(codexSignedIn, cursorModels);
  const settings = pickerSettings(codexSignedIn, cursorPicker);
  await mergeSettings(args, settings);
  const settingsDir = await mkdtemp(path.join(os.tmpdir(), 'multi-native-settings-'));
  const settingsFile = path.join(settingsDir, 'settings.json');
  const { initialModel, selectedModel } = await initialSelection(
    args,
    settings,
    anthropic,
    codexSignedIn,
    cursorPicker,
  );
  if (!initialModel && selectedModel) {
    args.push('--model', selectedModel);
  }
  if (!anthropic) {
    configureApproval(settings, approvalProviders, selectedModel);
  }
  await writeFile(settingsFile, JSON.stringify(settings), { mode: 0o600 });
  const definitions = JSON.stringify(agents);
  if (Buffer.byteLength(definitions) > 120000) {
    server.close();
    await cursor?.close();
    await rm(settingsDir, { recursive: true, force: true });
    throw new Error(
      'Cursor worker catalog exceeds the launcher argument limit. Worker registration needs a file-based Claude plugin.',
    );
  }
  const child = spawn('claude', ['--settings', settingsFile, '--agents', definitions, ...args], {
    stdio: 'inherit',
    env: gatewayEnvironment(address.port, token, anthropic),
  });
  const shutdown = async () => {
    server.closeAllConnections();
    server.close();
    await cursor?.close();
    await rm(settingsDir, { recursive: true, force: true });
  };
  child.once('error', (error) => {
    console.error(error.message);
    void shutdown().finally(() => process.exit(1));
  });
  child.once('exit', (code) => {
    void shutdown().finally(() => process.exit(code ?? 1));
  });
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  // The foreground terminal delivers SIGINT to both processes; keep the gateway alive
  // while Claude handles its normal interrupt UI.
  process.on('SIGINT', () => {});
}

void main().catch((error) => {
  console.error(`Native gateway: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

async function discoverCursor(required: boolean) {
  const { Cursor } = await import('@cursor/sdk');
  const cursorSignedIn =
    Boolean(process.env.CURSOR_API_KEY) || (await Cursor.auth.status()).status === 'logged-in';
  let cursorModels: CursorModelOption[] = [];
  if (cursorSignedIn) {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Cursor model discovery timed out')), 15000);
      });
      cursorModels = cursorModelOptions(await Promise.race([Cursor.models.list(), timeout]));
    } catch (error) {
      if (required) {
        throw error;
      }
      console.error(
        `Cursor choices unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
  return { cursorModels, cursorSignedIn };
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function failedAuthProbeOutput(error: unknown): string {
  const details = recordValue(error);
  const code = details?.code;
  const stdout = details?.stdout;
  if (code === 1 && typeof stdout === 'string') {
    return stdout;
  }
  throw new Error('Claude auth status probe failed; cannot determine login state');
}

function parseAuthProbeOutput(stdout: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('Claude auth status probe returned invalid JSON');
  }
  const details = recordValue(parsed);
  if (!details || typeof details.loggedIn !== 'boolean') {
    throw new Error('Claude auth status probe returned no boolean loggedIn field');
  }
  return details.loggedIn;
}

async function anthropicSignedIn(): Promise<boolean> {
  // Ask Claude, including its OS credential store and configured helpers. Never read its tokens.
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    return true;
  }
  let stdout: string;
  try {
    ({ stdout } = await promisify(execFile)('claude', ['auth', 'status', '--json'], {
      timeout: 10000,
      maxBuffer: 65536,
    }));
  } catch (error) {
    stdout = failedAuthProbeOutput(error);
  }
  return parseAuthProbeOutput(stdout);
}

async function discoverOpenAI(authFile: string, anthropic: boolean) {
  let codexSignedIn = false;
  try {
    await readCodexAuth(authFile);
    codexSignedIn = true;
  } catch {
    console.error('OpenAI choices unavailable: sign in with codex login to enable them.');
  }
  let openaiReview = false;
  if (!anthropic && codexSignedIn) {
    try {
      openaiReview = await discoverOpenAIReviewer(authFile);
    } catch {
      /* Missing capability disables auto mode; inference remains available. */
    }
    if (!openaiReview) {
      console.error('OpenAI automatic reviewer unavailable; auto mode is disabled.');
    }
  }
  return { codexSignedIn, openaiReview };
}

function workerDefinitions(codexSignedIn: boolean, cursorModels: CursorModelOption[]) {
  const agents: Record<string, AgentDefinition> = Object.fromEntries(
    Object.entries(codexSignedIn ? OPENAI_WORKERS : {}).map(([name, { model, effort }]) => [
      name,
      {
        description: `${model}, ${effort} reasoning. Native coding, investigation, and review.`,
        prompt:
          'You are an OpenAI coding agent running inside Claude Code. Use the provided native tools to complete the delegated task. Follow its scope and permissions. Keep required shell commands in the foreground (run_in_background: false), with an appropriate timeout, and wait for their exit status before reporting completion. A background launch is not a completed task. Report the result, verification, and any unresolved issues. Do not invoke external coding CLIs.',
        model: `multi/openai/${model}`,
        tools: ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write'],
        effort,
      },
    ]),
  );
  for (const option of cursorModels.filter((option) => option.nativeWorker)) {
    agents[option.worker] = {
      description: `${option.label}. Coding, investigation, and review through Cursor's SDK with Claude-executed tools.`,
      prompt:
        'Complete the delegated task using the supplied Claude Code tools. Respect its scope and permissions. Verify changes and report the result and unresolved issues. Do not invoke external coding CLIs.',
      model: option.model,
      tools: ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write'],
    };
  }
  return agents;
}

async function mergeSettings(args: string[], settings: LaunchSettings) {
  // Keep one --settings argument, preserving explicit caller settings and our picker.
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--settings' && !args[i].startsWith('--settings=')) {
      continue;
    }
    const inline = args[i].startsWith('--settings=');
    const value = inline ? args[i].slice(11) : args[i + 1];
    if (!value) {
      throw new Error('--settings requires a JSON object or file');
    }
    const extra = await readSettings(value);
    const picker = settings.modelPicker;
    Object.assign(settings, extra);
    settings.modelPicker = {
      ...picker,
      ...extra.modelPicker,
      options: [...picker.options, ...(extra.modelPicker?.options ?? [])],
    };
    args.splice(i, inline ? 1 : 2);
    i--;
  }
}

async function initialSelection(
  args: string[],
  settings: LaunchSettings,
  anthropic: boolean,
  codexSignedIn: boolean,
  cursorPicker: CursorModelOption[],
) {
  const savedModel = await savedSelection(args);
  let initialModel =
    process.env.ANTHROPIC_MODEL ??
    (typeof settings.model === 'string' ? settings.model : savedModel);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model') {
      initialModel = args[++i];
    } else if (args[i].startsWith('--model=')) {
      initialModel = args[i].slice(8);
    }
  }
  // With no Claude login, start on an available external model instead of Sonnet.
  let fallback: string | undefined;
  if (!anthropic) {
    fallback = codexSignedIn ? 'multi/openai/gpt-5.6-luna' : cursorPicker[0]?.model;
  }
  return { initialModel, selectedModel: initialModel ?? fallback };
}

function approvalProvider(model: string | undefined): 'openai' | 'cursor' | undefined {
  if (model?.startsWith('multi/openai/')) {
    return 'openai';
  }
  if (model?.startsWith('multi/cursor/')) {
    return 'cursor';
  }
  return undefined;
}

async function discoverApprovals(
  authFile: string,
  cursorModels: CursorModelOption[],
  anthropic: boolean,
  openaiReview: boolean,
) {
  const approvalProviders: ('openai' | 'cursor')[] = [];
  const bridges: Partial<Record<'openai' | 'cursor', NativeApprovalBridge>> = {};
  if (openaiReview) {
    bridges.openai = await createOpenAIApproval(authFile, process.cwd());
    approvalProviders.push('openai');
  }
  if (!anthropic && cursorModels.length) {
    try {
      bridges.cursor = await createCursorApproval(cursorModels, process.cwd());
      approvalProviders.push('cursor');
    } catch (error) {
      console.error(
        `Cursor automatic reviewer unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return {
    approvalProviders,
    approvalBridge: approvalProviders.length ? approvalDispatcher(bridges) : undefined,
  };
}

function approvalDispatcher(bridges: Partial<Record<'openai' | 'cursor', NativeApprovalBridge>>) {
  return {
    respond(body: unknown, signal: AbortSignal, context?: ApprovalContext) {
      const provider = approvalProvider(context?.model);
      const bridge = provider ? bridges[provider] : undefined;
      if (!bridge) {
        throw new Error('Automatic approval is unavailable for this provider');
      }
      return bridge.respond(body, signal, context);
    },
  };
}

function configureApproval(
  settings: LaunchSettings,
  providers: readonly ('openai' | 'cursor')[],
  selectedModel?: string,
) {
  const provider = approvalProvider(selectedModel);
  if (!provider || !providers.includes(provider)) {
    settings.permissions = { ...settings.permissions, disableAutoMode: 'disable' };
  }
  // --settings is fixed for the session. A per-tool capability guard also covers
  // /model changes and workers, without calling a model or classifying commands.
  const quote = (value: string) => {
    if (process.platform !== 'win32') {
      return `'${value.replaceAll("'", "'\\''")}'`;
    }
    if (/["%\r\n!]/.test(value)) {
      throw new Error('Unsupported characters in approval hook path');
    }
    return `"${value}"`;
  };
  const command = [
    process.execPath,
    fileURLToPath(new URL('./gateway/permission-hook.ts', import.meta.url)),
  ]
    .map(quote)
    .join(' ');
  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  settings.hooks = {
    ...hooks,
    PreToolUse: [
      ...(hooks?.PreToolUse ?? []),
      { hooks: [{ type: 'command', command, timeout: 10 }] },
    ],
  };
}

async function handleCommand(command?: string) {
  if (command === '--help') {
    console.log(
      'Usage: node native-model-gateway.ts [--cursor-login | --cursor-models] [-- <claude arguments>]\nLaunch Claude with OpenAI and signed-in Cursor models and native workers.\n--cursor-login: official Cursor SDK browser sign-in\n--cursor-models: list account model choices and worker names\nMULTI_CURSOR_EXTRA_MODELS: comma-separated Cursor model IDs to add to Auto, Grok 4.6, and Composer 2.5 in /model',
    );
    process.exit(0);
  }
  if (command === '--cursor-login') {
    const { Cursor } = await import('@cursor/sdk');
    await Cursor.auth.login({
      apiKeyName: 'cc-multi-cli',
      onLoginUrl: (url) => console.log(`Cursor login: ${url}`),
    });
    console.log('Cursor SDK login saved. Launch the gateway normally to use it.');
    process.exit(0);
  }
}

async function readSettings(value: string) {
  const extra = JSON.parse(
    value.trimStart().startsWith('{') ? value : await readFile(value, 'utf8'),
  );
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) {
    throw new Error('Invalid --settings object');
  }
  return extra;
}

async function savedSelection(args: string[]) {
  let savedModel: string | undefined;
  const sourcesIndex = args.lastIndexOf('--setting-sources');
  const sources = (
    args.findLast((arg) => arg.startsWith('--setting-sources='))?.slice(18) ??
    (sourcesIndex >= 0 ? args[sourcesIndex + 1] : 'user,project,local')
  ).split(',');
  for (const [source, filename] of [
    [
      'user',
      path.join(
        process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
        'settings.json',
      ),
    ],
    ['project', path.join(process.cwd(), '.claude', 'settings.json')],
    ['local', path.join(process.cwd(), '.claude', 'settings.local.json')],
  ] as const) {
    if (!sources.includes(source)) {
      continue;
    }
    try {
      const value = JSON.parse(await readFile(filename, 'utf8'));
      if (typeof value.model === 'string') {
        savedModel = value.model;
      }
    } catch {
      /* Claude handles missing or invalid native settings itself. */
    }
  }
  return savedModel;
}

function printCursorModels(cursorModels: CursorModelOption[], cursorSignedIn: boolean) {
  if (!cursorSignedIn) {
    throw new Error('Run with --cursor-login first.');
  }
  console.log(
    JSON.stringify(
      cursorModels.map(({ model, label, worker, selection, nativeWorker }) => ({
        model,
        label,
        worker: nativeWorker ? worker : undefined,
        selection,
      })),
      null,
      2,
    ),
  );
}

function pickerSettings(codexSignedIn: boolean, cursorPicker: CursorModelOption[]) {
  const settings: LaunchSettings = {
    modelPicker: {
      options: [
        ...Object.values(codexSignedIn ? MODELS : {}).map((model) => ({
          model: `multi/openai/${model}`,
          label: model,
          description: 'OpenAI subscription · native Claude Code harness',
        })),
        ...cursorPicker.map(({ model, label, description }) => ({ model, label, description })),
      ],
    },
  };
  return settings;
}

function gatewayEnvironment(port: number, token: string, anthropic: boolean) {
  return {
    ...process.env,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ...(!anthropic ? { ANTHROPIC_AUTH_TOKEN: token, MULTI_GATEWAY_TOKEN: token } : {}),
    ANTHROPIC_CUSTOM_HEADERS: [
      process.env.ANTHROPIC_CUSTOM_HEADERS,
      `x-multi-gateway-token: ${token}`,
    ]
      .filter(Boolean)
      .join('\n'),
  };
}
