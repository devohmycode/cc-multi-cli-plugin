#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
import { mergeCursorPermissions } from '../../multi-cursor/src/permissions.ts';
import { CursorWorkspaces } from '../../multi-cursor/src/workspaces.ts';
import { createOpenAIApproval, discoverOpenAIReviewer } from '../../multi-openai/src/approval.ts';
import { readCodexAuth } from '../../multi-openai/src/auth.ts';
import { MODELS, OPENAI_WORKERS } from '../../multi-openai/src/models.ts';
import type { Effort } from '../../multi-openai/src/responses.ts';
import { readZenKey } from '../../multi-zen/src/auth.ts';
import { ZEN_MODELS, ZEN_WORKERS, zenPickerOptions } from '../../multi-zen/src/models.ts';
import { AgentCatalog } from './gateway/agent-catalog.ts';
import { loadWorkerPermissions } from './gateway/agent-definitions.ts';
import { checkCursorSettings } from './gateway/cursor-settings.ts';
import { ModBridge } from './gateway/mod-bridge.ts';
import { PermissionModes } from './gateway/mode-hook.ts';
import { hookCommand } from './gateway/permission-hook.ts';
import type { GatewayEvent } from './gateway/server.ts';
import { createNativeGateway } from './gateway/server.ts';

import { providerSelection } from './install/plugins.ts';

const enabledProviders = providerSelection(process.env.MULTI_ENABLED_PROVIDERS);
const providerEnabled = (provider: string) =>
  enabledProviders?.some((name) => name === provider) ?? true;
