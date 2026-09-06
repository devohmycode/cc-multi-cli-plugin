#!/usr/bin/env node
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createNativeGateway, MODELS, OPENAI_WORKERS, readCodexAuth } from './lib/native-gateway.mjs';

const args = process.argv.slice(2);
if (args[0] === '--help') {
  console.log('Usage: node native-model-gateway.mjs [-- <claude arguments>]\nLaunch Claude with GPT models in /model and native OpenAI workers, using existing Claude and Codex subscription logins.');
  process.exit(0);
}
if (args[0] === '--') args.shift();
if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_BASE_URL) {
  throw new Error('Start without ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or ANTHROPIC_BASE_URL so Claude keeps its subscription login.');
}
if (args.some(arg => arg === '--agents' || arg.startsWith('--agents='))) throw new Error('This launcher supplies --agents; use agent files for additional agents.');
const authFile = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
await readCodexAuth(authFile);
const token = randomBytes(32).toString('hex');
const server = createNativeGateway({ token, authFile,
  onEvent: process.env.MULTI_NATIVE_TRACE === '1' ? event => process.stderr.write(`[native] ${JSON.stringify(event)}\n`) : undefined });
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const agents = Object.fromEntries(Object.entries(OPENAI_WORKERS).map(([name, { model, effort }]) => [name, {
    description: `${model}, ${effort} reasoning. Native coding, investigation, and review.`,
    prompt: 'You are an OpenAI coding agent running inside Claude Code. Use the provided native tools to complete the delegated task. Follow its scope and permissions. Keep required shell commands in the foreground (run_in_background: false), with an appropriate timeout, and wait for their exit status before reporting completion. A background launch is not a completed task. Report the result, verification, and any unresolved issues. Do not invoke external coding CLIs.',
    model: `multi/openai/${model}`, tools: ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write'], effort
}]));
const settings = { modelPicker: { options: Object.values(MODELS).map(model => ({
  model: `multi/openai/${model}`, label: model, description: 'OpenAI subscription · native Claude Code harness'
})) } };
const child = spawn('claude', ['--settings', JSON.stringify(settings), '--agents', JSON.stringify(agents), ...args], { stdio: 'inherit', env: {
  ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
  ANTHROPIC_CUSTOM_HEADERS: [process.env.ANTHROPIC_CUSTOM_HEADERS, `x-multi-gateway-token: ${token}`].filter(Boolean).join('\n')
} });
const shutdown = () => { server.closeAllConnections(); server.close(); };
child.once('error', error => { console.error(error.message); shutdown(); process.exitCode = 1; });
child.once('exit', code => { shutdown(); process.exitCode = code ?? 1; });
process.on('SIGTERM', () => child.kill('SIGTERM'));
// The foreground terminal delivers SIGINT to both processes; keep the gateway alive
// while Claude handles its normal interrupt UI.
process.on('SIGINT', () => {});
