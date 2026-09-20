import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { atomicWriteFile } from '../../plugins/multi-core/src/gateway/atomic-write.ts';
import { removeTemporary } from '../temporary.ts';

test('atomicWriteFile replaces files on Unix and retries Windows sharing errors', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'atomic-write-'));
  t.after(() => removeTemporary(directory));
  const file = path.join(directory, 'state.json');
  await writeFile(file, 'old');
  await atomicWriteFile(file, 'new', { platform: 'linux' });
  assert.equal(await readFile(file, 'utf8'), 'new');
});

test('retries a transient Windows rename sharing violation', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'atomic-write-win-'));
  t.after(() => removeTemporary(directory));
  const file = path.join(directory, 'state.json');
  let failures = 1;
  await atomicWriteFile(file, 'new', {
    platform: 'win32',
    rename: async (temporary, target) => {
      if (failures > 0) {
        failures -= 1;
        const error = new Error('sharing violation') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      const { rename } = await import('node:fs/promises');
      await rename(temporary, target);
    },
  });
  assert.equal(failures, 0);
  assert.equal(await readFile(file, 'utf8'), 'new');
});

test('rejects an unbounded retry configuration', async () => {
  await assert.rejects(
    atomicWriteFile(path.join(os.tmpdir(), 'unused-atomic-write-test'), 'data', {
      retries: Infinity,
    }),
    /retries must be a non-negative integer/,
  );
});
