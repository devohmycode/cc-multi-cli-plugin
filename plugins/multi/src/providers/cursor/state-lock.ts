import { spawn } from 'node:child_process';
import { lstat, open } from 'node:fs/promises';

/** Linux flock belongs to the shared open-file description, retained by this process. */
export async function lockCursorSession(file: string): Promise<() => Promise<void>> {
  if (process.platform !== 'linux') {
    throw new Error('Native Cursor session locking currently requires Linux flock');
  }
  const info = await lstat(file).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  });
  if (info?.isDirectory()) {
    throw new Error(
      'Cursor session has a legacy interrupted lock; preserve it for manual recovery',
    );
  }
  const descriptor = await open(file, 'a', 0o600);
  const child = spawn('flock', ['--exclusive', '--nonblock', '3'], {
    // fd 3 duplicates our open description. The lock survives flock's exit until
    // this FileHandle closes; there is no helper process whose death loses ownership.
    stdio: ['ignore', 'ignore', 'ignore', descriptor.fd],
  });
  const exited = new Promise<void>((resolve) => {
    child.once('error', () => resolve());
    child.once('close', () => resolve());
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Cursor session lock acquisition timed out'));
      }, 5000);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve();
        } else {
          reject(new Error('Cursor session is locked by another gateway or flock is unavailable'));
        }
      });
    });
  } catch (error) {
    child.kill('SIGKILL');
    await exited;
    await descriptor.close();
    throw error;
  }
  return () => descriptor.close();
}
