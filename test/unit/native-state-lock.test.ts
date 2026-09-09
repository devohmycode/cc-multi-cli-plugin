import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { lockStateFile } from '../../plugins/multi-core/src/gateway/state-lock.ts';

test('kernel lock excludes concurrent owners and releases after a gateway crash', {
  timeout: 10000,
}, async (t) => {
  const directory = await mkdtemp('/tmp/cursor-lock-test-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'session.lock');
  const module = new URL('../../plugins/multi-core/src/gateway/state-lock.ts', import.meta.url);
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {lockStateFile} from ${JSON.stringify(module.href)};const release=await lockStateFile(process.argv[1]);process.stdout.write('ready');process.stdin.on('end',release);process.stdin.resume();`,
      file,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  t.after(() => {
    child.kill('SIGKILL');
  });
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
  await new Promise<void>((resolve, reject) => {
    child.stdout.once('data', () => resolve());
    child.once('error', reject);
    child.once('close', () => reject(new Error('Lock owner exited before acquisition')));
  });
  await assert.rejects(lockStateFile(file), /locked/);
  child.kill('SIGKILL');
  await exited;
  let release: (() => Promise<void>) | undefined;
  for (let attempt = 0; attempt < 50 && !release; attempt++) {
    try {
      release = await lockStateFile(file);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assert(release, 'Dead gateway must release kernel ownership without deleting state files');
  await release();
});

test('legacy directory locks remain explicit recovery evidence', async (t) => {
  const directory = await mkdtemp('/tmp/cursor-legacy-lock-test-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'session.lock');
  await mkdir(file);
  await assert.rejects(lockStateFile(file), /legacy interrupted lock/);
});

test('parent descriptor keeps ownership after flock exits and failed acquisition releases its descriptor', async (t) => {
  const directory = await mkdtemp('/tmp/cursor-fd-lock-test-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'session.lock');
  const release = await lockStateFile(file);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const descriptors = (await readdir('/proc/self/fd')).length;
  await assert.rejects(lockStateFile(file), /locked/);
  assert.equal((await readdir('/proc/self/fd')).length, descriptors);
  await release();
  const nextRelease = await lockStateFile(file);
  await nextRelease();
});

test('missing flock fails explicitly and closes the opened descriptor', async (t) => {
  const directory = await mkdtemp('/tmp/cursor-no-flock-test-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const previous = process.env.PATH;
  const descriptors = (await readdir('/proc/self/fd')).length;
  process.env.PATH = directory;
  try {
    await assert.rejects(lockStateFile(path.join(directory, 'session.lock')), /ENOENT/);
    assert.equal((await readdir('/proc/self/fd')).length, descriptors);
  } finally {
    if (previous === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previous;
    }
  }
});
