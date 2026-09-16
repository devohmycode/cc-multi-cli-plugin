import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';

export interface LockStateFileOptions {
  platform?: NodeJS.Platform;
  maxAttempts?: number;
  rename?: typeof rename;
  unlink?: typeof unlink;
}

const lockOperationAttempts = 5;

interface LockOwner {
  pid: number;
  hostname: string;
  token: string;
}

/**
 * Acquire a process lock using an exclusive marker file.
 *
 * The marker remains when its process is killed, so the next owner checks the
 * recorded PID and atomically moves a stale marker aside before retrying. A
 * PID can be reused after a process dies; the metadata therefore includes a
 * token for safe release, but cannot completely eliminate that operating
 * system limitation. The lock is intended to serialize native state updates,
 * not to provide a durable lease across PID reuse.
 */
export async function lockStateFile(
  file: string,
  options: LockStateFileOptions = {},
): Promise<() => Promise<void>> {
  const platform = options.platform ?? process.platform;
  const owner: LockOwner = { pid: process.pid, hostname: hostname(), token: randomUUID() };
  const maxAttempts = options.maxAttempts ?? 100;
  const renameFile = options.rename ?? rename;
  const unlinkFile = options.unlink ?? unlink;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError('State file lock maxAttempts must be a positive integer');
  }

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const release = await tryAcquire(file, owner, platform, unlinkFile);
    if (release) {
      return release;
    }
    await takeOverStaleLock(file, platform, renameFile, unlinkFile);
  }
  throw new Error(`State file lock acquisition exceeded ${maxAttempts} attempts`);
}

async function tryAcquire(
  file: string,
  owner: LockOwner,
  platform: NodeJS.Platform,
  unlinkFile: typeof unlink,
): Promise<(() => Promise<void>) | undefined> {
  const descriptor = await openLock(file);
  if (!descriptor) {
    return undefined;
  }
  try {
    await descriptor.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
  } finally {
    await descriptor.close();
  }
  return () => releaseLock(file, owner, platform, unlinkFile);
}

async function openLock(file: string) {
  try {
    return await open(file, 'wx', 0o600);
  } catch (error) {
    if (isCode(error, 'EEXIST')) {
      return undefined;
    }
    if (isCode(error, 'EISDIR')) {
      throw legacyLockError();
    }
    throw error;
  }
}

async function takeOverStaleLock(
  file: string,
  platform: NodeJS.Platform,
  renameFile: typeof rename,
  unlinkFile: typeof unlink,
): Promise<void> {
  const info = await lstat(file).catch((error: unknown) => {
    if (isCode(error, 'ENOENT')) {
      return undefined;
    }
    throw error;
  });
  if (info?.isDirectory()) {
    throw legacyLockError();
  }
  const current = await readOwner(file, platform);
  if (!current) {
    throw new Error('State file is locked by another gateway (owner metadata is unavailable)');
  }
  if (current.hostname !== hostname() || isProcessAlive(current.pid)) {
    throw new Error('State file is locked by another gateway');
  }
  const stale = `${file}.stale-${randomUUID()}`;
  try {
    await retryLockOperation(() => renameFile(file, stale), platform, 'stale-lock takeover');
  } catch (error) {
    if (isCode(error, 'ENOENT')) {
      return;
    }
    throw new Error('State file lock owner exited but stale-lock takeover failed', {
      cause: error,
    });
  }
  await retryLockOperation(() => unlinkFile(stale), platform, 'stale-lock cleanup').catch(
    (error: unknown) => {
      if (!isCode(error, 'ENOENT')) {
        throw error;
      }
    },
  );
}

async function releaseLock(
  file: string,
  owner: LockOwner,
  platform: NodeJS.Platform,
  unlinkFile: typeof unlink,
): Promise<void> {
  const current = await readOwner(file, platform);
  if (current?.token !== owner.token || current.hostname !== owner.hostname) {
    return;
  }
  await retryLockOperation(() => unlinkFile(file), platform, 'lock release').catch(
    (error: unknown) => {
      if (!isCode(error, 'ENOENT')) {
        throw error;
      }
    },
  );
}

async function retryLockOperation<T>(
  operation: () => Promise<T>,
  platform: NodeJS.Platform,
  description: string,
): Promise<T> {
  for (let attempt = 0; attempt < lockOperationAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const retryable = platform === 'win32' && (isCode(error, 'EPERM') || isCode(error, 'EBUSY'));
      if (!retryable || attempt === lockOperationAttempts - 1) {
        throw new Error(
          `State file lock ${description} failed after ${lockOperationAttempts} attempts`,
          {
            cause: error,
          },
        );
      }
      await delay(20);
    }
  }
  throw new Error(`State file lock ${description} did not complete`);
}

async function readOwner(file: string, platform: NodeJS.Platform): Promise<LockOwner | undefined> {
  let lastParseError: SyntaxError | undefined;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const contents = await readFile(file, 'utf8');
      if (contents.trim() === '') {
        await delay(20);
        continue;
      }
      const value: unknown = JSON.parse(contents);
      if (!isLockOwner(value)) {
        throw new Error(`State file lock metadata is invalid on ${platform}`);
      }
      return value;
    } catch (error) {
      if (isCode(error, 'ENOENT')) {
        return undefined;
      }
      if (error instanceof SyntaxError) {
        lastParseError = error;
        await delay(20);
        continue;
      }
      throw error;
    }
  }
  if (lastParseError) {
    throw new Error(`State file lock metadata is invalid on ${platform}`, {
      cause: lastParseError,
    });
  }
  throw new Error('State file is locked by another gateway (owner metadata is unavailable)');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ESRCH' || error.code === 'EINVAL')
    ) {
      return false;
    }
    if (error instanceof Error && 'code' in error && error.code === 'EPERM') {
      return true;
    }
    throw error;
  }
}

function isLockOwner(value: unknown): value is LockOwner {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.pid === 'number' &&
    Number.isInteger(candidate.pid) &&
    candidate.pid > 0 &&
    typeof candidate.hostname === 'string' &&
    typeof candidate.token === 'string'
  );
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function legacyLockError(): Error {
  return new Error('State file has a legacy interrupted lock; preserve it for manual recovery');
}
