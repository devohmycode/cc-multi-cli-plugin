import path from 'node:path';
import { setup } from './install/installation.ts';

async function main() {
  const args = process.argv.slice(2);
  let shell = path.basename(process.env.SHELL ?? '');
  let claude: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    const value = args[++index];
    if (argument === '--shell' && value) {
      shell = value;
    } else if (argument === '--claude' && value) {
      claude = value;
    } else {
      throw new Error('Usage: setup.ts [--shell bash|zsh] [--claude /absolute/path]');
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
