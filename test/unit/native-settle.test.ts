import assert from 'node:assert/strict';
import test from 'node:test';
import { settleOrAbort } from '../../plugins/multi-core/src/gateway/settle.ts';

test('a running operation has no deadline until its signal aborts', async () => {
  const controller = new AbortController();
  let resolveRun: (value: string) => void = () => {};
  const run = new Promise<string>((resolve) => {
    resolveRun = resolve;
  });
  const settled = settleOrAbort(run, controller.signal, 'run', 10);
  await new Promise((resolve) => setTimeout(resolve, 40));
  resolveRun('done');
  assert.equal(await settled, 'done');
});

test('a cancelled operation that never settles fails explicitly after the grace period', async () => {
  const controller = new AbortController();
  const never = new Promise<string>(() => {});
  const settled = settleOrAbort(never, controller.signal, 'run', 10);
  controller.abort();
  await assert.rejects(settled, /run did not settle within 10 ms of cancellation/);
});

test('a cancelled operation that settles in time keeps its own outcome', async () => {
  const controller = new AbortController();
  controller.abort();
  const failure = new Error('aborted by the run');
  await assert.rejects(
    settleOrAbort(Promise.reject(failure), controller.signal, 'run', 50),
    failure,
  );
});
