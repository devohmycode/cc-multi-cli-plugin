import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { AgentCatalog } from '../../plugins/multi-core/src/gateway/agent-catalog.ts';
import {
  checkLauncherArgumentLimit,
  workerDefinitions,
} from '../../plugins/multi-core/src/launcher.ts';
import { cursorModelOptions, cursorPickerOptions } from '../../plugins/multi-cursor/src/models.ts';
import { ZEN_MODELS } from '../../plugins/multi-zen/src/models.ts';

async function writeClaudeFixture(bin: string, source: string): Promise<void> {
  if (process.platform === 'win32') {
    await writeFile(path.join(bin, 'claude-fixture.js'), source);
    await writeFile(
      path.join(bin, 'claude.cmd'),
      // npm's global shim layout, so the launcher runs the fixture through Node directly.
      `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\claude-fixture.js" %*\r\n`,
    );
    return;
  }
  await writeFile(path.join(bin, 'claude'), source, { mode: 0o755 });
}

/** Windows reads the profile and data roots from these, not from HOME. */
function windowsHome(root: string): NodeJS.ProcessEnv {
  if (process.platform !== 'win32') {
    return {};
  }
  return {
    USERPROFILE: root,
    APPDATA: path.join(root, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(root, 'AppData', 'Local'),
  };
}

test('launcher preserves native auth, disables unavailable auto mode, and merges caller settings', {
  skip: process.platform === 'win32',
}, async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'launcher-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(path.join(cwd, 'bin'));
  await writeClaudeFixture(
    path.join(cwd, 'bin'),
    `#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2);
if(args.includes('plugin')&&args.includes('list')){console.log(process.env.TEST_PLUGIN==='enabled'?JSON.stringify([{id:'multi-core@cc-multi-cli-plugin',enabled:true,installPath:process.cwd()}]):'[]');process.exit(0)}
if(args[0]==='--version'){console.log(process.env.TEST_CLAUDE_VERSION??'2.1.272');process.exit(0)}
const result=(value)=>{const base=process.env.MULTI_MOD_GATEWAY_URL;if(!base){console.log(value);return}const url=new URL(base+'/multi/mod/session');const req=require('node:http').request(url,{method:'POST',headers:{'content-type':'application/json','x-multi-gateway-token':process.env.MULTI_GATEWAY_TOKEN}},()=>console.log(value));req.on('error',()=>console.log(value));req.end(JSON.stringify({sessionId:'fixture',event:'start'}));};
if(args[0]==='auth'){if(process.env.TEST_AUTH==='malformed'){console.log('not-json');process.exit(0)}if(process.env.TEST_AUTH==='error'){process.exit(2)}if(process.env.TEST_AUTH==='missing'){console.log('{}');process.exit(0)}process.stdout.write(JSON.stringify({loggedIn:process.env.TEST_AUTH==='yes'}));process.exitCode=process.env.TEST_AUTH==='yes'?0:1}else{
const settings=JSON.parse(fs.readFileSync(args[args.indexOf('--settings')+1],'utf8'));
 result(JSON.stringify({agentView:process.env.CLAUDE_CODE_DISABLE_AGENT_VIEW,backgroundTasks:process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS,functionHooks:process.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS,settings,models:args.filter(x=>x.startsWith('multi/')),args,settingsCount:args.filter(x=>x==='--settings').length,hasLocalToken:!!process.env.MULTI_GATEWAY_TOKEN,apiTimeout:process.env.API_TIMEOUT_MS,toolSearch:process.env.ENABLE_TOOL_SEARCH,auth:process.env.ANTHROPIC_API_KEY?'api':process.env.ANTHROPIC_AUTH_TOKEN?'local':'native'}));}
`,
  );
  const launcher = fileURLToPath(
    new URL('../../plugins/multi-core/src/launcher.ts', import.meta.url),
  );
  for (const auth of ['no', 'yes', 'api']) {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        launcher,
        '--',
        '--model',
        'multi/cursor/auto',
        '--settings',
        JSON.stringify({
          disableAgentView: false,
          permissions: { deny: ['Bash(denied)'] },
          hooks: { Stop: [] },
        }),
      ],
      {
        cwd,
        timeout: 20000,
        env: {
          PATH: path.join(cwd, 'bin') + path.delimiter + process.env.PATH,
          HOME: cwd,
          ...windowsHome(cwd),
          CLAUDE_CONFIG_DIR: path.join(cwd, 'claude'),
          CODEX_HOME: cwd,
          TEST_AUTH: auth,
          CLAUDE_CODE_DISABLE_AGENT_VIEW: '0',
          API_TIMEOUT_MS: auth === 'api' ? '1000' : undefined,
          ENABLE_TOOL_SEARCH: auth === 'api' ? 'false' : undefined,
          ...(auth === 'api' ? { ANTHROPIC_API_KEY: 'fake-test-key' } : {}),
        },
      },
    );
    const result = JSON.parse(stdout);
    assert.equal(result.args.at(-2), '--plugin-dir');
    assert.equal(result.args.at(-1), path.resolve(path.dirname(launcher), '../../..'));
    assert.equal(result.settingsCount, 1);
    assert.equal(result.settings.disableAgentView, true);
    assert.equal(result.agentView, '1');
    assert.equal(result.backgroundTasks, undefined);
    assert.equal(result.functionHooks, '1');
    assert.equal(result.apiTimeout, auth === 'api' ? '1000' : '2147483647');
    assert.equal(result.toolSearch, auth === 'api' ? 'false' : 'auto');
    assert.deepEqual(result.settings.permissions.deny, ['Bash(denied)']);
    assert.equal(
      result.settings.permissions.disableAutoMode,
      auth === 'no' ? 'disable' : undefined,
    );
    assert.equal(
      result.hasLocalToken,
      true,
      'local hooks authenticate independently of Claude login',
    );
    assert.equal(result.auth, { no: 'local', api: 'api', yes: 'native' }[auth]);
    assert.equal(result.settings.hooks.PreToolUse?.length, 1);
  }
  const baseEnvironment = {
    PATH: path.join(cwd, 'bin') + path.delimiter + process.env.PATH,
    HOME: cwd,
    ...windowsHome(cwd),
    CLAUDE_CONFIG_DIR: path.join(cwd, 'claude'),
    CODEX_HOME: cwd,
  };
  const enabled = JSON.parse(
    (
      await promisify(execFile)(process.execPath, [launcher], {
        cwd,
        timeout: 20000,
        env: { ...baseEnvironment, TEST_PLUGIN: 'enabled' },
      })
    ).stdout,
  );
  assert(!enabled.args.includes('--plugin-dir'));
  const supplied = JSON.parse(
    (
      await promisify(execFile)(
        process.execPath,
        [launcher, '--', '--plugin-dir', path.resolve(path.dirname(launcher), '../../..')],
        { cwd, timeout: 20000, env: baseEnvironment },
      )
    ).stdout,
  );
  assert.equal(supplied.args.filter((arg: string) => arg === '--plugin-dir').length, 1);
  for (const auth of ['malformed', 'error', 'missing']) {
    await assert.rejects(
      promisify(execFile)(process.execPath, [launcher, '--', '--model', 'multi/cursor/auto'], {
        cwd,
        timeout: 20000,
        env: {
          PATH: path.join(cwd, 'bin') + path.delimiter + process.env.PATH,
          HOME: cwd,
          ...windowsHome(cwd),
          CLAUDE_CONFIG_DIR: path.join(cwd, 'claude'),
          CODEX_HOME: cwd,
          TEST_AUTH: auth,
        },
      }),
      /Claude auth status probe (returned invalid JSON|failed|returned no boolean loggedIn field)/,
    );
  }
  await assert.rejects(
    promisify(execFile)(process.execPath, [launcher], {
      cwd,
      timeout: 20000,
      env: {
        PATH: path.join(cwd, 'bin') + path.delimiter + process.env.PATH,
        HOME: cwd,
        ...windowsHome(cwd),
        CLAUDE_CONFIG_DIR: path.join(cwd, 'claude'),
        CODEX_HOME: cwd,
        TEST_CLAUDE_VERSION: '2.1.271',
      },
    }),
    /Claude Code 2\.1\.272 or newer with function hooks is required/,
  );
  await mkdir(path.join(cwd, 'claude'));
  await writeFile(
    path.join(cwd, 'claude', 'settings.json'),
    JSON.stringify({ model: 'multi/cursor/auto' }),
  );
  const { stdout } = await promisify(execFile)(process.execPath, [launcher], {
    cwd,
    timeout: 20000,
    env: {
      PATH: path.join(cwd, 'bin') + path.delimiter + process.env.PATH,
      HOME: cwd,
      ...windowsHome(cwd),
      CLAUDE_CONFIG_DIR: path.join(cwd, 'claude'),
      CODEX_HOME: cwd,
    },
  });
  const saved = JSON.parse(stdout);
  assert.deepEqual(
    saved.models,
    [],
    'Keep the native saved model instead of forcing a launcher default',
  );
  assert.equal(saved.settings.permissions.disableAutoMode, 'disable');
});

