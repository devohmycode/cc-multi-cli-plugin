// Real launcher + Claude, isolated credentials and local model fixtures only.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { isolatedEnvironment } from './environment.ts';

const run = promisify(execFile);
const root = await mkdtemp(path.join(os.tmpdir(), 'multi-session-lifecycle-'));
const launcher = fileURLToPath(
  new URL('../../plugins/multi-core/src/launcher.ts', import.meta.url),
);
const realClaude = process.env.MULTI_REAL_CLAUDE || 'claude';
await mkdir(path.join(root, 'config'));
await writeFile(
  path.join(root, 'config', '.claude.json'),
  JSON.stringify({ hasCompletedOnboarding: true }),
);
await writeFile(
  path.join(root, 'auth.json'),
  JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { access_token: 'fixture', account_id: 'fixture' },
  }),
);
const wrapper = path.join(root, 'claude.mjs');
await writeFile(
  wrapper,
  `#!${process.execPath}
import {spawnSync} from 'node:child_process';
import {appendFileSync,readFileSync} from 'node:fs';
const args=process.argv.slice(2);
if(args[0]==='auth'){console.log(JSON.stringify({loggedIn:true}));}
else {
 const settingsPath=args[args.indexOf('--settings')+1];
 appendFileSync(${JSON.stringify(path.join(root, 'launches.jsonl'))},JSON.stringify({settingsPath,settings:JSON.parse(readFileSync(settingsPath,'utf8')),agents:JSON.parse(args[args.indexOf('--agents')+1]),agentView:process.env.CLAUDE_CODE_DISABLE_AGENT_VIEW})+'\\n');
 const result=spawnSync(${JSON.stringify(realClaude)},args,{stdio:'inherit'});process.exit(result.status??1);
}
`,
  { mode: 0o755 },
);
const fixture = path.join(root, 'provider.mjs');
await writeFile(
  fixture,
  `import {appendFileSync} from 'node:fs';
const original=globalThis.fetch;
globalThis.fetch=async(url,init)=>{
 const target=new URL(url);
 if(target.hostname==='127.0.0.1')return original(url,init);
 if(target.hostname!=='api.anthropic.com')throw new Error('Fixture blocks external traffic');
 const body=JSON.parse(String(init.body));
 appendFileSync(${JSON.stringify(path.join(root, 'requests.jsonl'))},JSON.stringify(body)+'\\n');
 const message={id:'msg_fixture',type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:3}};
 const events=[{type:'message_start',message},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'RESUME_OK'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:3}},{type:'message_stop'}];
 return new Response(events.map(e=>'event: '+e.type+'\\ndata: '+JSON.stringify(e)+'\\n\\n').join(''),{headers:{'content-type':'text/event-stream'}});
};`,
);
const env = isolatedEnvironment({
  HOME: root,
  CODEX_HOME: root,
  CLAUDE_CONFIG_DIR: path.join(root, 'config'),
  MULTI_REAL_CLAUDE: wrapper,
  MULTI_ENABLED_PROVIDERS: 'openai',
  ANTHROPIC_AUTH_TOKEN: 'fixture',
  NODE_OPTIONS: `--import=${fixture}`,
});
async function launch(session?: string) {
  const { stdout, stderr } = await run(
    process.execPath,
    [
      launcher,
      '--',
      '-p',
      'Reply RESUME_OK',
      '--model',
      'claude-sonnet-5',
      '--permission-mode',
      'bypassPermissions',
      '--tools',
      '',
      '--setting-sources',
      '',
      '--strict-mcp-config',
      '--output-format',
      'json',
      ...(session ? ['--resume', session] : []),
    ],
    { cwd: root, env, timeout: 30000 },
  );
  assert.doesNotMatch(stdout + stderr, /DEP0190|Multi permission sync failed/);
  const result = JSON.parse(stdout);
  assert.equal(result.is_error, false);
  assert.equal(result.result, 'RESUME_OK');
  return String(result.session_id);
}
const session = await launch();
assert.equal(await launch(session), session);
const launches = (await readFile(path.join(root, 'launches.jsonl'), 'utf8'))
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));
assert.equal(launches.length, 2);
assert.notEqual(launches[0].settingsPath, launches[1].settingsPath);
for (const entry of launches) {
  assert.equal(entry.settings.disableAgentView, true);
  assert.equal(entry.agentView, '1');
  assert(Object.hasOwn(entry.agents, 'openai-luna'));
  await assert.rejects(readFile(entry.settingsPath), { code: 'ENOENT' });
}
const requests = (await readFile(path.join(root, 'requests.jsonl'), 'utf8'))
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));
assert(
  requests.some((body) =>
    body.messages.some(
      (message: { role: string; content: unknown }) =>
        message.role === 'assistant' && JSON.stringify(message.content).includes('RESUME_OK'),
    ),
  ),
);
for (const option of ['--bg', '--background', 'attach', 'respawn']) {
  await assert.rejects(
    run(process.execPath, [launcher, '--', option], { cwd: root, env, timeout: 30000 }),
    /Multi sessions must stay attached/,
  );
}
console.log(
  `PASS: saved resume, fresh gateway settings, worker catalog and background admission. Artifacts: ${root}`,
);
