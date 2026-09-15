import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

function executableInvocation(
  executable: string,
  args: readonly string[],
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (platform !== 'win32' || !/(?:\.cmd|\.bat)$/i.test(executable)) {
    return { command: executable, args: [...args] };
  }
  const command = env.ComSpec ?? process.env.ComSpec ?? 'cmd.exe';
  const quote = (value: string) =>
    `"${value.replaceAll(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
  const commandLine = [quote(executable), ...args.map(quote)].join(' ');
  return {
    command,
    args: ['/d', '/s', '/c', `"${commandLine}"`],
    options: { windowsVerbatimArguments: true },
  };
}

const MARKETPLACE = 'cc-multi-cli-plugin';
const PROVIDERS = ['openai', 'cursor', 'zen', 'antigravity'] as const;
export type Provider = (typeof PROVIDERS)[number];

interface Plugin {
  id: string;
  enabled: boolean;
  scope: string;
  installPath: string;
  errors?: unknown;
}

export function providerSelection(value: string | undefined): Provider[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return [...new Set(value.split(',').filter(Boolean))].map((id) => {
    const provider = PROVIDERS.find((name) => name === id);
    if (!provider) {
      throw new Error(`Unknown Multi provider: ${id}`);
    }
    return provider;
  });
}

/** Ask Claude for its enabled plugins rather than interpreting its cache layout. */
export async function installedPlugins(
  claude: string,
  settingsArgs: string[] = [],
  options: { platform?: NodeJS.Platform } = {},
) {
  const platform = options.platform ?? process.platform;
  const invocation = executableInvocation(
    claude,
    [...settingsArgs, 'plugin', 'list', '--json'],
    platform,
  );
  const { stdout } = await promisify(execFile)(invocation.command, invocation.args, {
    timeout: 15000,
    maxBuffer: 4 * 1024 * 1024,
    encoding: 'utf8',
    ...invocation.options,
  });
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) {
    throw new Error('Claude returned an invalid plugin list. Update Claude Code and retry.');
  }
  const plugins = parsed.filter((item): item is Plugin => {
    return (
      item !== null &&
      typeof item === 'object' &&
      typeof item.id === 'string' &&
      typeof item.enabled === 'boolean' &&
      typeof item.scope === 'string' &&
      typeof item.installPath === 'string' &&
      path.isAbsolute(item.installPath)
    );
  });
  for (const plugin of plugins) {
    if (
      plugin.enabled &&
      plugin.id.endsWith(`@${MARKETPLACE}`) &&
      Array.isArray(plugin.errors) &&
      plugin.errors.length
    ) {
      throw new Error(
        `Claude reports errors for ${plugin.id}. Repair the plugin installation before launching Multi.`,
      );
    }
  }
  const core = plugins.filter(
    (plugin) => plugin.id === `multi-core@${MARKETPLACE}` && plugin.enabled,
  );
  // Startup executes before the workspace trust prompt. Only a user-installed
  // core may supply executable code here; project providers are fixed opt-ins.
  const personalCore = core.filter((plugin) => plugin.scope === 'user');
  if (core.length && personalCore.length !== 1) {
    throw new Error('Install multi-core at user scope before running Multi setup.');
  }
  const providers = PROVIDERS.filter((name) =>
    plugins.some((plugin) => plugin.id === `multi-${name}@${MARKETPLACE}` && plugin.enabled),
  );
  return { root: personalCore[0]?.installPath, providers };
}

export function settingsArguments(args: string[]): string[] {
  const selected: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') {
      break;
    }
    if (['--settings', '--setting-sources'].includes(arg)) {
      const value = args[++index];
      if (value === undefined) {
        throw new Error(`${arg} requires a value`);
      }
      selected.push(arg, value);
    } else if (arg.startsWith('--settings=') || arg.startsWith('--setting-sources=')) {
      selected.push(arg);
    }
  }
  return selected;
}