test('Zen credentials add picker models and named workers without leaking the key to Claude', {
  skip: process.platform === 'win32',
}, async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'launcher-zen-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const bin = path.join(cwd, 'bin');
  await mkdir(bin);
  await writeClaudeFixture(
    bin,
    `#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2);
if(args.includes('plugin')&&args.includes('list')){console.log('[]');process.exit(0)}
if(args[0]==='--version'){console.log(process.env.TEST_CLAUDE_VERSION??'2.1.272');process.exit(0)}
const result=(value)=>{const base=process.env.MULTI_MOD_GATEWAY_URL;if(!base){console.log(value);return}const url=new URL(base+'/multi/mod/session');const req=require('node:http').request(url,{method:'POST',headers:{'content-type':'application/json','x-multi-gateway-token':process.env.MULTI_GATEWAY_TOKEN}},()=>console.log(value));req.on('error',()=>console.log(value));req.end(JSON.stringify({sessionId:'fixture',event:'start'}));};
if(args[0]==='auth'){process.stdout.write(JSON.stringify({loggedIn:false}));process.exitCode=1}else{
const settings=JSON.parse(fs.readFileSync(args[args.indexOf('--settings')+1],'utf8'));
const agents=JSON.parse(args[args.indexOf('--agents')+1]);
result(JSON.stringify({settings,agents:Object.keys(agents),models:args.filter(x=>x.startsWith('multi/')),zenKeyInChild:process.env.OPENCODE_API_KEY,args}));}
`,
  );
  const launcher = fileURLToPath(
    new URL('../../plugins/multi-core/src/launcher.ts', import.meta.url),
  );
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [launcher, '--', '--model', 'multi/zen/gpt-5.6-luna', '--dangerously-skip-permissions'],
    {
      cwd,
      timeout: 20000,
      env: {
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        HOME: cwd,
        ...windowsHome(cwd),
        XDG_DATA_HOME: path.join(cwd, 'data'),
        CLAUDE_CONFIG_DIR: path.join(cwd, 'claude'),
        CODEX_HOME: cwd,
        OPENCODE_API_KEY: 'zen-fixture-key',
      },
    },
  );
  const result = JSON.parse(stdout);
  const pickerModels = result.settings.modelPicker.options.map(
    (option: { model: string }) => option.model,
  );
  assert(pickerModels.includes('multi/zen/deepseek-v4-pro'));
  assert(pickerModels.includes('multi/zen/muse-spark-1.3'));
  assert.equal(
    result.settings.modelPicker.options.find(
      (row: { model: string }) => row.model === 'multi/zen/muse-spark-1.3',
    ).behavesAs,
    'claude-sonnet-4-6',
  );
  assert.equal(
    result.settings.modelPicker.options.find(
      (row: { model: string }) => row.model === 'multi/zen/deepseek-v4-pro',
    ).behavesAs,
    'claude-haiku-4-5',
  );
  assert.match(
    result.settings.modelPicker.options.find(
      (row: { model: string }) => row.model === 'multi/zen/deepseek-v4-pro',
    ).description,
    /effort not applicable/,
  );
  assert(!pickerModels.includes('multi/zen/gpt-5.6-luna'));
  assert(!pickerModels.includes('multi/zen/big-pickle'));
  assert(result.agents.includes('zen-gpt-5.6-luna'));
  assert(result.agents.includes('zen-gpt-5.6-luna-high'));
  assert(result.agents.includes('zen-big-pickle'));
  assert(!result.agents.includes('zen-big-pickle-medium'));
  assert.equal(result.zenKeyInChild, undefined);
  assert.equal(result.settings.permissions.disableAutoMode, 'disable');
  assert(result.args.includes('--dangerously-skip-permissions'));
  assert.deepEqual(result.models, ['multi/zen/gpt-5.6-luna']);
  const disabled = await promisify(execFile)(process.execPath, [launcher], {
    cwd,
    timeout: 20000,
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      HOME: cwd,
      ...windowsHome(cwd),
      XDG_DATA_HOME: path.join(cwd, 'data'),
      CLAUDE_CONFIG_DIR: path.join(cwd, 'claude'),
      CODEX_HOME: cwd,
      OPENCODE_API_KEY: 'invalid key must not be read',
      MULTI_ENABLED_PROVIDERS: '',
    },
  });
  const withoutProviders = JSON.parse(disabled.stdout);
  assert.deepEqual(withoutProviders.settings.modelPicker.options, []);
  assert.deepEqual(withoutProviders.agents, []);

  const launchFiltered = (selection: string, args: string[] = []) =>
    promisify(execFile)(process.execPath, [launcher, ...args], {
      cwd,
      timeout: 20000,
      env: {
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        HOME: cwd,
        ...windowsHome(cwd),
        XDG_DATA_HOME: path.join(cwd, 'data'),
        CLAUDE_CONFIG_DIR: path.join(cwd, 'claude'),
        CODEX_HOME: cwd,
        OPENCODE_API_KEY: 'zen-fixture-key',
        MULTI_MODELS: selection,
        MULTI_ZEN_MODELS: 'big-pickle,glm-5.2',
      },
    });
  const filtered = JSON.parse(
    (await launchFiltered(' multi/zen/big-pickle, multi/zen/glm-5.2,multi/zen/big-pickle ')).stdout,
  );
  assert.deepEqual(
    filtered.settings.modelPicker.options.map((option: { model: string }) => option.model),
    ['multi/zen/big-pickle', 'multi/zen/glm-5.2'],
  );
  assert.deepEqual(filtered.models, ['multi/zen/big-pickle']);
  assert(filtered.agents.includes('zen-gpt-5.6-luna-high'));
  const hidden = JSON.parse(
    (await launchFiltered('', ['--model', 'multi/zen/gpt-5.6-luna'])).stdout,
  );
  assert.deepEqual(hidden.settings.modelPicker.options, []);
  assert.deepEqual(hidden.models, ['multi/zen/gpt-5.6-luna']);
  await assert.rejects(launchFiltered('multi/zen/typo'), /MULTI_MODELS: model is not available/);
});

