import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertCursorClaudeSettings,
  cursorPermissionPolicy,
  mergeCursorPermissions,
} from '../../../multi-cursor/src/permissions.ts';
import { pluginPermissions, type WorkerPermissions } from './agent-definitions.ts';
import type { PermissionContext } from './mode-hook.ts';

export interface CursorSettingsOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  osRelease?: string;
  readFile?: typeof fs.readFile;
  readDir?: typeof fs.readdir;
  runCommand?: (command: string, args: readonly string[]) => Promise<string>;
}

const defaultRunCommand = (command: string, args: readonly string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    childProcess.execFile(command, [...args], { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        Object.assign(error, { stderr });
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });

/** Re-read on each native dispatch; Claude-side rules cannot constrain SDK tools. */
export async function checkCursorSettings(
  cwd: string,
  args: readonly string[],
  inlineSettings: Record<string, unknown>,
  options: CursorSettingsOptions = {},
): Promise<WorkerPermissions> {
  const { sources, restrictions } = settingSources(args);
  await pluginPermissions(cwd, [...args, '--settings', JSON.stringify(inlineSettings)]);
  let context = mergeCursorPermissions({ permissionMode: 'auto' }, restrictions);
  const settingsOptions = {
    platform: options.platform ?? process.platform,
    env: options.env ?? process.env,
    osRelease: options.osRelease ?? os.release(),
    readFile: options.readFile ?? fs.readFile,
    readDir: options.readDir ?? fs.readdir,
    runCommand: options.runCommand ?? defaultRunCommand,
  };
  context = mergePolicies(context, await managedSettings(settingsOptions));
  context = mergeCursorPermissions(context, assertCursorClaudeSettings(inlineSettings));
  if (sources.has('user')) {
    context = mergeCursorPermissions(
      context,
      await checkFile(
        path.join(
          settingsOptions.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
          'settings.json',
        ),
        settingsOptions.readFile,
      ),
    );
  }
  for (let directory = path.resolve(cwd); ; directory = path.dirname(directory)) {
    if (sources.has('project')) {
      context = mergeCursorPermissions(
        context,
        await checkFile(path.join(directory, '.claude', 'settings.json'), settingsOptions.readFile),
      );
    }
    if (sources.has('local')) {
      context = mergeCursorPermissions(
        context,
        await checkFile(
          path.join(directory, '.claude', 'settings.local.json'),
          settingsOptions.readFile,
        ),
      );
    }
    if (directory === path.dirname(directory)) {
      break;
    }
  }
  cursorPermissionPolicy(context);
  return { tools: context.tools, disallowedTools: context.disallowedTools };
}

function mergePolicies(
  initial: PermissionContext,
  policies: readonly WorkerPermissions[],
): PermissionContext {
  let context = initial;
  for (const policy of policies) {
    context = mergeCursorPermissions(context, policy);
  }
  return context;
}

function settingSources(args: readonly string[]): {
  sources: Set<string>;
  restrictions: WorkerPermissions;
} {
  let context: PermissionContext = { permissionMode: 'auto' };
  let sources = 'user,project,local';
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') {
      break;
    }
    const name = arg.split('=', 1)[0];
    if (
      !['--tools', '--disallowedTools', '--disallowed-tools', '--setting-sources'].includes(name)
    ) {
      continue;
    }
    const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[++index];
    if (!value?.match(/^(?!--)/)) {
      throw new Error(`${name} requires a value`);
    }
    if (name === '--setting-sources') {
      sources = value;
    } else {
      const [list, lastIndex] = toolArguments(value, args, index);
      index = lastIndex;
      context = mergeCursorPermissions(context, toolRestriction(name, list));
    }
  }
  return { sources: selectedSources(sources), restrictions: context };
}

function selectedSources(sources: string): Set<string> {
  const selected = new Set(sources.split(',').filter(Boolean));
  if ([...selected].some((source) => !['user', 'project', 'local'].includes(source))) {
    throw new Error('Native Cursor received unsupported --setting-sources');
  }
  return selected;
}

async function checkFile(
  file: string,
  readFile: typeof fs.readFile = fs.readFile,
): Promise<WorkerPermissions> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (missing(error)) {
      return {};
    }
    throw error;
  }
  try {
    return assertCursorClaudeSettings(JSON.parse(text));
  } catch (error) {
    throw new Error(`Native Cursor settings admission failed for ${file}: ${String(error)}`);
  }
}

