import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertCursorClaudeSettings,
  cursorPermissionPolicy,
  mergeCursorPermissions,
} from '../providers/cursor/permissions.ts';
import { pluginPermissions, type WorkerPermissions } from './agent-definitions.ts';
import type { PermissionContext } from './mode-hook.ts';

/** Re-read on each native dispatch; Claude-side rules cannot constrain SDK tools. */
export async function checkCursorSettings(
  cwd: string,
  args: readonly string[],
  inlineSettings: Record<string, unknown>,
): Promise<WorkerPermissions> {
  const { sources, restrictions } = settingSources(args);
  await pluginPermissions(cwd, [...args, '--settings', JSON.stringify(inlineSettings)]);
  let context = mergeCursorPermissions({ permissionMode: 'auto' }, restrictions);
  for (const policy of await managedSettings()) {
    context = mergeCursorPermissions(context, policy);
  }
  context = mergeCursorPermissions(context, assertCursorClaudeSettings(inlineSettings));
  if (sources.has('user')) {
    context = mergeCursorPermissions(
      context,
      await checkFile(
        path.join(
          process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
          'settings.json',
        ),
      ),
    );
  }
  for (let directory = path.resolve(cwd); ; directory = path.dirname(directory)) {
    if (sources.has('project')) {
      context = mergeCursorPermissions(
        context,
        await checkFile(path.join(directory, '.claude', 'settings.json')),
      );
    }
    if (sources.has('local')) {
      context = mergeCursorPermissions(
        context,
        await checkFile(path.join(directory, '.claude', 'settings.local.json')),
      );
    }
    if (directory === path.dirname(directory)) {
      break;
    }
  }
  cursorPermissionPolicy(context);
  return { tools: context.tools, disallowedTools: context.disallowedTools };
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

async function checkFile(file: string): Promise<WorkerPermissions> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
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

async function managedSettings(): Promise<WorkerPermissions[]> {
  if (process.platform !== 'linux' || /microsoft/i.test(os.release())) {
    throw new Error(
      'Native Cursor cannot observe MDM/registry policy on this platform; managed-policy admission requires Linux without WSL.',
    );
  }
  const directory = '/etc/claude-code';
  const files = [path.join(directory, 'managed-settings.json')];
  try {
    const names = await fs.readdir(path.join(directory, 'managed-settings.d'));
    files.push(
      ...names
        .filter((name) => !name.startsWith('.') && name.endsWith('.json'))
        .sort()
        .map((name) => path.join(directory, 'managed-settings.d', name)),
    );
  } catch (error) {
    if (!missing(error)) {
      throw error;
    }
  }
  const policies: WorkerPermissions[] = [];
  for (const file of files) {
    let source: string;
    try {
      source = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (missing(error)) {
        continue;
      }
      throw error;
    }
    policies.push(managedPolicy(source, file));
  }
  return policies;
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