test('Zen saved auth supplies the no-login fallback without exposing credentials', {
  skip: process.platform === 'win32',
}, async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'launcher-zen-saved-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const bin = path.join(cwd, 'bin');
  const data = path.join(cwd, 'data', 'opencode');
  await mkdir(bin);
  await mkdir(data, { recursive: true });
  await writeFile(
    path.join(data, 'auth.json'),
    JSON.stringify({ opencode: { type: 'api', key: 'saved-zen-fixture-key' } }),
  );
  await writeClaudeFixture(
    bin,
    `#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2);
if(args.includes('plugin')&&args.includes('list')){console.log('[]');process.exit(0)}
if(args[0]==='--version'){console.log(process.env.TEST_CLAUDE_VERSION??'2.1.272');process.exit(0)}
const result=(value)=>{const base=process.env.MULTI_MOD_GATEWAY_URL;if(!base){console.log(value);return}const url=new URL(base+'/multi/mod/session');const req=require('node:http').request(url,{method:'POST',headers:{'content-type':'application/json','x-multi-gateway-token':process.env.MULTI_GATEWAY_TOKEN}},()=>console.log(value));req.on('error',()=>console.log(value));req.end(JSON.stringify({sessionId:'fixture',event:'start'}));};
if(args[0]==='auth'){process.stdout.write(JSON.stringify({loggedIn:false}));process.exitCode=1}else{
const settings=JSON.parse(fs.readFileSync(args[args.indexOf('--settings')+1],'utf8'));
result(JSON.stringify({settings,models:args.filter(x=>x.startsWith('multi/')),zenKeyInChild:process.env.OPENCODE_API_KEY}));}
`,
  );
  const launcher = fileURLToPath(
    new URL('../../plugins/multi-core/src/launcher.ts', import.meta.url),
  );
  const { stdout } = await promisify(execFile)(process.execPath, [launcher], {
    cwd,
    timeout: 20000,
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      HOME: cwd,
      ...windowsHome(cwd),
      XDG_DATA_HOME: path.join(cwd, 'data'),
      CLAUDE_CONFIG_DIR: path.join(cwd, 'claude'),
      CODEX_HOME: cwd,
      MULTI_ZEN_MODELS: 'mimo-v2.5-free,big-pickle',
    },
  });
  const result = JSON.parse(stdout);
  assert.deepEqual(result.models, ['multi/zen/mimo-v2.5-free']);
  assert.equal(result.zenKeyInChild, undefined);
  assert.deepEqual(
    result.settings.modelPicker.options.map((option: { model: string }) => option.model),
    ['multi/zen/mimo-v2.5-free', 'multi/zen/big-pickle'],
  );
});

