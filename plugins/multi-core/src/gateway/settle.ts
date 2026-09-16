/** Grace period for a cancelled native operation to report its own outcome. */
export const abortGraceMs = 5000;

/**
 * Wait for a native operation without an overall deadline. Native runs may
 * take minutes; only a cancelled run is bounded. Once `signal` aborts, the
 * operation has `graceMs` to settle on its own before this rejects explicitly.
 */
export function settleOrAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  description: string,
  graceMs = abortGraceMs,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      settle();
    };
    const onAbort = () => {
      timer = setTimeout(() => {
        finish(() =>
          reject(new Error(`${description} did not settle within ${graceMs} ms of cancellation`)),
        );
      }, graceMs);
    };
    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
