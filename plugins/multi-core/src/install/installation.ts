import { constants } from 'node:fs';
import {
  access,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const begin = '# >>> multi-cli >>>';
const end = '# <<< multi-cli <<<';
const files = ['bootstrap.ts', 'installation.ts', 'plugins.ts', 'process.ts'];

export interface Installation {
  claude: string;
  node: string;
  shellFile: string;
  block: string;
}

function installationDirectory() {
  return path.join(os.homedir(), '.local', 'share', 'multi-cli');
}

function quote(value: string) {
  if (/[\r\n\0]/.test(value)) {
    throw new Error('Newlines and NUL are unsupported in installation paths');
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function optionalText(file: string) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

export async function readInstallation(directory = installationDirectory()): Promise<Installation> {
  const value = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8'));
  if (
    !value ||
    !['claude', 'node', 'shellFile', 'block'].every((key) => typeof value[key] === 'string') ||
    ![value.claude, value.node, value.shellFile].every((file) => path.isAbsolute(file))
  ) {
    throw new Error('Invalid Multi installation state');
  }
  return value;
}

/** Preserve the public executable path so Claude's own updater can replace its target. */
async function findClaude(explicit?: string) {
  const candidates = explicit
    ? [explicit]
    : (process.env.PATH ?? '').split(path.delimiter).map((dir) => path.join(dir, 'claude'));
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) {
      continue;
    }
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH for an executable.
    }
  }
  throw new Error(
    'Cannot find the real Claude executable. Pass --claude /absolute/path/to/claude.',
  );
}

function removeBlock(source: string, block: string) {
  if (!source.includes(block)) {
    throw new Error('Multi shell configuration was edited; refusing to overwrite it.');
  }
  return source.replace(block, '');
}

function validateRuntime(shell: string) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 12)) {
    throw new Error('Multi setup requires Node >= 24.12 on PATH.');
  }
  if (process.platform === 'win32' || !['bash', 'zsh'].includes(shell)) {
    throw new Error(
      'Multi setup supports Bash or Zsh on Linux/macOS. Use --shell bash or --shell zsh.',
    );
  }
}

async function previousInstallation(directory: string) {
  if (await optionalText(path.join(directory, 'state.json'))) {
    return readInstallation(directory);
  }
  try {
    if ((await readdir(directory)).length) {
      throw new Error(
        'Multi installation directory contains unrecognized files; refusing to overwrite them.',
      );
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }
  return undefined;
}

export async function setup(shell: string, explicitClaude?: string) {
  validateRuntime(shell);
  const directory = installationDirectory();
  const stateFile = path.join(directory, 'state.json');
  const previous = await previousInstallation(directory);
  const shellFile = path.join(os.homedir(), shell === 'bash' ? '.bashrc' : '.zshrc');
  if (previous && previous.shellFile !== shellFile) {
    throw new Error('Uninstall the existing shell integration before changing shells.');
  }
  const claude = await findClaude(explicitClaude ?? previous?.claude);
  const source = await optionalText(shellFile);
  const original = previous ? removeBlock(source, previous.block) : source;
  if (original.includes(begin) || original.includes(end)) {
    throw new Error('Unrecognized Multi shell block; refusing to modify shell configuration.');
  }
  const node = process.execPath;
  const bin = path.join(directory, 'bin');
  const block = `\n${begin}\nexport PATH=${quote(bin)}:"$PATH"\n${end}\n`;
  await mkdir(bin, { recursive: true, mode: 0o700 });
  for (const file of files) {
    const origin = fileURLToPath(new URL(file, import.meta.url));
    const destination = path.join(directory, file);
    if (origin !== destination) {
      await copyFile(origin, destination);
    }
  }
  for (const name of ['claude-multi', 'multi']) {
    const script = `#!/bin/sh\nexec ${quote(node)} ${quote(path.join(directory, 'bootstrap.ts'))}${name === 'multi' ? ' --multi' : ''} "$@"\n`;
    await writeFile(path.join(bin, name), script, { mode: 0o700 });
  }
  const state: Installation = { claude, node, shellFile, block };
  await writeFile(`${stateFile}.tmp`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(`${stateFile}.tmp`, stateFile);
  await writeFile(shellFile, original + block);
  return state;
}

export async function uninstall(directory = installationDirectory()) {
  const state = await readInstallation(directory);
  const source = await readFile(state.shellFile, 'utf8');
  await writeFile(state.shellFile, removeBlock(source, state.block));
  // Delete only known installation files, leaving unrelated files untouched.
  for (const file of [...files, 'state.json', 'bin/claude-multi', 'bin/multi']) {
    await rm(path.join(directory, file), { force: true });
  }
  for (const empty of [path.join(directory, 'bin'), directory]) {
    try {
      await rmdir(empty);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOTEMPTY')) {
        throw error;
      }
    }
  }
}