test('Antigravity launcher groups picker families, keeps workers and enables function hooks', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'launcher-agy-picker-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const bin = path.join(cwd, 'bin');
  await mkdir(bin);
  if (process.platform === 'win32') {
    await writeFile(
      path.join(bin, 'agy-fixture.js'),
      `if(process.argv[2] !== 'models') process.exit(9);
const rows=[['gemini-low','Gemini Low'],['gemini-medium','Gemini Medium'],['gemini-high','Gemini High'],['sonnet-thinking','Sonnet Thinking']];
console.log(rows.map(row=>row.join(String.fromCharCode(9))).join(String.fromCharCode(10)));
`,
    );
    await writeFile(
      path.join(bin, 'agy.cmd'),
      // npm's global shim layout, so the launcher runs the fixture through Node directly.
      `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\agy-fixture.js" %*\r\n`,
    );
  } else {
    await writeFile(
      path.join(bin, 'agy'),
      `#!/usr/bin/env node
if(process.argv[2] !== 'models') process.exit(9);
const rows=[['gemini-low','Gemini Low'],['gemini-medium','Gemini Medium'],['gemini-high','Gemini High'],['sonnet-thinking','Sonnet Thinking']];
console.log(rows.map(row=>row.join(String.fromCharCode(9))).join(String.fromCharCode(10)));
`,
      { mode: 0o755 },
    );
  }
  await writeClaudeFixture(
    bin,
    `#!/usr/bin/env node
const fs=require('node:fs'); const {execFileSync}=require('node:child_process'); const args=process.argv.slice(2);
if(args.includes('plugin')&&args.includes('list')){console.log(process.env.TEST_PLUGIN==='enabled'?JSON.stringify([{id:'multi-core@cc-multi-cli-plugin',enabled:true,installPath:process.cwd()}]):'[]');process.exit(0)}
if(args[0]==='--version'){console.log(process.env.TEST_CLAUDE_VERSION??'2.1.272');process.exit(0)}
const result=(value)=>{const base=process.env.MULTI_MOD_GATEWAY_URL;if(!base){console.log(value);return}const url=new URL(base+'/multi/mod/session');const req=require('node:http').request(url,{method:'POST',headers:{'content-type':'application/json','x-multi-gateway-token':process.env.MULTI_GATEWAY_TOKEN}},()=>console.log(value));req.on('error',()=>console.log(value));req.end(JSON.stringify({sessionId:'fixture',event:'start'}));};
if(args[0]==='auth'){console.log('{"loggedIn":false}');process.exit(1)}
if(args.includes('plugin')){console.log('[]');process.exit(0)}
const settings=JSON.parse(fs.readFileSync(args[args.indexOf('--settings')+1],'utf8'));
const agents=JSON.parse(args[args.indexOf('--agents')+1]);
if(process.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS !== '1') throw new Error('function hooks missing');
result(JSON.stringify({settings,agents}));
`,
  );
  const launcher = fileURLToPath(
    new URL('../../plugins/multi-core/src/launcher.ts', import.meta.url),
  );
  const custom = {
    model: 'custom/model',
    label: 'Keep me',
    description: 'Unchanged',
    behavesAs: 'claude-opus-4-6',
  };
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      launcher,
      '--settings',
      JSON.stringify({ modelPicker: { options: [custom] }, hooks: { Stop: [] } }),
    ],
    {
      cwd,
      timeout: 20000,
      env: {
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        HOME: cwd,
        ...windowsHome(cwd),
        CLAUDE_CONFIG_DIR: path.join(cwd, 'claude'),
        CODEX_HOME: cwd,
        MULTI_ANTIGRAVITY: '1',
      },
    },
  );
  const { settings, agents } = JSON.parse(stdout);
  const rows: { model: string; behavesAs: string }[] = settings.modelPicker.options;
  assert.deepEqual(
    rows.map(({ model }) => model),
    ['multi/antigravity/gemini', 'multi/antigravity/sonnet-thinking', custom.model],
  );
  assert.equal(rows[0].behavesAs, 'claude-sonnet-4-6');
  assert.deepEqual(rows[2], custom);
  assert.deepEqual(settings.hooks.Stop, []);
  for (const effort of ['low', 'medium', 'high']) {
    assert.equal(agents[`antigravity-gemini-${effort}`].effort, effort);
    assert.equal(
      agents[`antigravity-gemini-${effort}`].model,
      `multi/antigravity/gemini-${effort}`,
    );
  }
  assert.equal(agents['antigravity-gemini'].model, rows[0].model);
  const catalog = new AgentCatalog(
    agents,
    rows.map(({ model }) => model),
  );
  const listing = Object.entries(agents)
    .map(([name, value]) => {
      const worker = value as { description: string; tools: string[] };
      return `- ${name}: ${worker.description} (Tools: ${worker.tools.join(', ')})`;
    })
    .join('\n');
  const compacted = JSON.stringify(
    catalog.compact({
      messages: [
        {
          role: 'user',
          content: `<system-reminder>\nAvailable agent types for the Agent tool:\n${listing}\n</system-reminder>`,
        },
      ],
    }),
  );
  assert.match(compacted, /- antigravity-gemini:/);
  assert.match(compacted, /- antigravity-sonnet-thinking:/);
  assert.doesNotMatch(compacted, /antigravity-gemini-(low|medium|high):/);
});

