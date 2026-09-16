import assert from 'node:assert/strict';
import test from 'node:test';
import { run } from '../../plugins/multi-core/src/install/process.ts';

// Exit 0 when PATH reaches the child, 3 when the environment arrived empty.
const probe = ['-e', 'process.exit(process.env.PATH ? 0 : 3)'];

test('run inherits the parent environment when no options are supplied', async () => {
  // Issue #18: an empty options object was read as an empty env map, so
  // `multi login openai` spawned `codex` without PATH and failed with ENOENT.
  assert.equal(await run(process.execPath, probe), 0);
});

test('run passes an explicit environment through to the child', async () => {
  const marker = ['-e', "process.exit(process.env.MULTI_RUN_PROBE === 'yes' ? 0 : 3)"];
  assert.equal(
    await run(process.execPath, marker, { env: { ...process.env, MULTI_RUN_PROBE: 'yes' } }),
    0,
  );
  assert.equal(await run(process.execPath, marker), 3);
});

test('run resolves a bare command name through PATH', async () => {
  assert.equal(await run('node', probe), 0);
});
