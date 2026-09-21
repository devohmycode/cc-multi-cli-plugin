#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { AntigravityHarness } from '../../multi-antigravity/src/harness.ts';
import {
  checkAntigravityHooks,
  installAntigravityHook,
} from '../../multi-antigravity/src/hooks.ts';
import {
  type AntigravityModel,
  antigravityPickerOptions,
  discoverAntigravityModels,
} from '../../multi-antigravity/src/models.ts';
import { antigravityPermissionPolicy } from '../../multi-antigravity/src/permissions.ts';
import { CursorHarness } from '../../multi-cursor/src/harness.ts';
import type { CursorModelOption } from '../../multi-cursor/src/models.ts';
import { cursorModelOptions, cursorPickerOptions } from '../../multi-cursor/src/models.ts';
import {
  cursorPermissionPolicy,
  mergeCursorPermissions,
} from '../../multi-cursor/src/permissions.ts';
import { CursorWorkspaces } from '../../multi-cursor/src/workspaces.ts';
import { createOpenAIApproval, discoverOpenAIReviewer } from '../../multi-openai/src/approval.ts';
import { readCodexAuth } from '../../multi-openai/src/auth.ts';
import { MODELS, OPENAI_WORKERS } from '../../multi-openai/src/models.ts';
import type { Effort } from '../../multi-openai/src/responses.ts';
import { readZenKey } from '../../multi-zen/src/auth.ts';
import {
  ZEN_MODELS,
  ZEN_WORKERS,
  zenModelOptions,
  zenPickerOptions,
} from '../../multi-zen/src/models.ts';
import { AgentCatalog } from './gateway/agent-catalog.ts';
import {
  loadWorkerPermissions,
  type PluginPermissionInventory,
  pluginPermissions,
} from './gateway/agent-definitions.ts';
import { type CursorSettingsOptions, checkCursorSettings } from './gateway/cursor-settings.ts';
import { executableInvocation, resolveExecutable } from './gateway/executable.ts';
import { ModBridge } from './gateway/mod-bridge.ts';
import { PermissionModes } from './gateway/mode-hook.ts';
import { hookCommand } from './gateway/permission-hook.ts';
import { ReceiptLedger } from './gateway/receipts.ts';
import type { GatewayEvent } from './gateway/server.ts';
import { createNativeGateway } from './gateway/server.ts';

import { providerSelection } from './install/plugins.ts';

const enabledProviders = providerSelection(process.env.MULTI_ENABLED_PROVIDERS);
const providerEnabled = (provider: string) =>
  enabledProviders?.some((name) => name === provider) ?? true;
const claudeExecutable = process.env.MULTI_REAL_CLAUDE;

/**
 * Claude Code requires a non-empty subagent prompt. Workers get no behavioral rules here;
 * provider profiles and Claude's native subagent prompt govern them.
 */