test('launcher registers only Cursor picker workers and keeps the representative catalog under 30 KB', () => {
  const cursor = cursorModelOptions(
    ['default', 'grok-4.6', 'composer-2.5', 'catalog-only'].map((id) => ({
      id,
      displayName: id,
      variants: [{ displayName: 'Default', isDefault: true, params: [] }],
    })),
  );
  const picker = cursorPickerOptions(cursor);
  const antigravity = [
    'gemini',
    'claude',
    'gpt',
    'sonnet',
    'opus',
    'flash',
    'thinking',
    'gemini-low',
    'gemini-medium',
    'gemini-high',
  ].map((id) => ({
    id,
    model: `multi/antigravity/${id}`,
    label: `Antigravity · ${id}`,
    worker: `antigravity-${id}`,
  }));
  const agents = workerDefinitions(true, picker, true, antigravity);
  const definitions = JSON.stringify(agents);
  const definitionBytes = Buffer.byteLength(definitions);
  assert.equal(Object.keys(agents).filter((name) => name.startsWith('cursor-')).length, 3);
  assert(!Object.keys(agents).some((name) => name.includes('catalog-only')));
  assert(definitionBytes < 30000, `representative worker JSON was ${definitionBytes} bytes`);
  assert.equal(ZEN_MODELS.length, 19);
});