const claudeExecutable = process.env.MULTI_REAL_CLAUDE || 'claude';

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
  await assertFunctionHooksSupported();
  const anthropic = await anthropicSignedIn();
  const cursorPicker = cursorPickerOptions(
    cursorModels,
    cursorModels.length ? process.env.MULTI_CURSOR_EXTRA_MODELS : undefined,
  );
  const authFile = path.join(
    process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    'auth.json',
  );
  const { codexSignedIn, openaiReview } = await discoverOpenAI(authFile);
  const zenKey = providerEnabled('zen') ? await readZenKey() : undefined;
  const antigravityModels = await discoverAntigravity();
  const token = randomBytes(32).toString('hex');
  const settings = pickerSettings(codexSignedIn, cursorPicker, Boolean(zenKey), antigravityModels);
  await mergeSettings(args, settings);
  // The supervisor does not transfer --agents or our session-local gateway env,
  // and can outlive the child whose exit releases settingsDir and the gateway.
  // Keep ordinary background subagent tasks available within this owned session.
  settings.disableAgentView = true;
  filterPicker(settings, process.env.MULTI_MODELS);
  const callerSettings = structuredClone(settings);
  const { cursor, antigravity } = nativeHarnesses(
    cursorModels,
    antigravityModels,
    args,
    callerSettings,
  );
  const agents = workerDefinitions(codexSignedIn, cursorModels, Boolean(zenKey), antigravityModels);
  const modBridge = new ModBridge();
  const settingsDir = await mkdtemp(path.join(os.tmpdir(), 'multi-native-settings-'));
  const permissionModes = [cursor, antigravity].some(Boolean)
    ? new PermissionModes((cwd) =>
        loadWorkerPermissions(cwd, agents, [...args, '--settings', JSON.stringify(callerSettings)]),
      )
    : undefined;
  const { approvalBridge, approvalProviders } = await discoverApprovals(
    authFile,
    cursorModels.length > 0,
    openaiReview,
  );
  const server = createNativeGateway({
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
  if (Buffer.byteLength(definitions) > 120000) {
    server.close();
    await cursor?.close();
    await antigravity?.close();
    await rm(settingsDir, { recursive: true, force: true });
    throw new Error(
      'Cursor worker catalog exceeds the launcher argument limit. Worker registration needs a file-based Claude plugin.',
    );
  }
  const ready = awaitModSessionStart();
  const child = spawn(
    claudeExecutable,
    ['--settings', settingsFile, '--agents', definitions, ...args],
    {
      stdio: 'inherit',
      env: gatewayEnvironment(address.port, token, anthropic),
    },
  );
  const shutdown = async () => {
    server.closeAllConnections();
    server.close();
    await cursor?.close();
    await antigravity?.close();
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
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  // The foreground terminal delivers SIGINT to both processes; keep the gateway alive
  // while Claude handles its normal interrupt UI.
  process.on('SIGINT', () => {});
}

void main().catch((error) => {
  console.error(`Native gateway: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

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
          const restrictions = await checkCursorSettings(cwd, args, callerSettings);
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
  try {
    ({ stdout } = await promisify(execFile)(claudeExecutable, ['--version'], {
      timeout: 10000,
      maxBuffer: 65536,
    }));
  } catch {
    throw new Error(
      'Claude Code 2.1.272 or newer with function hooks is required; unable to read claude --version.',
    );
  }
  const match = stdout.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!match || !atLeastVersion(match.slice(1).map(Number), [2, 1, 272])) {
    throw new Error('Claude Code 2.1.272 or newer with function hooks is required.');
  }
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

function awaitModSessionStart(): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      process.off('multi-mod-session-start', ready);
      reject(
        new Error(
          'Claude Code 2.1.272 or newer with loaded function hooks is required; the Multi mod did not acknowledge session.start.',
        ),
      );
    }, 5000);
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
    ({ stdout } = await promisify(execFile)(claudeExecutable, ['auth', 'status', '--json'], {
      timeout: 10000,
      maxBuffer: 65536,
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

function workerDefinitions(
  codexSignedIn: boolean,
  cursorModels: CursorModelOption[],
  zen: boolean,
  antigravityModels: AntigravityModel[],
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
  for (const option of cursorModels.filter((option) => option.nativeWorker)) {
    agents[option.worker] = {
      description: `${option.label}. Native Cursor coding worker with its own tools, conversation state, and review.`,
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
      description: `${option.label}. Experimental native CLI coding worker.`,
      prompt: WORKER_PROMPT,
      model: option.model,
      tools: ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write'],
      ...(effort ? { effort } : {}),
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

function filterPicker(settings: LaunchSettings, selection: string | undefined) {
  if (selection === undefined) {
    return;
  }
  const models = [
    ...new Set(
      selection
        .split(',')
        .map((model) => model.trim())
        .filter(Boolean),
    ),
  ];
  const available = new Map(settings.modelPicker.options.map((option) => [option.model, option]));
  settings.modelPicker.options = models.map((model) => {
    const option = available.get(model);
    if (!option) {
      throw new Error(`MULTI_MODELS: model is not available in this launcher's picker: ${model}`);
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
  const nativeClaude =
    anthropic && (!selectedModel?.startsWith('multi/') || selectedModel.startsWith('multi/zen/'));
  if (!nativeClaude && !nativeAntigravity && (!provider || !providers.includes(provider))) {
    settings.permissions = { ...settings.permissions, disableAutoMode: 'disable' };
  }
  // --settings is fixed for the session. A per-tool capability guard also covers
  // /model changes and workers, without calling a model or classifying commands.
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
      'Usage: node plugins/multi-core/src/launcher.ts [--cursor-login | --cursor-models | --zen-models | --antigravity-models | --antigravity-setup] [-- <claude arguments>]\nLaunch Claude with external models and native coding workers.\n--cursor-login: official Cursor SDK browser sign-in\n--cursor-models: list account model choices and worker names\n--zen-models: list supported Zen models and capabilities\nMULTI_ANTIGRAVITY=1: enable experimental native Antigravity models and workers\n--antigravity-setup: install the scoped native permission hook\n--antigravity-models: inspect the official Antigravity CLI catalog (native login required)\nOPENCODE_API_KEY: Zen key (or use OpenCode /connect)\nMULTI_ZEN_MODELS: comma-separated Zen model IDs to show, leaving other providers unchanged\nMULTI_MODELS: comma-separated full model IDs to show in /model (unset: defaults; empty: hide external rows)\nMULTI_CURSOR_EXTRA_MODELS: comma-separated Cursor model IDs to add to Auto, Grok 4.6, and Composer 2.5 in /model',
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
) {
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
          description: 'Experimental · native Antigravity CLI · cache reuse under validation',
        })),
        ...(zen ? zenPickerOptions(process.env.MULTI_ZEN_MODELS) : []).map(
          ({ model, label, efforts }) => ({
            model,
            label: `Zen · ${label}`,
            behavesAs: pickerProfile(Boolean(efforts?.length)),
            description: `Zen API billing · Claude tools${efforts ? '' : ' · native reasoning; /effort not applicable'}`,
          }),
        ),
      ],
    },
  };
  return settings;
}

function gatewayEnvironment(port: number, token: string, anthropic: boolean) {
  const env = { ...process.env };
  delete env.OPENCODE_API_KEY;
  return {
    ...env,
    CLAUDE_CODE_DISABLE_AGENT_VIEW: '1',
    // Native runs and extended OpenAI reasoning can outlive Claude's default
    // API timer; preserve explicit user limits.
    API_TIMEOUT_MS: process.env.API_TIMEOUT_MS ?? '2147483647',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    MULTI_GATEWAY_TOKEN: token,
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
  const antigravityModels =
    providerEnabled('antigravity') && process.env.MULTI_ANTIGRAVITY === '1'
      ? await discoverAntigravityModels()
      : [];
  if (enabledProviders?.includes('antigravity') && antigravityModels.length) {
    await installAntigravityHook();
  }
  return antigravityModels;
}
