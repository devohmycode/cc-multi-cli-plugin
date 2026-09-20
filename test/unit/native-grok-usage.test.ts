import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  formatGrokQuota,
  type GrokAuthStatus,
  grokAuthFile,
  readGrokAuth,
} from '../../plugins/multi-grok/src/usage.ts';

/** Shape recorded from a real `grok login`, credential fields elided. */
const authFile = {
  'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828': {
    key: 'token-value',
    auth_mode: 'oidc',
    email: 'user@example.com',
    refresh_token: 'refresh-value',
    expires_at: '2026-09-27T07:52:00.000000000+00:00',
    oidc_issuer: 'https://auth.x.ai',
  },
};

async function home(t: test.TestContext, contents?: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grok-auth-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  if (contents !== undefined) {
    await mkdir(path.join(directory, '.grok'), { recursive: true });
    await writeFile(path.join(directory, '.grok', 'auth.json'), contents, 'utf8');
  }
  return directory;
}

test('the auth file lives beside the CLI on every platform', () => {
  assert.equal(
    grokAuthFile({ platform: 'win32', homedir: 'C:\\Users\\dev' }),
    'C:\\Users\\dev\\.grok\\auth.json',
  );
  assert.equal(
    grokAuthFile({ platform: 'linux', homedir: '/home/dev' }),
    '/home/dev/.grok/auth.json',
  );
});

test('reads the login state without touching the credential', async (t) => {
  const signed: GrokAuthStatus = await readGrokAuth({
    homedir: await home(t, JSON.stringify(authFile)),
  });
  assert.equal(signed.signedIn, true);
  assert.equal(signed.renewable, true);
  assert.equal(signed.expiresAt, Date.parse('2026-09-27T07:52:00.000Z'));
  assert.deepEqual(Object.keys(signed), ['signedIn', 'renewable', 'expiresAt']);

  assert.deepEqual(await readGrokAuth({ homedir: await home(t) }), { signedIn: false });
  assert.deepEqual(await readGrokAuth({ homedir: await home(t, 'not json') }), { signedIn: false });
  assert.deepEqual(await readGrokAuth({ homedir: await home(t, '{"entry":{"key":""}}') }), {
    signedIn: false,
  });
});

test('the usage row reports what the subscription actually exposes', () => {
  const now = Date.parse('2026-09-20T08:00:00.000Z');
  const signedOut = formatGrokQuota({ signedIn: false }, now);
  assert.equal(signedOut.status, 'unavailable');
  assert.match(signedOut.summary, /No Grok account login/);

  // Measured: the access token lives about six hours and the CLI renews it from
  // its refresh token, so a lapsed clock on a renewable login is not an expiry.
  const renewable = formatGrokQuota(
    { signedIn: true, renewable: true, expiresAt: Date.parse('2026-09-20T02:00:00.000Z') },
    now,
  );
  assert.equal(renewable.summary, 'Signed in');
  assert.equal(renewable.status, undefined);
  assert.match(renewable.details[0], /renews its own access token/);

  const expired = formatGrokQuota(
    { signedIn: true, expiresAt: Date.parse('2026-09-19T08:00:00.000Z') },
    now,
  );
  assert.equal(expired.status, 'unavailable');
  assert.match(expired.details[0], /grok login/);

  const soon = formatGrokQuota(
    { signedIn: true, expiresAt: Date.parse('2026-09-21T14:00:00.000Z') },
    now,
  );
  assert.equal(soon.summary, 'Signed in · access valid 30h');
  assert.equal(soon.status, undefined);

  const later = formatGrokQuota(
    { signedIn: true, expiresAt: Date.parse('2026-09-25T08:00:00.000Z') },
    now,
  );
  assert.equal(later.summary, 'Signed in · access valid 5d');
  // No account quota exists, so the row says so instead of inventing one.
  assert.match(later.details.join(' '), /exposes no account quota/);

  assert.equal(formatGrokQuota({ signedIn: true }, now).summary, 'Signed in');
});
