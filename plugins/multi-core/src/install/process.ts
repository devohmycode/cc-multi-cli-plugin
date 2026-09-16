import { spawn } from 'node:child_process';
import { executableInvocation } from '../gateway/executable.ts';
import { terminateProcessTree } from '../gateway/process-tree.ts';

export interface RunOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

/** Shell-free foreground process, including cancellation and exit status. */
export async function run(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<number> {
  const platform = options.platform ?? process.platform;
  const environment = options.env ?? process.env;
  const invocation = executableInvocation(command, args, platform, environment);
  const child = spawn(invocation.command, invocation.args, {
    stdio: 'inherit',
    env: environment,
    detached: platform !== 'win32',
    ...invocation.options,
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