const WORKER_PROMPT = 'Complete the delegated task.';

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
  behavesAs?: string;
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
  validateSessionLaunch(args);
  const pluginInventory = await pluginPermissions(process.cwd(), args);
  const pluginRoot = await findPluginRoot(fileURLToPath(import.meta.url));
  await assertFunctionHooksSupported();
  const anthropic = await anthropicSignedIn();
  const fullCatalog = process.env.MULTI_MODELS !== undefined;
  const cursorPicker = selectedCursorOptions(cursorModels, fullCatalog);
  const authFile = path.join(
    process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    'auth.json',
  );
  const { codexSignedIn, openaiReview } = await discoverOpenAI(authFile);
  const zenKey = providerEnabled('zen') ? await readZenKey() : undefined;
  const antigravityModels = await discoverAntigravity();
  const token = randomBytes(32).toString('hex');
  const defaultModels = fullCatalog
    ? pickerSettings(
        codexSignedIn,
        selectedCursorOptions(cursorModels, false),
        Boolean(zenKey),
        antigravityModels,
      ).modelPicker.options.map((option) => option.model)
    : [];
  const settings = pickerSettings(
    codexSignedIn,
    cursorPicker,
    Boolean(zenKey),
    antigravityModels,
    fullCatalog,
  );
  await mergeSettings(args, settings);
  // The supervisor does not transfer --agents or our session-local gateway env,
  // and can outlive the child whose exit releases settingsDir and the gateway.
  // Keep ordinary background subagent tasks available within this owned session.
  settings.disableAgentView = true;
  filterPicker(settings, process.env.MULTI_MODELS, defaultModels);
  const callerSettings = structuredClone(settings);
  const { cursor, antigravity } = nativeHarnesses(
    cursorModels,
    antigravityModels,
    args,
    callerSettings,
  );
  const agents = workerDefinitions(
    codexSignedIn,
    cursorPicker,
    Boolean(zenKey),
    antigravityModels,
    settings.modelPicker.options.map((option) => option.model),
  );
  const modBridge = new ModBridge();
  const settingsDir = await mkdtemp(path.join(os.tmpdir(), 'multi-native-settings-'));
  const callerSettingsFile = path.join(settingsDir, 'caller-settings.json');
  await writeFile(callerSettingsFile, JSON.stringify(callerSettings), { mode: 0o600 });
  const permissionModes = new PermissionModes(
    (cwd) =>
      loadWorkerPermissions(
        cwd,
        agents,
        [...args, '--settings', callerSettingsFile],
        pluginInventory,
      ),
    async (cwd) => {
      if (!cursor && !antigravity) {
        return {};
      }
      try {
        return await checkCursorSettings(
          cwd,
          args,
          callerSettings,
          sharedAdmission(antigravity !== undefined),
        );
      } catch (error) {
        return { nativePermissionError: String(error) };
      }
    },
  );
  await permissionModes.precompute(process.cwd());
  const { approvalBridge, approvalProviders } = await discoverApprovals(
    authFile,
    cursorModels.length > 0,
    openaiReview,
  );
  const receipts = new ReceiptLedger({
    file: process.env.MULTI_RECEIPTS_FILE
      ? path.resolve(process.env.MULTI_RECEIPTS_FILE)
      : undefined,
    onError: (error) => {
      process.stderr.write(`[native] receipt not written: ${String(error)}\n`);
    },
  });
  const server = createNativeGateway({
    receipts,
    token,
    enabledProviders,
    authFile,
    modBridge,
    cursor,
    antigravity,
    zen: zenKey ? { apiKey: zenKey } : undefined,
    permissionModes,
    approvalBridge,
    approvalProviders,
    blockAnthropic: !anthropic,
    guardAuto: true,
    agentCatalog: new AgentCatalog(
      agents,
      settings.modelPicker.options.map((option) => option.model),
    ),
    onEvent: traceEvent,
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Gateway did not bind a local port.');
  }
  const settingsFile = path.join(settingsDir, 'settings.json');
  const { initialModel, selectedModel } = await initialSelection(args, settings, anthropic);
  if (!initialModel && selectedModel) {
    args.push('--model', selectedModel);
  }
  configureApproval(settings, approvalProviders, selectedModel, Boolean(antigravity), anthropic);
  await writeFile(settingsFile, JSON.stringify(settings), { mode: 0o600 });
  const definitions = JSON.stringify(agents);
  const childEnvironment = gatewayEnvironment(address.port, token, anthropic, Boolean(cursor));
  const claudePath = resolveExecutable('claude', {
    configuredPath: claudeExecutable,
    env: childEnvironment,
  });
  const childArguments = launcherArguments(
    args,
    settingsFile,
    definitions,
    pluginInventory,
    pluginRoot,
  );
  const childInvocation = executableInvocation(
    claudePath,
    childArguments,
    process.platform,
    childEnvironment,
  );
  try {
    checkLauncherArgumentLimit(agents, childInvocation, claudePath, process.platform);
  } catch (error) {
    server.close();
    await cursor?.close();
    await antigravity?.close();
    receipts.finishAll();
    await receipts.drain();
    await rm(settingsDir, { recursive: true, force: true });
    throw error;
  }
  const ready = awaitModSessionStart();
  const child = spawn(childInvocation.command, childInvocation.args, {
    stdio: 'inherit',
    env: childEnvironment,
    detached: process.platform !== 'win32',
    ...childInvocation.options,
  });
  const shutdown = async () => {
    server.closeAllConnections();
    server.close();
    await cursor?.close();
    await antigravity?.close();
    receipts.finishAll();
    await receipts.drain();
    await rm(settingsDir, { recursive: true, force: true });
  };
  try {
    await ready;
  } catch (error) {
    child.kill();
    await shutdown();
    throw error;
  }
  child.once('error', (error) => {
    console.error(error.message);
    void shutdown().finally(() => process.exit(1));
  });
  child.once('exit', (code) => {
    void shutdown().finally(() => process.exit(code ?? 1));
  });
  if (process.platform === 'win32') {
    // Windows console control events do not provide POSIX process groups. Claude's
    // child owns Ctrl+C handling; forward termination explicitly to its process tree.
    process.on('SIGTERM', () => child.kill('SIGTERM'));
    process.on('SIGINT', () => {});
  } else {
    process.on('SIGTERM', () => child.kill('SIGTERM'));
    // Unix foreground terminals deliver SIGINT to both processes; Claude owns its
    // interrupt UI, so the gateway deliberately remains alive.
    process.on('SIGINT', () => {});
  }
}