async function managedSettings(
  options: Required<CursorSettingsOptions>,
): Promise<WorkerPermissions[]> {
  // Claude Code documents these file locations: macOS uses
  // /Library/Application Support/ClaudeCode, Linux and WSL use /etc/claude-code,
  // and Windows uses C:\Program Files\ClaudeCode (ProgramData is legacy and ignored).
  // WSL is therefore admitted through the Linux file source; Claude only consults
  // the Windows chain when its documented wslInheritsWindowsSettings controls are active.
  if (!['linux', 'darwin', 'win32'].includes(options.platform)) {
    throw new Error(`Native Cursor managed-policy admission does not support ${options.platform}`);
  }
  const platformPath = options.platform === 'win32' ? path.win32 : path.posix;
  const effectivePlatform =
    options.platform === 'linux' && /microsoft/i.test(options.osRelease)
      ? 'linux'
      : options.platform;
  let directory: string;
  if (effectivePlatform === 'darwin') {
    directory = '/Library/Application Support/ClaudeCode';
  } else if (effectivePlatform === 'win32') {
    directory = String.raw`C:\Program Files\ClaudeCode`;
  } else {
    directory = '/etc/claude-code';
  }
  const files = await managedPolicyFiles(options, platformPath, directory);
  const policies: WorkerPermissions[] = [];
  for (const file of files) {
    let source: string;
    try {
      source = await options.readFile(file, 'utf8');
    } catch (error) {
      if (missing(error)) {
        continue;
      }
      throw error;
    }
    policies.push(managedPolicy(source, file));
  }
  if (effectivePlatform === 'darwin') {
    policies.push(
      ...(await managedCommandPolicy(options, 'defaults', ['read', 'com.anthropic.claudecode'])),
    );
  } else if (effectivePlatform === 'win32') {
    policies.push(...(await managedRegistryPolicies(options)));
  }
  return policies;
}

async function managedPolicyFiles(
  options: Required<CursorSettingsOptions>,
  platformPath: typeof path.posix,
  directory: string,
): Promise<string[]> {
  const files = [platformPath.join(directory, 'managed-settings.json')];
  try {
    const names = await options.readDir(platformPath.join(directory, 'managed-settings.d'));
    files.push(
      ...names
        .filter((name) => !name.startsWith('.') && name.endsWith('.json'))
        .sort()
        .map((name) => platformPath.join(directory, 'managed-settings.d', name)),
    );
  } catch (error) {
    if (!missing(error)) {
      throw error;
    }
  }
  return files;
}

async function managedCommandPolicy(
  options: Required<CursorSettingsOptions>,
  command: string,
  args: readonly string[],
): Promise<WorkerPermissions[]> {
  let source: string;
  try {
    source = await options.runCommand(command, args);
  } catch (error) {
    if (missing(error) || (error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      return [];
    }
    if (
      command === 'defaults' &&
      error instanceof Error &&
      'code' in error &&
      error.code === 1 &&
      'stderr' in error &&
      /does not exist|not found/i.test(String(error.stderr))
    ) {
      return [];
    }
    throw new Error(`Native Cursor cannot observe managed policy via ${command}: ${String(error)}`);
  }
  if (!source.trim()) {
    return [];
  }
  return [managedPolicy(parsePolicyValue(source), `${command} ${args.join(' ')}`)];
}

async function managedRegistryPolicies(
  options: Required<CursorSettingsOptions>,
): Promise<WorkerPermissions[]> {
  const policies: WorkerPermissions[] = [];
  for (const root of ['HKLM', 'HKCU']) {
    const source = await managedCommandPolicy(options, 'reg', [
      'query',
      `${root}\\SOFTWARE\\Policies\\ClaudeCode`,
      '/v',
      'Settings',
    ]);
    policies.push(...source);
  }
  return policies;
}

function parsePolicyValue(source: string): string {
  const trimmed = source.trim();
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    const match = trimmed.match(/(?:Settings\s+REG_(?:SZ|EXPAND_SZ)\s+)(.+)$/im);
    if (!match) {
      throw new Error('Native Cursor cannot parse managed policy output as JSON');
    }
    const value = match[1].trim();
    JSON.parse(value);
    return value;
  }
}

function managedPolicy(source: string, file: string): WorkerPermissions {
  const settings = JSON.parse(source.trim() || '{}');
  if (
    !settings ||
    typeof settings !== 'object' ||
    Array.isArray(settings) ||
    Object.keys(settings).some((key) => !['permissions', 'hooks', 'sandbox'].includes(key))
  ) {
    throw new Error(`Native Cursor cannot enforce managed policy ${file}; unsupported settings.`);
  }
  if (
    settings.permissions &&
    Object.keys(settings.permissions).some(
      (key) => !['allow', 'deny', 'ask', 'defaultMode'].includes(key),
    )
  ) {
    throw new Error(`Native Cursor cannot enforce managed permission controls in ${file}`);
  }
  return assertCursorClaudeSettings(settings);
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function toolRestriction(name: string, list: string[]): WorkerPermissions {
  if (name !== '--tools') {
    return { disallowedTools: list };
  }
  return list.includes('default') ? {} : { tools: list };
}

function toolArguments(value: string, args: readonly string[], start: number): [string[], number] {
  const values = [value];
  let index = start;
  while (index + 1 < args.length && !args[index + 1].startsWith('--')) {
    values.push(args[++index]);
  }
  return [values.flatMap((item) => item.split(/[ ,]+/).filter(Boolean)), index];
}
