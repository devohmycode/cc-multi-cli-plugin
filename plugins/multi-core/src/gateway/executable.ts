import { existsSync } from 'node:fs';
import path from 'node:path';

export interface ExecutableOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  configuredPath?: string;
  exists?: (filename: string) => boolean;
}

export interface ExecutableInvocation {
  command: string;
  args: string[];
}

/** Find a configured executable or a platform-appropriate PATH entry. */
export function resolveExecutable(name: string, options: ExecutableOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const configured = options.configuredPath;
  if (configured) {
    if (exists(configured)) {
      return configured;
    }
    throw missingExecutable(`Configured executable does not exist: ${configured}`);
  }
  const candidates = platform === 'win32' ? windowsCandidates(name, env.PATHEXT) : [name];
  const found = findOnPath(
    env.PATH ?? '',
    candidates,
    exists,
    platform === 'win32' ? ';' : path.delimiter,
    platform === 'win32' ? path.win32 : path,
  );
  if (found) {
    return found;
  }
  throw missingExecutable(`Executable not found on PATH: ${name}`);
}

function missingExecutable(message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return error;
}

/** Invoke Windows command shims without shell:true, preserving argument boundaries. */
export function executableInvocation(
  executable: string,
  args: readonly string[],
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ExecutableInvocation {
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(executable)) {
    return { command: executable, args: [...args] };
  }
  const command = env.ComSpec ?? process.env.ComSpec ?? 'cmd.exe';
  return {
    command,
    args: ['/d', '/s', '/c', [quoteWindows(executable), ...args.map(quoteWindows)].join(' ')],
  };
}

function findOnPath(
  pathValue: string,
  candidates: readonly string[],
  exists: (filename: string) => boolean,
  delimiter: string,
  pathModule: typeof path,
): string | undefined {
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const candidate of candidates) {
      const filename = pathModule.join(directory, candidate);
      if (exists(filename)) {
        return filename;
      }
    }
  }
  return undefined;
}

function windowsCandidates(name: string, pathext: string | undefined): string[] {
  if (path.extname(name)) {
    return [name];
  }
  const extensions = (pathext ?? '.COM;.EXE;.BAT;.CMD').split(';');
  return [...extensions, ''].map((extension) => `${name}${extension.toLowerCase()}`);
}

function quoteWindows(value: string): string {
  if (!/[\s"&()^|<>]/.test(value)) {
    return value;
  }
  return `"${value.replaceAll(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}