/**
 * Claude's plugin cache may be a symlink to a checkout. Node resolves the entry
 * module to its real path, so compare real paths rather than the argv spelling.
 */
function isEntryModule(argument: string | undefined): boolean {
  if (!argument) {
    return false;
  }
  const entry = fileURLToPath(import.meta.url);
  const resolved = path.resolve(argument);
  if (resolved === entry) {
    return true;
  }
  try {
    return realpathSync(resolved) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isEntryModule(process.argv[1])) {
  void main().catch((error) => {
    console.error(`Native gateway: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

function validateSessionLaunch(args: string[]) {
  if (
    args.some((arg) => arg === '--bg' || arg === '--background') ||
    ['attach', 'respawn'].includes(args[0] ?? '')
  ) {
    throw new Error(
      'Multi sessions must stay attached to their launcher. Exit and use --resume <session-id> to continue with a fresh gateway; whole-session background handoff is unsupported.',
    );
  }
  if (process.env.ANTHROPIC_BASE_URL) {
    throw new Error(
      'Start without ANTHROPIC_BASE_URL; this launcher supplies the central gateway.',
    );
  }
  if (args.some((arg) => arg === '--agents' || arg.startsWith('--agents='))) {
    throw new Error('This launcher supplies --agents; use agent files for additional agents.');
  }
}

function nativeHarnesses(
  cursorModels: CursorModelOption[],
  antigravityModels: AntigravityModel[],
  args: string[],
  callerSettings: LaunchSettings,
) {
  const cursor = cursorModels.length
    ? new CursorWorkspaces(
        (cwd) =>
          new CursorHarness(cursorModels, {
            cwd,
            checkPermissions: () => checkCursorSettings(cwd, args, callerSettings),
          }),
      )
    : undefined;
  const antigravity = antigravityModels.length
    ? new AntigravityHarness(antigravityModels, {
        checkPermissions: async (cwd, context) => {
          await checkAntigravityHooks();
          const restrictions = await checkCursorSettings(cwd, args, callerSettings, {
            validate: antigravityPermissionPolicy,
          });
          return antigravityPermissionPolicy(mergeCursorPermissions(context, restrictions));
        },
      })
    : undefined;
  return { cursor, antigravity };
}

async function discoverCursor(required: boolean) {
  if (!providerEnabled('cursor')) {
    return { cursorModels: [] as CursorModelOption[], cursorSignedIn: false };
  }
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

async function assertFunctionHooksSupported(): Promise<void> {
  let stdout: string;
  let executable = 'claude';
  try {
    executable = resolveExecutable('claude', {
      platform: process.platform,
      env: process.env,
      configuredPath: claudeExecutable,
    });
    const invocation = executableInvocation(
      executable,
      ['--version'],
      process.platform,
      process.env,
    );
    ({ stdout } = await promisify(execFile)(invocation.command, invocation.args, {
      timeout: 10000,
      maxBuffer: 65536,
      ...invocation.options,
    }));
  } catch (error) {
    const details = recordValue(error);
    const code = typeof details?.code === 'string' ? ` (${details.code})` : '';
    const firstLine = String(error).split('\n', 1)[0];
    throw new Error(
      `Claude Code 2.1.272 or newer with function hooks is required; unable to read ${executable} --version${code}: ${firstLine}.`,
      { cause: error },
    );
  }
  const match = stdout.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!match || !atLeastVersion(match.slice(1).map(Number), [2, 1, 272])) {
    throw new Error('Claude Code 2.1.272 or newer with function hooks is required.');
  }
}

function claudeCommand(args: readonly string[]) {
  const environment = process.env;
  return executableInvocation(
    resolveExecutable('claude', {
      platform: process.platform,
      env: environment,
      configuredPath: claudeExecutable,
    }),
    args,
    process.platform,
    environment,
  );
}

function atLeastVersion(actual: number[], required: number[]): boolean {
  for (let index = 0; index < required.length; index++) {
    const received = actual[index] ?? 0;
    const minimum = required[index] ?? 0;
    if (received !== minimum) {
      return received > minimum;
    }
  }
  return true;
}

/**
 * Claude Code has to start, load the plugin worker and run session.start before
 * the mod can acknowledge. A cold start on Windows takes well over five seconds
 * (large binary, antivirus scan), so the wait is generous and overridable.
 */
const modSessionStartTimeoutMs = Number(process.env.MULTI_MOD_START_TIMEOUT_MS ?? 30000);

function awaitModSessionStart(): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      process.off('multi-mod-session-start', ready);
      reject(
        new Error(
          'Claude Code 2.1.272 or newer with loaded function hooks is required; the Multi mod did not acknowledge session.start.',
        ),
      );
    }, modSessionStartTimeoutMs);
    const ready = () => {
      clearTimeout(timer);
      resolve();
    };
    process.once('multi-mod-session-start', ready);
  });
}

async function anthropicSignedIn(): Promise<boolean> {
  // Ask Claude, including its OS credential store and configured helpers. Never read its tokens.
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    return true;
  }
  let stdout: string;
  try {
    const invocation = claudeCommand(['auth', 'status', '--json']);
    ({ stdout } = await promisify(execFile)(invocation.command, invocation.args, {
      timeout: 10000,
      maxBuffer: 65536,
      ...invocation.options,
    }));
  } catch (error) {
    stdout = failedAuthProbeOutput(error);
  }
  return parseAuthProbeOutput(stdout);
}

async function discoverOpenAI(authFile: string) {
  if (!providerEnabled('openai')) {
    return { codexSignedIn: false, openaiReview: false };
  }
  let codexSignedIn = false;
  try {
    await readCodexAuth(authFile);
    codexSignedIn = true;
  } catch {
    console.error('OpenAI choices unavailable: sign in with codex login to enable them.');
  }
  let openaiReview = false;
  if (codexSignedIn) {
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

/** One admission result is shared by every native provider, so it has to be judged by the
 * validator that rejects the least: a rule Antigravity supports natively must not be refused
 * here because Cursor cannot express it. Cursor re-validates with its own policy on its own
 * dispatch, where the rejection belongs and where it can name the file. */
export function sharedAdmission(antigravity: boolean): CursorSettingsOptions {
  return antigravity
    ? { validate: antigravityPermissionPolicy, cursorToolRules: false }
    : { validate: cursorPermissionPolicy, cursorToolRules: true };
}

export function workerDefinitions(
  codexSignedIn: boolean,
  cursorPicker: CursorModelOption[],
  zen: boolean,
  antigravityModels: AntigravityModel[],
  selectedModels?: readonly string[],
) {
  const agents: Record<string, AgentDefinition> = Object.fromEntries(
    Object.entries(codexSignedIn ? OPENAI_WORKERS : {}).map(([name, { model, effort }]) => [
      name,
      {
        description: `${model}, ${effort} reasoning. Native coding, investigation, and review.`,
        prompt: WORKER_PROMPT,
        model: `multi/openai/${model}`,
        tools: ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write'],
        effort,
      },
    ]),
  );
  for (const option of cursorPicker) {
    agents[option.worker] = {
      description: option.description,
      prompt: WORKER_PROMPT,
      model: option.model,
      tools: ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write'],
    };
  }
  for (const [name, option] of Object.entries(zen ? ZEN_WORKERS : {})) {
    agents[name] = {
      description: `OpenCode Zen ${option.model}${option.effort ? `, ${option.effort} effort` : ''}. Uses native Claude Code tools.`,
      prompt: WORKER_PROMPT,
      model: option.model,
      tools: ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write'],
      ...(option.effort ? { effort: option.effort } : {}),
    };
  }
  for (const option of [...antigravityModels, ...antigravityPickerOptions(antigravityModels)]) {
    const effort = option.id.match(/-(low|medium|high)$/)?.[1] as Effort | undefined;
    agents[option.worker] = {
      description: `${option.label}. Native Antigravity CLI coding worker.`,
      prompt: WORKER_PROMPT,
      model: option.model,
      tools: ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write'],
      ...(effort ? { effort } : {}),
    };
  }
  return selectWorkers(agents, antigravityModels, selectedModels);
}

function selectWorkers(
  agents: Record<string, AgentDefinition>,
  antigravityModels: readonly AntigravityModel[],
  selectedModels: readonly string[] | undefined,
) {
  if (selectedModels === undefined) {
    return agents;
  }
  const selected = new Set(selectedModels);
  const nativeModels = new Set(antigravityModels.map((option) => option.model));
  for (const option of antigravityModels) {
    const base = option.model.replace(/-(low|medium|high)$/, '');
    // Synthesized picker rows own their native effort variants. Independently
    // advertised base and variant rows remain separate selections.
    if (!nativeModels.has(base) && selected.has(base)) {
      selected.add(option.model);
    }
  }
  return Object.fromEntries(
    Object.entries(agents).filter(([, worker]) => selected.has(worker.model)),
  );
}

interface LauncherInvocation {
  command: string;
  args: readonly string[];
  viaComSpec?: boolean;
}

export function checkLauncherArgumentLimit(
  agents: Record<string, AgentDefinition>,
  invocation: LauncherInvocation,
  executable: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== 'win32') {
    return;
  }
  const viaComSpec = invocation.viaComSpec ?? /(?:^|[\\/])cmd\.exe$/i.test(invocation.command);
  const limit = viaComSpec ? 8000 : 32000;
  const commandLine = [invocation.command, ...invocation.args].join(' ');
  if (commandLine.length <= limit) {
    return;
  }
  const providers = new Map<string, number>();
  for (const [name, agent] of Object.entries(agents)) {
    const provider = agent.model.split('/')[1] ?? 'unknown';
    providers.set(
      provider,
      (providers.get(provider) ?? 0) + Buffer.byteLength(JSON.stringify({ [name]: agent })),
    );
  }
  const largest = [...providers.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([provider, bytes]) => `${provider} (${bytes} B)`)
    .join(', ');
  const shim = viaComSpec ? ' cmd.exe shim' : '';
  throw new Error(
    `Native worker registration needs ${commandLine.length.toLocaleString('en-US')} characters for ${executable}, above the Windows${shim} limit of ${limit.toLocaleString('en-US')}. Largest providers: ${largest || 'none'}. Disable providers or extra models to reduce the launcher arguments.`,
  );
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

async function initialSelection(args: string[], settings: LaunchSettings, anthropic: boolean) {
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
  const options = settings.modelPicker.options;
  const defaultModel =
    process.env.MULTI_MODELS === undefined
      ? options.find((option) => option.model === 'multi/openai/gpt-5.6-luna')
      : undefined;
  const fallback = anthropic ? undefined : (defaultModel ?? options[0])?.model;
  return { initialModel, selectedModel: initialModel ?? fallback };
}

function filterPicker(
  settings: LaunchSettings,
  selection: string | undefined,
  defaultModels: readonly string[] = [],
) {
  if (selection === undefined) {
    return;
  }
  if (selection === 'all') {
    return;
  }
  const additive = selection.startsWith('+');
  const models = [
    ...new Set(
      (additive ? `${defaultModels.join(',')},${selection.slice(1)}` : selection)
        .split(',')
        .map((model) => model.trim())
        .filter(Boolean),
    ),
  ];
  const available = new Map(settings.modelPicker.options.map((option) => [option.model, option]));
  settings.modelPicker.options = models.map((model) => {
    const option = available.get(model);
    if (!option) {
      throw new Error(
        `MULTI_MODELS: model is not available from a connected provider in this launcher's picker: ${model}. Check the full ID with --cursor-models or --zen-models, then add it with /multi-core:setup --models <id>.`,
      );
    }
    return option;
  });
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
  cursorAvailable: boolean,
  openaiReview: boolean,
) {
  const approvalProviders: ('openai' | 'cursor')[] = cursorAvailable ? ['cursor'] : [];
  if (openaiReview) {
    approvalProviders.push('openai');
  }
  return {
    approvalProviders,
    approvalBridge: openaiReview ? await createOpenAIApproval(authFile, process.cwd()) : undefined,
  };
}

