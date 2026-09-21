import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import test from 'node:test';
import {
  CodexAuthError,
  codexRequest,
  readCodexAuth,
} from '../../plugins/multi-openai/src/auth.ts';
import { removeTemporary } from '../temporary.ts';

const jwt = (exp: number) =>
  `header.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.signature`;
const oldToken = jwt(Math.floor(Date.now() / 1000) + 3600);
const fixtureCLI = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const rl = require('node:readline').createInterface({input:process.stdin});
const root=process.env.CODEX_HOME;
const send=value=>console.log(JSON.stringify(value));
rl.on('line',async line=>{
 const request=JSON.parse(line);
 if(request.method==='initialize')send({id:request.id,result:{}});
 if(request.method!=='account/read')return;
 if(request.params.refreshToken!==true)process.exit(2);
 fs.appendFileSync(path.join(root,'refreshes'),'1\\n');
 const mode=fs.readFileSync(path.join(root,'mode'),'utf8');
 if(mode==='fail'){send({id:request.id,error:{message:'SECRET_REFRESH_TOKEN'}});return;}
 if(mode==='malformed'){console.log('SECRET_INVALID_RPC');return;}
 if(mode==='exit')process.exit(3);
 if(mode==='delay')await new Promise(resolve=>setTimeout(resolve,100));
 const filename=path.join(root,'auth.json');
 const saved=JSON.parse(fs.readFileSync(filename,'utf8'));
 if(mode!=='unchanged')saved.tokens.access_token='renewed-token';
 if(mode==='account-change')saved.tokens.account_id='different-account';
 fs.writeFileSync(filename,JSON.stringify(saved));
 send({id:request.id,result:{account:{type:'chatgpt'}}});
});
`;

async function fixture(t: TestContext, mode = 'ok', accessToken = oldToken) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'openai-auth-test-'));
  const bin = path.join(cwd, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'codex'), fixtureCLI, { mode: 0o755 });
  const authFile = path.join(cwd, 'auth.json');
  await writeFile(
    authFile,
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: accessToken,
        refresh_token: 'fixture-refresh',
        account_id: 'fixture-account',
      },
    }),
  );
  await writeFile(path.join(cwd, 'mode'), mode);
  await writeFile(path.join(cwd, 'refreshes'), '');
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
  t.after(async () => {
    process.env.PATH = originalPath;
    await removeTemporary(cwd);
  });
  return {
    authFile,
    count: async () =>
      (await readFile(path.join(cwd, 'refreshes'), 'utf8')).trim().split('\n').filter(Boolean)
        .length,
  };
}
const signal = () => AbortSignal.timeout(5000);
const unix = { skip: process.platform === 'win32' };

test('expired credentials are renewed through Codex before inference', unix, async (t) => {
  const f = await fixture(t, 'ok', jwt(1));
  const headers = await readCodexAuth(f.authFile);
  assert.equal(headers.authorization, 'Bearer renewed-token');
  assert.equal(headers['chatgpt-account-id'], 'fixture-account');
  assert.equal(await f.count(), 1);
});

test(
  'simultaneous 401 rejections share one renewal and retry once with the same account',
  unix,
  async (t) => {
    const f = await fixture(t, 'delay');
    const calls = [0, 0];
    await Promise.all(
      calls.map((_, index) =>
        codexRequest(f.authFile, signal(), async (headers) => {
          calls[index]++;
          assert.equal(headers['chatgpt-account-id'], 'fixture-account');
          if (calls[index] === 1) {
            return new Response('rejected', { status: 401 });
          }
          assert.equal(headers.authorization, 'Bearer renewed-token');
          return new Response('OK');
        }),
      ),
    );
    assert.deepEqual(calls, [2, 2]);
    assert.equal(await f.count(), 1);
  },
);

test('a late 401 reuses an externally renewed file without rotating it again', unix, async (t) => {
  const f = await fixture(t);
  let calls = 0;
  await codexRequest(f.authFile, signal(), async (headers) => {
    calls++;
    if (calls === 1) {
      const saved = JSON.parse(await readFile(f.authFile, 'utf8'));
      saved.tokens.access_token = 'externally-renewed';
      await writeFile(f.authFile, JSON.stringify(saved));
      return new Response('', { status: 401 });
    }
    assert.equal(headers.authorization, 'Bearer externally-renewed');
    return new Response('OK');
  });
  assert.equal(calls, 2);
  assert.equal(await f.count(), 0);
});

test(
  'a cancelled renewal waiter cannot retry inference or cancel another worker renewal',
  unix,
  async (t) => {
    const f = await fixture(t, 'delay');
    const controller = new AbortController();
    let cancelledCalls = 0;
    const cancelled = codexRequest(f.authFile, controller.signal, async () => {
      cancelledCalls++;
      setTimeout(() => controller.abort(new Error('cancelled')), 15);
      return new Response('', { status: 401 });
    });
    const rejected = assert.rejects(cancelled, /cancelled/);
    let activeCalls = 0;
    const active = codexRequest(f.authFile, signal(), async () => {
      activeCalls++;
      return new Response('', { status: activeCalls === 1 ? 401 : 200 });
    });
    await Promise.all([rejected, active]);
    assert.equal(cancelledCalls, 1);
    assert.equal(activeCalls, 2);
    assert.equal(await f.count(), 1);
  },
);

test(
  'refresh failures, malformed RPC, unchanged tokens and account switches never retry inference',
  unix,
  async (t) => {
    for (const mode of ['fail', 'malformed', 'exit', 'unchanged', 'account-change']) {
      await t.test(mode, async (sub) => {
        const f = await fixture(sub, mode);
        let calls = 0;
        await assert.rejects(
          codexRequest(f.authFile, signal(), async () => {
            calls++;
            return new Response('', { status: 401 });
          }),
          (error: unknown) => {
            assert(error instanceof CodexAuthError);
            assert(!error.message.includes('SECRET'));
            return true;
          },
        );
        assert.equal(calls, 1);
        assert.equal(await f.count(), 1);
      });
    }
  },
);

test('a second 401 is returned without a renewal or inference retry loop', unix, async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const response = await codexRequest(f.authFile, signal(), async () => {
    calls++;
    return new Response('', { status: 401 });
  });
  assert.equal(response.status, 401);
  assert.equal(calls, 2);
  assert.equal(await f.count(), 1);
});

test(
  'other HTTP failures, network errors and accepted streams never trigger renewal or replay',
  unix,
  async (t) => {
    const f = await fixture(t);
    for (const status of [200, 400, 403, 429, 503]) {
      let calls = 0;
      const response = await codexRequest(f.authFile, signal(), async () => {
        calls++;
        return new Response('data: {"type":"response.failed"}\n\n', { status });
      });
      assert.equal(response.status, status);
      assert.equal(calls, 1);
      await response.body?.cancel();
    }
    await assert.rejects(
      codexRequest(f.authFile, signal(), async () => {
        throw new Error('network');
      }),
      /network/,
    );
    assert.equal(await f.count(), 0);
  },
);
