import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installAntigravityHook } from '../../plugins/multi/src/providers/antigravity/hooks.ts';

async function fixture(t: test.TestContext, value: Record<string, unknown>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'antigravity-hooks-'));
  const file = path.join(directory, 'hooks.json');
  await writeFile(file, `${JSON.stringify(value)}\n`);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { file, value };
}

test('Antigravity hook installation preserves non-PreToolUse hooks', async (t) => {
  const original = {
    audit: {
      PermissionRequest: [{ hooks: [{ type: 'command', command: 'record-audit' }] }],
    },
  };
  const { file } = await fixture(t, original);
  await installAntigravityHook(file);
  const installed = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(installed.audit, original.audit);
  assert(installed['multi-cli-antigravity']);
});

test('Antigravity hook installation rejects an active conflicting PreToolUse hook', async (t) => {
  const original = {
    other: {
      PreToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: 'other' }] }],
    },
  };
  const { file } = await fixture(t, original);
  await assert.rejects(installAntigravityHook(file), /another active PreToolUse hook/);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), original);
});
