import childProcess from 'node:child_process';
import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseDocument } from 'yaml';

export interface WorkerPermissions {
  permissionMode?: string;
  tools?: string[];
  disallowedTools?: string[];
  nativePermissionError?: string;
}

const MAX_AGENT_FILES = 1000;
const MAX_AGENT_BYTES = 1024 * 1024;
const PERMISSION_MODES = new Set([
  'default',
  'acceptEdits',
  'auto',
  'dontAsk',
  'bypassPermissions',
  'plan',
]);
const BUILTIN_WORKERS: Readonly<Record<string, WorkerPermissions>> = {
  'general-purpose': {},
  claude: {},
  Explore: { disallowedTools: ['Write', 'Edit'] },
  Plan: { disallowedTools: ['Write', 'Edit'] },
  'statusline-setup': {},
  'claude-code-guide': {},
};

export async function loadWorkerPermissions(
  cwd: string,
  supplied: Record<string, WorkerPermissions>,
  args: readonly string[] = [],
): Promise<Record<string, WorkerPermissions>> {
  const permissions = Object.assign(copy(BUILTIN_WORKERS), await pluginPermissions(cwd, args));
  const configDirectory = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  Object.assign(permissions, await loadScope(path.join(configDirectory, 'agents')));
  const root = await gitRoot(cwd);
  const directories = projectDirectories(cwd, root);
  for (const directory of directories) {
    Object.assign(permissions, await loadScope(path.join(directory, '.claude', 'agents')));
  }
  return Object.assign(permissions, supplied);
}

function copy(source: Record<string, WorkerPermissions>): Record<string, WorkerPermissions> {
  return Object.assign(Object.create(null), source);
}

async function gitRoot(cwd: string): Promise<string> {
  let directory = path.resolve(cwd);
  while (true) {
    try {
      await stat(path.join(directory, '.git'));
      return directory;
    } catch {
      const parent = path.dirname(directory);
      if (parent === directory) {
        return path.resolve(cwd);
      }
      directory = parent;
    }
  }
}

function projectDirectories(cwd: string, root: string): string[] {
  const directories: string[] = [];
  for (let directory = path.resolve(cwd); ; directory = path.dirname(directory)) {
    directories.unshift(directory);
    if (directory === root) {
      return directories;
    }
  }
}

async function loadScope(directory: string): Promise<Record<string, WorkerPermissions>> {
  const files = await agentFiles(directory);
  const permissions: Record<string, WorkerPermissions> = Object.create(null);
  for (const file of files) {
    const [name, definition] = await readDefinition(file);
    permissions[name] = definition;
  }
  return permissions;
}

async function agentFiles(directory: string): Promise<string[]> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await agentFiles(file)));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(file);
    }
    if (files.length > MAX_AGENT_FILES) {
      throw new Error(`Too many agent definitions under ${directory}`);
    }
  }
  return files;
}

