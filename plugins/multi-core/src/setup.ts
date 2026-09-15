import path from 'node:path';
import { setup } from './install/installation.ts';

function detectedShell(env: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  if (platform === 'win32') {
    if (env.PSModulePath || env.ComSpec) {
      return env.PSModulePath ? 'powershell' : 'cmd';
    }
    throw new Error('Cannot detect a Windows shell. Set PSModulePath or ComSpec, or pass --shell.');
  }
  return path.basename(env.SHELL ?? '');
}

async function main() {
  const args = process.argv.slice(2);
  let shell = detectedShell(process.env, process.platform);
  let claude: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    const value = args[++index];
    if (argument === '--shell' && value) {
      shell = value;
    } else if (argument === '--claude' && value) {
      claude = value;
    } else {
      throw new Error(
        'Usage: setup.ts [--shell bash|zsh|fish|powershell|cmd] [--claude /absolute/path]',
      );
    }
  }
  const state = await setup(shell, claude);
  console.log(
    `Multi startup installed in ${state.shellFile}. Open a new terminal, then run multi status and claude.`,
  );
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
