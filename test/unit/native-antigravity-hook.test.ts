import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

interface HookResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const hook = fileURLToPath(
  new URL('../../plugins/multi-antigravity/src/permission-hook.ts', import.meta.url),
);

function runHook(input: string, policy?: string): HookResult {
  const environment = { ...process.env };
  if (policy === undefined) {
    delete environment.MULTI_ANTIGRAVITY_DENY;
  } else {
    environment.MULTI_ANTIGRAVITY_DENY = policy;
  }
  const child = spawnSync(process.execPath, [hook], {
    input,
    encoding: 'utf8',
    env: environment,
  });
  return {
    code: child.status,
    stdout: child.stdout,
    stderr: child.stderr,
  };
}

test('native Antigravity hook emits no stdout when no gateway policy is present', async () => {
  const result = runHook(JSON.stringify({ toolCall: { name: 'run_command', args: {} } }));
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('native Antigravity hook denies excluded and malformed calls', async () => {
  const excluded = runHook(
    JSON.stringify({ toolCall: { name: 'run_command', args: {} } }),
    JSON.stringify(['run_command']),
  );
  assert.equal(excluded.code, 0);
  assert.ok(excluded.stdout, JSON.stringify(excluded));
  assert.deepEqual(JSON.parse(excluded.stdout), {
    decision: 'deny',
    reason: 'Claude session policy excludes this native Antigravity tool.',
  });

  const notExcluded = runHook(
    JSON.stringify({ toolCall: { name: 'view_file', args: {} } }),
    JSON.stringify(['run_command']),
  );
  assert.equal(notExcluded.code, 0);
  assert.equal(notExcluded.stdout, '');

  const malformedPayload = runHook('{malformed}', JSON.stringify(['run_command']));
  assert.equal(malformedPayload.code, 0);
  assert.deepEqual(JSON.parse(malformedPayload.stdout), {
    decision: 'deny',
    reason: 'Antigravity permission hook failed.',
  });

  const malformedPolicy = runHook(
    JSON.stringify({ toolCall: { name: 'view_file', args: {} } }),
    'not-json',
  );
  assert.equal(malformedPolicy.code, 0);
  assert.deepEqual(JSON.parse(malformedPolicy.stdout), {
    decision: 'deny',
    reason: 'Antigravity gateway permission context is invalid.',
  });
});
