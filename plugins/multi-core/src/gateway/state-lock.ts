import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';

export interface LockStateFileOptions {
  platform?: NodeJS.Platform;
}

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

  for (;;) {
    const release = await tryAcquire(file, owner, platform);
    if (release) {
      return release;
    }
    await takeOverStaleLock(file, platform);
  }
}

async function tryAcquire(
  file: string,
  owner: LockOwner,
  platform: NodeJS.Platform,
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
  return () => releaseLock(file, owner, platform);
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

async function takeOverStaleLock(file: string, platform: NodeJS.Platform): Promise<void> {
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
    await rename(file, stale);
  } catch (error) {
    if (isCode(error, 'ENOENT')) {
      return;
    }
    throw new Error('State file lock owner exited but stale-lock takeover failed', {
      cause: error,
    });
  }
  await unlink(stale).catch((error: unknown) => {
    if (!isCode(error, 'ENOENT')) {
      throw error;
    }
  });
}

async function releaseLock(
  file: string,
  owner: LockOwner,
  platform: NodeJS.Platform,
): Promise<void> {
  const current = await readOwner(file, platform);
  if (current?.token !== owner.token || current.hostname !== owner.hostname) {
    return;
  }
  await unlink(file).catch((error: unknown) => {
    if (!isCode(error, 'ENOENT')) {
      throw error;
    }
  });
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
