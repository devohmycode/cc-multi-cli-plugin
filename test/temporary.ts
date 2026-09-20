import { rm } from 'node:fs/promises';

/**
 * Remove a temporary directory a test created.
 *
 * Windows can still hold a handle on a file for a moment after the process that
 * wrote or executed it has exited — an antivirus scan of a newly written
 * executable, or the loader releasing its mapping — and `fs.rm` retries `EBUSY`
 * only when `maxRetries` is set. Without it a teardown fails a run whose tests
 * all passed, pointing at `rmdir` rather than at the cause.
 *
 * The retry budget is the one the live Cursor harness already needed, since an
 * SDK child holds its directory the longest of any test here: twenty attempts
 * with a linear backoff. Nothing waits unless a removal actually fails.
 */
export function removeTemporary(directory: string): Promise<void> {
  return rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
