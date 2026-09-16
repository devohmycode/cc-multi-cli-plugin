import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';

export async function atomicWriteFile(
  file: string,
  data: string | Uint8Array,
  options: {
    mode?: number;
    platform?: NodeJS.Platform;
    retries?: number;
    rename?: typeof rename;
    rm?: typeof rm;
  } = {},
): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const retries = options.retries ?? 5;
  if (!Number.isSafeInteger(retries) || retries < 0) {
    throw new RangeError('Atomic write retries must be a non-negative integer');
  }
  await writeFile(temporary, data, { mode: options.mode });
  const attempts = options.platform === 'win32' ? retries : 0;
  const renameFile = options.rename ?? rename;
  const removeFile = options.rm ?? rm;
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await renameFile(temporary, file);
        return;
      } catch (error) {
        const retryable = isWindowsRenameRetryable(error, options.platform);
        if (!retryable || attempt >= attempts) {
          throw error;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
    }
  } finally {
    await removeFile(temporary, { force: true }).catch(() => {});
  }
}

function isWindowsRenameRetryable(error: unknown, platform: NodeJS.Platform | undefined) {
  return (
    platform === 'win32' &&
    error instanceof Error &&
    'code' in error &&
    (error.code === 'EPERM' || error.code === 'EBUSY')
  );
}
