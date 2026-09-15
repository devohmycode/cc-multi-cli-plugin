import { spawn } from 'node:child_process';
import { terminateProcessTree } from '../gateway/process-tree.ts';

export interface RunOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

/** Shell-free foreground process, including cancellation and exit status. */
export async function run(
  command: string,
  args: string[],
  supplied: RunOptions | NodeJS.ProcessEnv = {},
): Promise<number> {
  const options = normalizeOptions(supplied);
  const platform = options.platform ?? process.platform;
  const child = spawn(command, args, {
    stdio: 'inherit',
    env: options.env ?? process.env,
    detached: platform !== 'win32',
  });
  const terminate = () => {
    if (child.pid) {
      terminateProcessTree(child.pid, { platform });
    }
  };
  const interrupt = () => {}; // The foreground terminal signals both processes on Unix.
  process.on('SIGTERM', terminate);
  process.on('SIGINT', interrupt);
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 1)));
    });
  } finally {
    process.off('SIGTERM', terminate);
    process.off('SIGINT', interrupt);
  }
}

function normalizeOptions(supplied: RunOptions | NodeJS.ProcessEnv): RunOptions {
  if ('platform' in supplied || 'env' in supplied) {
    return supplied as RunOptions;
  }
  return { env: supplied as NodeJS.ProcessEnv };
}
