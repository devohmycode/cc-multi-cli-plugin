import { spawn } from 'node:child_process';

/** Shell-free foreground process, including cancellation and exit status. */
export async function run(command: string, args: string[], env = process.env): Promise<number> {
  const child = spawn(command, args, { stdio: 'inherit', env });
  const terminate = () => child.kill('SIGTERM');
  const interrupt = () => {}; // The foreground terminal signals both processes.
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
