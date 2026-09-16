import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';

export async function atomicWriteFile(
  file: string,
  data: string | Uint8Array,
  options: { mode?: number; platform?: NodeJS.Platform; retries?: number } = {},
): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, data, { mode: options.mode });
  const attempts = options.platform === 'win32' ? (options.retries ?? 5) : 0;
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temporary, file);
        return;
      } catch (error) {
        const retryable =
          options.platform === 'win32' &&
          error instanceof Error &&
          'code' in error &&
          (error.code === 'EPERM' || error.code === 'EBUSY');
        if (!retryable || attempt >= attempts) {
          throw error;
        }
      }
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}
