import { spawn } from 'node:child_process';

export interface ProcessTreeOptions {
  platform?: NodeJS.Platform;
  signal?: NodeJS.Signals;
  kill?: (pid: number, signal?: NodeJS.Signals | number) => void;
  taskkill?: (pid: number) => void;
}

/**
 * Stop a CLI and its descendants. POSIX group membership is best effort: a
 * child can leave the group, so the direct-PID fallback is always attempted.
 * Windows has no portable POSIX group signal, therefore taskkill owns the tree.
 */
export function terminateProcessTree(pid: number, options: ProcessTreeOptions = {}): void {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    (options.taskkill ?? defaultTaskkill)(pid);
    return;
  }
  const kill = options.kill ?? process.kill;
  const signal = options.signal ?? 'SIGTERM';
  try {
    kill(-pid, signal);
  } catch {
    // The process may have exited, or the group may not exist.
  }
  try {
    kill(pid, signal);
  } catch {
    // The process may have exited between group and direct cleanup.
  }
}

function defaultTaskkill(pid: number): void {
  const child = spawn(
    process.env.ComSpec ?? 'cmd.exe',
    ['/d', '/c', 'taskkill', '/T', '/F', '/PID', String(pid)],
    {
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  child.once('error', () => {});
}
