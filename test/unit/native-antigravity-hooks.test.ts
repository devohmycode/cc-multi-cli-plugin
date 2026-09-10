import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installAntigravityHook } from '../../plugins/multi-antigravity/src/hooks.ts';

interface InstalledPreToolUseHook {
  PreToolUse: Array<{
    matcher: string;
    hooks: Array<{ type: string; command: string; timeout: number }>;
  }>;
}

async function fixture(t: test.TestContext, value: Record<string, unknown>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'antigravity-hooks-'));
  const file = path.join(directory, 'hooks.json');
  await writeFile(file, `${JSON.stringify(value)}\n`);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { file, value };
}

/** The exact shape `definition()` in hooks.ts must produce; a dummy install must fail every line. */
function assertNamespacedHook(installed: Record<string, unknown>) {
  const hook = installed['multi-cli-antigravity'] as InstalledPreToolUseHook;
  assert.equal(hook.PreToolUse.length, 1);
  assert.equal(hook.PreToolUse[0].matcher, '*');
  assert.equal(hook.PreToolUse[0].hooks.length, 1);
  assert.equal(hook.PreToolUse[0].hooks[0].type, 'command');
  assert.equal(hook.PreToolUse[0].hooks[0].timeout, 10);
  assert.match(hook.PreToolUse[0].hooks[0].command, /permission-hook\.ts/);
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
  assertNamespacedHook(installed);
  const mode = (await stat(file)).mode & 0o777;
  assert.equal(mode, 0o600);
  await installAntigravityHook(file);
  const reinstalled = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(reinstalled, installed);
});

test('Antigravity hook installation coexists with another active PreToolUse hook', async (t) => {
  const original = {
    other: {
      PreToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: 'other' }] }],
    },
  };
  const { file } = await fixture(t, original);
  await installAntigravityHook(file);
  const installed = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(installed.other, original.other);
  assertNamespacedHook(installed);
  const mode = (await stat(file)).mode & 0o777;
  assert.equal(mode, 0o600);
  await installAntigravityHook(file);
  const reinstalled = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(reinstalled, installed);
});
