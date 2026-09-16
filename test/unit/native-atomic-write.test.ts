import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { atomicWriteFile } from '../../plugins/multi-core/src/gateway/atomic-write.ts';

test('atomicWriteFile replaces files on Unix and retries Windows sharing errors', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'atomic-write-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'state.json');
  await writeFile(file, 'old');
  await atomicWriteFile(file, 'new', { platform: 'linux' });
  assert.equal(await readFile(file, 'utf8'), 'new');
});
