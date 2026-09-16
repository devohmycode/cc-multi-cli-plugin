// Loaded through NODE_OPTIONS=--import in CI. If a test process is still alive
// after the deadline, print what keeps it alive and write a diagnostic report so
// a hung test leaves evidence instead of a bare per-test timeout.
const deadlineMs = Number(process.env.MULTI_TEST_WATCHDOG_MS ?? 100_000);

const timer = setTimeout(() => {
  const handles = (
    process as unknown as { _getActiveHandles?: () => unknown[] }
  )._getActiveHandles?.();
  const summary = {
    pid: process.pid,
    argv: process.argv.slice(1),
    resources: process.getActiveResourcesInfo(),
    handles: handles?.map((handle) => handle?.constructor?.name ?? typeof handle),
  };
  process.stderr.write(
    `[watchdog] still running after ${deadlineMs} ms ${JSON.stringify(summary)}\n`,
  );
  process.report?.writeReport();
}, deadlineMs);
timer.unref();
