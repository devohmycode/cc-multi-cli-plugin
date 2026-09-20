// Opt-in live contract for the official Grok Build CLI. The default run uses
// three paid turns: one native write, one resumed read, and one turn whose shell
// capability Claude removed, with a free cached replay proving that a saved
// response does not repeat the write.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  MessagesRequest,
  MessagesResponse,
} from '../../plugins/multi-core/src/gateway/messages.ts';
import type { PermissionContext } from '../../plugins/multi-core/src/gateway/mode-hook.ts';
import type { GrokRunOptions, GrokStreamEvent } from '../../plugins/multi-grok/src/cli.ts';
import { runGrok } from '../../plugins/multi-grok/src/cli.ts';
import { GrokHarness } from '../../plugins/multi-grok/src/harness.ts';
import { discoverGrokModels } from '../../plugins/multi-grok/src/models.ts';
import { grokPermissionPolicy } from '../../plugins/multi-grok/src/permissions.ts';
import { readGrokAuth } from '../../plugins/multi-grok/src/usage.ts';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(
    'Usage: node test/live/native-grok.ts [--model MODEL] [--mode auto|acceptEdits|plan|bypassPermissions] [--mcp TOOL]\nDefault: three bounded turns plus a saved-response replay. Requires a Grok Build login. --mcp names one configured MCP tool and adds a turn that must be refused.',
  );
  process.exit(0);
}

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

const requestedMode = option('--mode') ?? 'auto';
const mcpTool = option('--mcp');
const modes = ['auto', 'acceptEdits', 'plan', 'bypassPermissions'] as const;
assert(
  modes.includes(requestedMode as (typeof modes)[number]),
  `Unsupported mode: ${requestedMode}`,
);

const auth = await readGrokAuth();
assert(auth.signedIn, 'Grok Build is not signed in. Run grok login first.');

const models = await discoverGrokModels();
const requested = option('--model');
const model = requested
  ? models.find((candidate) => candidate.id === requested || candidate.model === requested)
  : (models.find((candidate) => candidate.default) ?? models[0]);
assert(model, `Model is not advertised by grok models: ${requested}`);
const route = model.model;

const root = await mkdtemp(path.join(os.tmpdir(), 'native-grok-'));
const cwd = path.join(root, 'workspace');
const stateDirectory = path.join(root, 'state');
await mkdir(cwd);
const target = 'native-write-once.txt';
const nonce = randomBytes(8).toString('hex');
const scope = `live/${randomUUID()}`;
const toolNames: string[] = [];
const sessions: { session?: string; resume?: string }[] = [];
const denials: string[] = [];

function text(response: MessagesResponse): string {
  return response.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
}

const run = async (options: GrokRunOptions) => {
  sessions.push({ session: options.session, resume: options.resume });
  const onEvent = options.onEvent;
  const wrapped = (event: GrokStreamEvent) => {
    if (event.event === 'tool_call' && event.call.toolName) {
      toolNames.push(event.call.toolName);
    }
    if (event.event === 'tool_update' && event.call.status === 'failed') {
      denials.push(JSON.stringify(event.call.content));
    }
    onEvent?.(event);
  };
  return runGrok({ ...options, onEvent: wrapped });
};

const harness = new GrokHarness(models, {
  cwd,
  stateDirectory,
  run,
  checkPermissions: async (runCwd, runContext) =>
    grokPermissionPolicy({ ...runContext, cwd: runCwd }),
});

async function turn(
  messages: NonNullable<MessagesRequest['messages']>,
  context: PermissionContext,
): Promise<MessagesResponse> {
  const response = await harness.handle(
    { model: route, messages },
    scope,
    AbortSignal.timeout(180000),
    undefined,
    context,
  );
  console.log(JSON.stringify({ model: route, response: text(response).slice(0, 400) }));
  return response;
}

const writeContext: PermissionContext = {
  permissionMode: requestedMode as PermissionContext['permissionMode'],
  cwd,
  tools: ['Read', 'Write'],
};
const readOnlyContext: PermissionContext = { ...writeContext, tools: ['Read'] };

try {
  const writePrompt =
    requestedMode === 'plan'
      ? `Report whether ${target} exists in this workspace. Use only native read tools.`
      : `Create the file ${target} in this workspace containing exactly ${nonce}. Write it once with your native write tool, then stop. Do not use the shell, MCP tools, or subagents.`;
  const first = await turn([{ role: 'user', content: writePrompt }], writeContext);
  assert(sessions[0].session && !sessions[0].resume, 'The first turn must open its own session');

  const replay = await turn([{ role: 'user', content: writePrompt }], writeContext);
  assert.equal(sessions.length, 1, 'An identical completed request must not run the CLI again');
  assert.equal(replay.multi_usage?.replayed, true, 'The replayed response must be marked as such');
  assert.equal(text(replay), text(first));

  if (requestedMode !== 'plan') {
    const written = await readFile(path.join(cwd, target), 'utf8');
    assert.match(written, new RegExp(nonce), 'The native write did not reach the workspace');
  }

  const read = await turn(
    [
      { role: 'user', content: writePrompt },
      { role: 'assistant', content: first.content },
      { role: 'user', content: `Report the exact contents of ${target} and nothing else.` },
    ],
    writeContext,
  );
  assert.equal(sessions.length, 2, 'The follow-up must reach the CLI');
  assert.equal(sessions[1].resume, sessions[0].session, 'The follow-up must resume the session');
  if (requestedMode !== 'plan') {
    assert.match(text(read), new RegExp(nonce), 'The resumed session lost its own record');
  }

  // Claude removed Bash for this turn; the native toolset must not offer the shell
  // and the run must still finish instead of hanging on an approval.
  const denied = await turn(
    [
      { role: 'user', content: writePrompt },
      { role: 'assistant', content: first.content },
      {
        role: 'user',
        content: `Run the shell command: echo ${nonce}. If you cannot, say exactly SHELL UNAVAILABLE.`,
      },
    ],
    readOnlyContext,
  );
  assert.equal(sessions.length, 3);
  assert.equal(
    toolNames.includes('run_terminal_command'),
    false,
    'A removed shell tool was still offered to the model',
  );
  assert.match(text(denied), /SHELL UNAVAILABLE|cannot|unable|not available/i);

  if (mcpTool) {
    const mcp = await turn(
      [
        { role: 'user', content: writePrompt },
        { role: 'assistant', content: first.content },
        {
          role: 'user',
          content: `Call the MCP tool ${mcpTool} once. Report exactly what happened.`,
        },
      ],
      readOnlyContext,
    );
    assert.equal(
      toolNames.some((name) => name === mcpTool),
      false,
      `The MCP tool ${mcpTool} executed despite the deny rule`,
    );
    console.log(JSON.stringify({ mcp: text(mcp).slice(0, 300), denials }));
  }

  console.log(
    JSON.stringify({
      ok: true,
      model: model.id,
      mode: requestedMode,
      turns: sessions.length,
      tools: [...new Set(toolNames)],
      denials: denials.length,
    }),
  );
} finally {
  await harness.close();
}
