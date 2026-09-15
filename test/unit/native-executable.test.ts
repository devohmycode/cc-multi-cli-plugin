import assert from 'node:assert/strict';
import test from 'node:test';
import {
  executableInvocation,
  resolveExecutable,
} from '../../plugins/multi-core/src/gateway/executable.ts';

test('resolves Windows npm shims using PATHEXT order', () => {
  const seen: string[] = [];
  const executable = resolveExecutable('agy', {
    platform: 'win32',
    env: { PATH: 'C:\\tools;C:\\other', PATHEXT: '.EXE;.CMD' },
    exists: (filename) => {
      seen.push(filename);
      return filename === 'C:\\other\\agy.cmd';
    },
  });
  assert.equal(executable, 'C:\\other\\agy.cmd');
  assert.deepEqual(seen, [
    'C:\\tools\\agy.exe',
    'C:\\tools\\agy.cmd',
    'C:\\tools\\agy',
    'C:\\other\\agy.exe',
    'C:\\other\\agy.cmd',
  ]);
});

test('honors explicit executable paths and fails clearly when absent', () => {
  assert.equal(
    resolveExecutable('claude', {
      platform: 'win32',
      configuredPath: 'D:\\Apps\\claude.exe',
      exists: (filename) => filename.endsWith('claude.exe'),
    }),
    'D:\\Apps\\claude.exe',
  );
  assert.throws(
    () => resolveExecutable('claude', { env: { PATH: '' }, exists: () => false }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'ENOENT' &&
      /Executable not found on PATH: claude/.test(error.message),
  );
});

test('invokes cmd shims through ComSpec without shell mode', () => {
  assert.deepEqual(
    executableInvocation('C:\\Program Files\\agy.cmd', ['--prompt', 'hello world'], 'win32', {
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    }),
    {
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', '"C:\\Program Files\\agy.cmd" --prompt "hello world"'],
    },
  );
});
