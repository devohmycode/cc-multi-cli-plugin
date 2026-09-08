// terminateProcessTree POSIX path: a failed group kill (ESRCH — child not a
// group leader, i.e. spawned without `detached`) must fall back to a direct
// kill of the pid. Regression test for the Linux hang where non-detached ACP
// children were never reaped.

import assert from 'node:assert/strict';
import test from 'node:test';

import { terminateProcessTree } from '../../plugins/multi/src/transports/process.mjs';

function esrch() {
  const err = new Error('ESRCH');
  err.code = 'ESRCH';
  return err;
}

test('group kill ESRCH → falls back to direct pid kill (delivered)', () => {
  const calls = [];
  const r = terminateProcessTree(1234, {
    platform: 'linux',
    killImpl: (pid) => {
      calls.push(pid);
      if (pid < 0) {
        throw esrch();
      }
    },
  });
  assert.deepEqual(calls, [-1234, 1234]);
  assert.deepEqual(r, { attempted: true, delivered: true, method: 'process' });
});

test('group kill ESRCH and pid ESRCH → delivered false (process gone)', () => {
  const r = terminateProcessTree(1234, {
    platform: 'linux',
    killImpl: () => {
      throw esrch();
    },
  });
  assert.deepEqual(r, { attempted: true, delivered: false, method: 'process' });
});

test('group kill success → no fallback', () => {
  const calls = [];
  const r = terminateProcessTree(1234, {
    platform: 'linux',
    killImpl: (pid) => calls.push(pid),
  });
  assert.deepEqual(calls, [-1234]);
  assert.deepEqual(r, { attempted: true, delivered: true, method: 'process-group' });
});

test('Windows tree kill preserves taskkill outcomes and only falls back when unavailable', () => {
  for (const status of [0, 128]) {
    const result = { status, stderr: 'No running instance', stdout: '', error: null };
    const actual = terminateProcessTree(1234, {
      platform: 'win32',
      runCommandImpl(command, args) {
        assert.equal(command, 'taskkill');
        assert.deepEqual(args, ['/PID', '1234', '/T', '/F']);
        return result;
      },
      killImpl: () => assert.fail('taskkill was available'),
    });
    assert.deepEqual(actual, {
      attempted: true,
      delivered: status === 0,
      method: 'taskkill',
      result,
    });
  }
  const calls = [];
  const missingTaskkill = () => ({ error: { code: 'ENOENT' } });
  assert.deepEqual(
    terminateProcessTree(1234, {
      platform: 'win32',
      runCommandImpl: missingTaskkill,
      killImpl: (pid) => calls.push(pid),
    }),
    { attempted: true, delivered: true, method: 'kill' },
  );
  assert.deepEqual(calls, [1234]);
  assert.deepEqual(
    terminateProcessTree(1234, {
      platform: 'win32',
      runCommandImpl: missingTaskkill,
      killImpl: () => {
        throw esrch();
      },
    }),
    { attempted: true, delivered: false, method: 'kill' },
  );
  const denied = Object.assign(new Error('Access denied'), { code: 'EACCES' });
  assert.throws(
    () =>
      terminateProcessTree(1234, {
        platform: 'win32',
        runCommandImpl: () => ({ error: denied }),
        killImpl: () => assert.fail('Access errors must not fall back'),
      }),
    (error) => error === denied,
  );
});