async function readDefinition(file: string): Promise<[string, WorkerPermissions]> {
  const source = await readFile(file, 'utf8');
  if (Buffer.byteLength(source) > MAX_AGENT_BYTES) {
    throw new Error(`Agent definition ${file} exceeds ${MAX_AGENT_BYTES} bytes`);
  }
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) {
    throw new Error(`Agent definition ${file} has no YAML frontmatter`);
  }
  const document = parseDocument(frontmatter[1]);
  if (document.errors.length) {
    throw new Error(`Invalid YAML in agent definition ${file}: ${document.errors[0].message}`);
  }
  const value = document.toJS();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Agent definition ${file} frontmatter must be an object`);
  }
  const definition = value as Record<string, unknown>;
  const name = definition.name;
  if (typeof name !== 'string' || !name) {
    throw new Error(`Agent definition ${file} requires a name`);
  }
  if (typeof definition.description !== 'string' || !definition.description) {
    throw new Error(`Agent definition ${file} requires a description`);
  }
  const permissionMode = definition.permissionMode;
  if (
    permissionMode !== undefined &&
    (typeof permissionMode !== 'string' || !PERMISSION_MODES.has(permissionMode))
  ) {
    throw new Error(`Agent definition ${file} has an invalid permissionMode`);
  }
  return [
    name,
    {
      permissionMode,
      tools: toolList(definition.tools, file, 'tools'),
      disallowedTools: toolList(definition.disallowedTools, file, 'disallowedTools'),
    },
  ];
}

function toolList(value: unknown, file: string, field: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const tools = typeof value === 'string' ? value.split(',') : value;
  if (!Array.isArray(tools) || tools.some((tool) => typeof tool !== 'string')) {
    throw new Error(`Agent definition ${file} has an invalid ${field} list`);
  }
  return tools.map((tool) => tool.trim()).filter(Boolean);
}

export async function pluginPermissions(
  cwd: string,
  args: readonly string[],
): Promise<Record<string, WorkerPermissions>> {
  const stdout = await new Promise<string>((resolve, reject) => {
    childProcess.execFile(
      'claude',
      [...pluginArguments(args), 'plugin', 'list', '--json'],
      { cwd, timeout: 10000, maxBuffer: MAX_AGENT_BYTES },
      (error, output) => {
        if (error) {
          reject(error);
        } else {
          resolve(output);
        }
      },
    );
  });
  const plugins: unknown = JSON.parse(stdout);
  if (!Array.isArray(plugins)) {
    throw new Error('Invalid Claude plugin inventory');
  }
  const permissions: Record<string, WorkerPermissions> = Object.create(null);
  for (const plugin of plugins) {
    if (!plugin.enabled || (plugin.projectPath && !withinProject(cwd, plugin.projectPath))) {
      continue;
    }
    if (typeof plugin.id !== 'string' || typeof plugin.installPath !== 'string') {
      throw new Error('Invalid enabled Claude plugin');
    }
    Object.assign(permissions, await pluginAgents(plugin.installPath, plugin.id.split('@')[0]));
  }
  return permissions;
}

function pluginArguments(args: readonly string[]): string[] {
  const selected: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') {
      break;
    }
    const name = arg.split('=', 1)[0];
    if (!['--plugin-dir', '--plugin-url', '--setting-sources', '--settings'].includes(name)) {
      continue;
    }
    selected.push(arg);
    if (!arg.includes('=')) {
      const value = args[++index];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${name} requires a value`);
      }
      selected.push(value);
    }
  }
  return selected;
}

async function pluginAgents(
  directory: string,
  name: string,
): Promise<Record<string, WorkerPermissions>> {
  let manifest: Record<string, unknown> = {};
  try {
    manifest = JSON.parse(
      await readFile(path.join(directory, '.claude-plugin', 'plugin.json'), 'utf8'),
    );
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }
  // Plugin hooks are Claude-loop observability; they never run for native harness tools.
  const configured = manifest.agents ?? ['./agents'];
  const locations = Array.isArray(configured) ? configured : [configured];
  const permissions: Record<string, WorkerPermissions> = Object.create(null);
  for (const location of locations) {
    if (typeof location !== 'string' || !location.startsWith('./')) {
      throw new Error(`Unsupported agent path in plugin ${name}`);
    }
    const file = path.resolve(directory, location);
    const files = file.endsWith('.md') ? [file] : await agentFiles(file);
    for (const entry of files) {
      const [agent, rules] = await pluginDefinition(entry);
      permissions[`${name}:${agent}`] = rules;
    }
  }
  return permissions;
}

async function pluginDefinition(file: string): Promise<[string, WorkerPermissions]> {
  const source = await readFile(file, 'utf8');
  if (Buffer.byteLength(source) > MAX_AGENT_BYTES) {
    throw new Error(`Agent definition ${file} exceeds size limit`);
  }
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const document = parseDocument(frontmatter?.[1] ?? '');
  if (document.errors.length) {
    throw new Error(`Malformed plugin agent ${file}`);
  }
  const definition = document.toJS();
  const value =
    definition && typeof definition === 'object' && !Array.isArray(definition) ? definition : {};
  const name = typeof value.name === 'string' ? value.name : path.basename(file, '.md');
  // Claude ignores plugin permissionMode, hooks and mcpServers by design.
  return [
    name,
    {
      tools: toolList(value.tools, file, 'tools'),
      disallowedTools: toolList(value.disallowedTools, file, 'disallowedTools'),
    },
  ];
}

function withinProject(cwd: string, project: string): boolean {
  const relative = path.relative(path.resolve(project), path.resolve(cwd));
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}