test('launcher argument limits are platform-aware and identify largest providers', () => {
  const agents = {
    'openai-worker': {
      model: 'multi/openai/model',
      description: 'OpenAI',
      prompt: 'Complete the delegated task.',
      tools: ['Read'],
    },
    'cursor-worker': {
      model: 'multi/cursor/model',
      description: 'Cursor',
      prompt: 'Complete the delegated task.',
      tools: ['Read'],
    },
  };
  const invocation = {
    command: 'claude',
    args: ['--settings', 'settings.json', '--agents', 'x'.repeat(32000)],
  };
  assert.throws(
    () => checkLauncherArgumentLimit(agents, invocation, 'claude.exe', 'win32'),
    /above the Windows limit of 32,000.*openai.*Disable providers or extra models/,
  );
  assert.doesNotThrow(() =>
    checkLauncherArgumentLimit(
      agents,
      { command: 'cmd.exe', args: ['/c', 'claude.cmd', 'x'.repeat(7900)] },
      'C:\\bin\\claude.cmd',
      'win32',
    ),
  );
  assert.throws(
    () =>
      checkLauncherArgumentLimit(
        agents,
        { command: 'cmd.exe', args: ['/c', 'claude.cmd', 'x'.repeat(8000)] },
        'C:\\bin\\claude.cmd',
        'win32',
      ),
    /Windows cmd.exe shim limit of 8,000/,
  );
});

test('the Zen model listing is available without authentication', async () => {
  const launcher = fileURLToPath(
    new URL('../../plugins/multi-core/src/launcher.ts', import.meta.url),
  );
  const { stdout } = await promisify(execFile)(process.execPath, [launcher, '--zen-models'], {
    timeout: 20000,
    env: {
      PATH: process.env.PATH,
      HOME: os.tmpdir(),
      XDG_DATA_HOME: path.join(os.tmpdir(), 'missing-zen-data'),
    },
  });
  const models = JSON.parse(stdout);
  assert(models.some((model: { id: string }) => model.id === 'big-pickle'));
});
