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

type Platform = NodeJS.Platform;

export interface Installation {
  claude: string;
  node: string;
  shellFile: string;
  block: string;
  platform?: Platform;
  shims?: string[];
}

export interface InstallationOptions {
  platform?: Platform;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  shell?: string;
}

function optionsFor(options: InstallationOptions = {}) {
  return {
    platform: options.platform ?? process.platform,
    env: options.env ?? process.env,
    homedir: options.homedir ?? os.homedir(),
  };
}

function installationDirectory(homedir = os.homedir()) {
  return path.join(homedir, '.local', 'share', 'multi-cli');
}

function posixQuote(value: string) {
  if (/[\r\n\0]/.test(value)) {
    throw new Error('Newlines and NUL are unsupported in installation paths');
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function powershellQuote(value: string) {
  if (/[\r\n\0]/.test(value)) {
    throw new Error('Newlines and NUL are unsupported in installation paths');
  }
  return `'${value.replaceAll("'", "''")}'`;
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
async function findClaude(
  explicit: string | undefined,
  platform: Platform,
  env: NodeJS.ProcessEnv,
) {
  const pathValue = env.PATH ?? '';
  const extensions =
    platform === 'win32' ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  const candidates = explicit
    ? [explicit]
    : pathValue
        .split(path.delimiter)
        .flatMap((directory) =>
          extensions.map((extension) => path.join(directory, `claude${extension.toLowerCase()}`)),
        );
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) {
      continue;
    }
    try {
      if (platform === 'win32') {
        await access(candidate);
      } else {
        await access(candidate, constants.X_OK);
      }
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
  const start = source.indexOf(begin);
  const finish = source.indexOf(end, start + begin.length);
  const recorded = start >= 0 && finish >= 0 ? source.slice(start, finish + end.length) : '';
  if (recorded !== block.trim()) {
    throw new Error('Multi shell configuration was edited; refusing to overwrite it.');
  }
  return source.replace(block, '');
}

function moveOutOfDirectory(directory: string) {
  const current = path.resolve(process.cwd());
  const target = path.resolve(directory);
  const relative = path.relative(target, current);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..')) {
    process.chdir(path.dirname(target));
  }
}

function validateRuntime(shell: string, platform: Platform) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 12)) {
    throw new Error('Multi setup requires Node >= 24.12 on PATH.');
  }
  const supported =
    platform === 'win32' ? ['powershell', 'pwsh', 'cmd', 'cmd.exe'] : ['bash', 'zsh', 'fish'];
  if (!supported.includes(shell.toLowerCase())) {
    throw new Error(
      platform === 'win32'
        ? 'Multi setup supports PowerShell or cmd on Windows. Use --shell powershell or --shell cmd.'
        : 'Multi setup supports Bash, Zsh, or fish on macOS/Linux. Use --shell bash, --shell zsh, or --shell fish.',
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

function shellFile(homedir: string, shell: string, platform: Platform, env: NodeJS.ProcessEnv) {
  if (platform === 'win32') {
    return (
      env.PROFILE ??
      path.join(homedir, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1')
    );
  }
  let relative = '.config/fish/config.fish';
  if (shell === 'bash') {
    relative = '.bashrc';
  } else if (shell === 'zsh') {
    relative = '.zshrc';
  }
  return path.join(homedir, relative);
}

function blockFor(bin: string, shell: string, platform: Platform) {
  if (platform === 'win32') {
    return `\n${begin}\n$env:Path = ${powershellQuote(bin)} + [IO.Path]::PathSeparator + $env:Path\n${end}\n`;
  }
  const pathExpression =
    shell === 'fish'
      ? `set -gx PATH ${posixQuote(bin)} $PATH`
      : `export PATH=${posixQuote(bin)}:"$PATH"`;
  return `\n${begin}\n${pathExpression}\n${end}\n`;
}

async function writeRuntime(directory: string, bin: string, node: string, platform: Platform) {
  await mkdir(bin, { recursive: true, mode: 0o700 });
  for (const file of files) {
    const origin = fileURLToPath(new URL(file, import.meta.url));
    const destination = path.join(directory, file);
    if (origin !== destination) {
      await copyFile(origin, destination);
    }
  }
  const gatewayDirectory = path.join(directory, '..', 'gateway');
  await mkdir(gatewayDirectory, { recursive: true });
  for (const file of ['executable.ts', 'process-tree.ts']) {
    const origin = fileURLToPath(new URL(`../gateway/${file}`, import.meta.url));
    await copyFile(origin, path.join(gatewayDirectory, file));
  }
  const shimNames = ['claude-multi', 'multi'];
  for (const name of shimNames) {
    const bootstrap = path.join(directory, 'bootstrap.ts');
    if (platform === 'win32') {
      const suffix = name === 'multi' ? ' --multi' : '';
      // cmd.exe reads a batch file line by line while it runs. `multi uninstall`
      // deletes this shim before it finishes, so the whole script is one line:
      // `exit /b` without a code keeps the child's ERRORLEVEL.
      const cmd = `@"${node}" "${bootstrap}"${suffix} %* & exit /b\r\n`;
      await writeFile(path.join(bin, `${name}.cmd`), cmd);
      await writeFile(
        path.join(bin, `${name}.ps1`),
        `& ${powershellQuote(node)} ${powershellQuote(bootstrap)}${suffix} @args\r\nexit $LASTEXITCODE\r\n`,
      );
    } else {
      const suffix = name === 'multi' ? ' --multi' : '';
      const script = `#!/bin/sh\nexec ${posixQuote(node)} ${posixQuote(bootstrap)}${suffix} "$@"\n`;
      await writeFile(path.join(bin, name), script, { mode: 0o700 });
    }
  }
  return platform === 'win32'
    ? shimNames.flatMap((name) => [`${name}.cmd`, `${name}.ps1`])
    : shimNames;
}

export async function setup(
  shell: string,
  explicitClaude?: string,
  options: InstallationOptions = {},
) {
  const resolved = optionsFor(options);
  const normalizedShell = shell.toLowerCase();
  validateRuntime(normalizedShell, resolved.platform);
  const directory = installationDirectory(resolved.homedir);
  const stateFile = path.join(directory, 'state.json');
  const previous = await previousInstallation(directory);
  const startupFile = shellFile(resolved.homedir, normalizedShell, resolved.platform, resolved.env);
  if (previous && previous.shellFile !== startupFile) {
    throw new Error('Uninstall the existing shell integration before changing shells.');
  }
  const claude = await findClaude(
    explicitClaude ?? previous?.claude,
    resolved.platform,
    resolved.env,
  );
  const source = await optionalText(startupFile);
  const original = previous ? removeBlock(source, previous.block) : source;
  if (original.includes(begin) || original.includes(end)) {
    throw new Error('Unrecognized Multi shell block; refusing to modify shell configuration.');
  }
  const node = process.execPath;
  const bin = path.join(directory, 'bin');
  const block = blockFor(bin, normalizedShell, resolved.platform);
  const shims = await writeRuntime(directory, bin, node, resolved.platform);
  const state: Installation = {
    claude,
    node,
    shellFile: startupFile,
    block,
    platform: resolved.platform,
    shims,
  };
  await writeFile(`${stateFile}.tmp`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(`${stateFile}.tmp`, stateFile);
  await mkdir(path.dirname(startupFile), { recursive: true });
  await writeFile(startupFile, original + block);
  return state;
}

export async function uninstall(directory = installationDirectory()) {
  const state = await readInstallation(directory);
  const source = await readFile(state.shellFile, 'utf8');
  await writeFile(state.shellFile, removeBlock(source, state.block));
  moveOutOfDirectory(directory);
  const shimFiles = state.shims ?? ['claude-multi', 'multi'];
  for (const file of [
    ...files,
    'state.json',
    '../gateway/executable.ts',
    '../gateway/process-tree.ts',
    ...shimFiles.map((name) => path.join('bin', name)),
  ]) {
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
