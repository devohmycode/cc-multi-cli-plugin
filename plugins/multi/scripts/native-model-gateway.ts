#!/usr/bin/env node
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createNativeGateway, MODELS, OPENAI_WORKERS, readCodexAuth } from './lib/native-gateway.ts';
import { CursorBridge } from './lib/native-cursor.ts';
import { cursorModelOptions } from './lib/native-cursor-models.ts';
import type { CursorModelOption } from './lib/native-cursor-models.ts';
import type { GatewayEvent } from './lib/native-gateway.ts';
import type { Effort } from './lib/native-responses.ts';

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

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--help') {
    console.log('Usage: node native-model-gateway.ts [--cursor-login | --cursor-models] [-- <claude arguments>]\nLaunch Claude with OpenAI and signed-in Cursor models and native workers.\n--cursor-login: official Cursor SDK browser sign-in\n--cursor-models: list account model choices and worker names');
    process.exit(0);
  }
  if (args[0] === '--cursor-login') {
    const { Cursor } = await import('@cursor/sdk');
    await Cursor.auth.login({ apiKeyName: 'cc-multi-cli', onLoginUrl: url => console.log(`Cursor login: ${url}`) });
    console.log('Cursor SDK login saved. Launch the gateway normally to use it.');
    process.exit(0);
  }
  const { Cursor } = await import('@cursor/sdk');
  const cursorSignedIn = Boolean(process.env.CURSOR_API_KEY) || (await Cursor.auth.status()).status === 'logged-in';
  let cursorModels: CursorModelOption[] = [];
  if (cursorSignedIn) {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Cursor model discovery timed out')), 15000); });
      cursorModels = cursorModelOptions(await Promise.race([Cursor.models.list(), timeout]));
    } catch (error) {
      if (args[0] === '--cursor-models') throw error;
      console.error(`Cursor choices unavailable: ${error instanceof Error ? error.message : String(error)}`);
    } finally { clearTimeout(timer); }
  }
  if (args[0] === '--cursor-models') {
    if (!cursorSignedIn) throw new Error('Run with --cursor-login first.');
    console.log(JSON.stringify(cursorModels.map(({ model, label, worker, selection, nativeWorker }) => ({ model, label, worker: nativeWorker ? worker : undefined, selection })), null, 2));
    process.exit(0);
  }
  if (args[0] === '--') args.shift();
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_BASE_URL) {
    throw new Error('Start without ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or ANTHROPIC_BASE_URL so Claude keeps its subscription login.');
  }
  if (args.some(arg => arg === '--agents' || arg.startsWith('--agents='))) throw new Error('This launcher supplies --agents; use agent files for additional agents.');
  const authFile = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
  let codexSignedIn = false;
  try { await readCodexAuth(authFile); codexSignedIn = true; }
  catch { console.error('OpenAI choices unavailable: sign in with codex login to enable them.'); }
  const token = randomBytes(32).toString('hex');
  const cursor = cursorModels.length ? new CursorBridge(cursorModels) : undefined;
  const server = createNativeGateway({ token, authFile, cursor,
    onEvent: process.env.MULTI_NATIVE_TRACE === '1' ? (event: GatewayEvent) => process.stderr.write(`[native] ${JSON.stringify(event)}\n`) : undefined });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Gateway did not bind a local port.');
  const agents: Record<string, AgentDefinition> = Object.fromEntries(Object.entries(codexSignedIn ? OPENAI_WORKERS : {}).map(([name, { model, effort }]) => [name, {
      description: `${model}, ${effort} reasoning. Native coding, investigation, and review.`,
      prompt: 'You are an OpenAI coding agent running inside Claude Code. Use the provided native tools to complete the delegated task. Follow its scope and permissions. Keep required shell commands in the foreground (run_in_background: false), with an appropriate timeout, and wait for their exit status before reporting completion. A background launch is not a completed task. Report the result, verification, and any unresolved issues. Do not invoke external coding CLIs.',
      model: `multi/openai/${model}`, tools: ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write'], effort
  }]));
  for (const option of cursorModels.filter(option => option.nativeWorker)) agents[option.worker] = {
    description: `${option.label}. Coding, investigation, and review through Cursor's SDK with Claude-executed tools.`,
    prompt: 'Complete the delegated task using the supplied Claude Code tools. Respect its scope and permissions. Verify changes and report the result and unresolved issues. Do not invoke external coding CLIs.',
    model: option.model, tools: ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write']
  };
  const settings: { modelPicker: { options: ModelOption[] } } = { modelPicker: { options: [...Object.values(codexSignedIn ? MODELS : {}).map(model => ({
    model: `multi/openai/${model}`, label: model, description: 'OpenAI subscription · native Claude Code harness'
  })), ...cursorModels.map(({ model, label, description }) => ({ model, label, description }))] } };
  const settingsDir = await mkdtemp(path.join(os.tmpdir(), 'multi-native-settings-'));
  const settingsFile = path.join(settingsDir, 'settings.json');
  await writeFile(settingsFile, JSON.stringify(settings), { mode: 0o600 });
  const definitions = JSON.stringify(agents);
  if (Buffer.byteLength(definitions) > 120000) {
    server.close(); await cursor?.close(); await rm(settingsDir, { recursive: true, force: true });
    throw new Error('Cursor worker catalog exceeds the launcher argument limit. Worker registration needs a file-based Claude plugin.');
  }
  const child = spawn('claude', ['--settings', settingsFile, '--agents', definitions, ...args], { stdio: 'inherit', env: {
    ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
    ANTHROPIC_CUSTOM_HEADERS: [process.env.ANTHROPIC_CUSTOM_HEADERS, `x-multi-gateway-token: ${token}`].filter(Boolean).join('\n')
  } });
  const shutdown = async () => { server.closeAllConnections(); server.close(); await cursor?.close(); await rm(settingsDir, { recursive: true, force: true }); };
  child.once('error', error => { console.error(error.message); void shutdown().finally(() => process.exit(1)); });
  child.once('exit', code => { void shutdown().finally(() => process.exit(code ?? 1)); });
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  // The foreground terminal delivers SIGINT to both processes; keep the gateway alive
  // while Claude handles its normal interrupt UI.
  process.on('SIGINT', () => {});
}

void main().catch(error => {
  console.error(`Native gateway: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