function configureApproval(
  settings: LaunchSettings,
  providers: readonly ('openai' | 'cursor')[],
  selectedModel?: string,
  antigravityAvailable = false,
  anthropic = false,
) {
  const provider = approvalProvider(selectedModel);
  const nativeAntigravity = antigravityAvailable && selectedModel?.startsWith('multi/antigravity/');
  // Auto mode is a Claude session capability. Keep it available when Claude is
  // authenticated, even if the initial model has no external reviewer; the
  // gateway still rejects unsupported external review requests, while a later
  // switch back to Claude can use its native reviewer.
  if (!anthropic && !nativeAntigravity && (!provider || !providers.includes(provider))) {
    settings.permissions = { ...settings.permissions, disableAutoMode: 'disable' };
  }
  // Observe tool workspace information for reviewer attribution. This hook never
  // vetoes execution; Claude's checks and the actual reviewer request decide.
  const command = hookCommand(new URL('./gateway/permission-hook.ts', import.meta.url));
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
  if (command === '--antigravity-setup') {
    await installAntigravityHook();
    console.log('Antigravity native permission hook installed. Native login remains owned by agy.');
    process.exit(0);
  }
  if (command === '--antigravity-models') {
    console.log(JSON.stringify(await discoverAntigravityModels(), null, 2));
    process.exit(0);
  }
  if (command === '--zen-models') {
    console.log(JSON.stringify(ZEN_MODELS, null, 2));
    process.exit(0);
  }
  if (command === '--help') {
    console.log(
      'Usage: node plugins/multi-core/src/launcher.ts [--cursor-login | --cursor-models | --zen-models | --antigravity-models | --antigravity-setup] [-- <claude arguments>]\nLaunch Claude with external models and native coding workers.\n--cursor-login: official Cursor SDK browser sign-in\n--cursor-models: list account model choices and worker names\n--zen-models: list supported Zen models and capabilities\nMULTI_ANTIGRAVITY=1: enable native Antigravity models and workers\n--antigravity-setup: install the scoped native permission hook\n--antigravity-models: inspect the official Antigravity CLI catalog (native login required)\nOPENCODE_API_KEY: Zen key (or use OpenCode /connect)\nMULTI_ZEN_MODELS: comma-separated Zen model IDs to show, leaving other providers unchanged\nMULTI_MODELS: comma-separated full model IDs to show in /model (unset: defaults; empty: hide external rows)\nMULTI_CURSOR_EXTRA_MODELS: comma-separated Cursor model IDs to add to Auto, Grok 4.6, and Composer 2.5 in /model',
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

function selectedCursorOptions(cursorModels: CursorModelOption[], fullCatalog: boolean) {
  if (fullCatalog) {
    return cursorModels;
  }
  return cursorPickerOptions(
    cursorModels,
    cursorModels.length ? process.env.MULTI_CURSOR_EXTRA_MODELS : undefined,
  );
}

/** Client compatibility only, not provider equivalence. Both profiles default to 200K
 * in Claude 2.1.267; newer xhigh profiles imply native 1M and are deliberately not used.
 * Provider validation remains authoritative for every requested effort value. */
function pickerProfile(adjustableEffort: boolean): string {
  return adjustableEffort ? 'claude-sonnet-4-6' : 'claude-haiku-4-5';
}

function pickerSettings(
  codexSignedIn: boolean,
  cursorPicker: CursorModelOption[],
  zen: boolean,
  antigravityModels: AntigravityModel[],
  fullCatalog = false,
) {
  let zenOptions = zenPickerOptions('');
  if (zen) {
    zenOptions = fullCatalog ? zenModelOptions() : zenPickerOptions(process.env.MULTI_ZEN_MODELS);
  }
  const settings: LaunchSettings = {
    modelPicker: {
      options: [
        ...Object.values(codexSignedIn ? MODELS : {}).map((model) => ({
          model: `multi/openai/${model}`,
          label: model,
          description: 'OpenAI subscription · native Claude Code harness',
          behavesAs: pickerProfile(true),
        })),
        ...cursorPicker.map(({ model, label, description, catalog }) => ({
          model,
          label,
          description,
          behavesAs: pickerProfile(
            catalog.parameters?.some(({ id }) => ['effort', 'reasoning_effort'].includes(id)) ??
              false,
          ),
        })),
        ...antigravityPickerOptions(antigravityModels).map(({ model, label }) => ({
          model,
          label,
          behavesAs: pickerProfile(true),
          description: 'Native Antigravity CLI',
        })),
        ...zenOptions.map(({ model, label, efforts }) => ({
          model,
          label: `Zen · ${label}`,
          behavesAs: pickerProfile(Boolean(efforts?.length)),
          description: `Zen API billing · Claude tools${efforts ? '' : ' · native reasoning; /effort not applicable'}`,
        })),
      ],
    },
  };
  return settings;
}

/**
 * CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC also blocks the plugin worker's
 * loopback call to this gateway, which the Mods control plane requires. Keep
 * the user's intent (no updater, telemetry or error reports) with the narrower
 * flags instead of silently running without the mod.
 */
function translateTrafficPolicy(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC === undefined) {
    return env;
  }
  const { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: _flag, ...rest } = env;
  process.stderr.write(
    'Multi: CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC would block the local gateway; using DISABLE_AUTOUPDATER, DISABLE_TELEMETRY, DISABLE_ERROR_REPORTING and DISABLE_BUG_COMMAND instead.\n',
  );
  return {
    ...rest,
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_BUG_COMMAND: '1',
  };
}

function gatewayEnvironment(port: number, token: string, anthropic: boolean, cursor: boolean) {
  const env = translateTrafficPolicy({ ...process.env });
  delete env.OPENCODE_API_KEY;
  return {
    ...env,
    CLAUDE_CODE_DISABLE_AGENT_VIEW: '1',
    // Native runs and extended OpenAI reasoning can outlive Claude's default
    // API timer; preserve explicit user limits.
    API_TIMEOUT_MS: process.env.API_TIMEOUT_MS ?? '2147483647',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    // A custom base URL disables Claude's on-demand tool loading unless opted in.
    // We forward Claude tool references; preserve an explicit user preference.
    ENABLE_TOOL_SEARCH: process.env.ENABLE_TOOL_SEARCH ?? 'auto',
    MULTI_GATEWAY_TOKEN: token,
    MULTI_CURSOR_DISPLAY_TOOLS: cursor ? '1' : '0',
    CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1',
    MULTI_MOD_GATEWAY_URL: `http://127.0.0.1:${port}`,
    ...(!anthropic ? { ANTHROPIC_AUTH_TOKEN: token } : {}),
    ANTHROPIC_CUSTOM_HEADERS: [
      process.env.ANTHROPIC_CUSTOM_HEADERS,
      `x-multi-gateway-token: ${token}`,
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

function traceEvent(event: GatewayEvent) {
  if (process.env.MULTI_NATIVE_TRACE === '1') {
    process.stderr.write(`[native] ${JSON.stringify(event)}\n`);
  }
}

async function discoverAntigravity() {
  let antigravityModels: AntigravityModel[] = [];
  if (providerEnabled('antigravity') && process.env.MULTI_ANTIGRAVITY === '1') {
    try {
      resolveExecutable('agy');
      antigravityModels = await discoverAntigravityModels();
    } catch (error) {
      if (!isMissingExecutable(error)) {
        throw error;
      }
      console.error(
        `Antigravity choices unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (enabledProviders?.includes('antigravity') && antigravityModels.length) {
    await installAntigravityHook();
  }
  return antigravityModels;
}

function isMissingExecutable(error: unknown): boolean {
  return recordValue(error)?.code === 'ENOENT';
}

async function findPluginRoot(file: string): Promise<string> {
  for (let directory = path.dirname(path.resolve(file)); ; directory = path.dirname(directory)) {
    try {
      await stat(path.join(directory, '.claude-plugin', 'plugin.json'));
      return directory;
    } catch {
      const parent = path.dirname(directory);
      if (parent === directory) {
        throw new Error(`Could not find the Multi plugin root above ${file}`);
      }
    }
  }
}

function hasPluginDirectory(args: readonly string[]): boolean {
  return args.some((arg) => arg === '--plugin-dir' || arg.startsWith('--plugin-dir='));
}

function launcherArguments(
  args: readonly string[],
  settingsFile: string,
  definitions: string,
  inventory: PluginPermissionInventory,
  pluginRoot: string,
): string[] {
  const pluginDirectory =
    !hasPluginDirectory(args) && (!inventory.multiCoreEnabled || hasEmptySettingSources(args))
      ? ['--plugin-dir', pluginRoot]
      : [];
  return ['--settings', settingsFile, '--agents', definitions, ...args, ...pluginDirectory];
}

function hasEmptySettingSources(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--setting-sources' && args[index + 1] === '') {
      return true;
    }
    if (arg === '--setting-sources=') {
      return true;
    }
  }
  return false;
}
