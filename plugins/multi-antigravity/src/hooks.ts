import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hookCommand } from '../../multi-core/src/gateway/permission-hook.ts';
import { lockCursorSession } from '../../multi-cursor/src/state-lock.ts';

const namespace = 'multi-cli-antigravity';

function definition() {
  return {
    PreToolUse: [
      {
        matcher: '*',
        hooks: [
          {
            type: 'command',
            command: `if [ "\${MULTI_ANTIGRAVITY_TOOLS+x}" = x ]; then ${hookCommand(new URL('./permission-hook.ts', import.meta.url))}; fi`,
            timeout: 10,
          },
        ],
      },
    ],
  };
}

function hookFile() {
  return path.join(os.homedir(), '.gemini', 'config', 'hooks.json');
}

async function readHooks(file: string): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Invalid Antigravity hooks file');
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

/** Install one stable hook; each originating CLI process carries its own policy. */
export async function installAntigravityHook(file = hookFile()): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const unlock = await lockCursorSession(`${file}.multi-lock`);
  try {
    const hooks = await readHooks(file);
    hooks[namespace] = definition();
    assertAntigravityHooks(hooks);
    const temporary = `${file}.multi-${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(hooks, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await unlock();
  }
}

export async function checkAntigravityHooks(
  cwd = process.cwd(),
  files: { globalFile?: string; settingsFile?: string } = {},
): Promise<void> {
  assertAntigravityHooks(await readHooks(files.globalFile ?? hookFile()));
  const settings = await readHooks(
    files.settingsFile ?? path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json'),
  );
  if (settings.modelProvider !== undefined || settings.customModels !== undefined) {
    throw new Error(
      'Antigravity requires native account authentication and models; custom provider settings are unsupported.',
    );
  }
  await assertWorkspaceHooks(cwd);
}

async function assertWorkspaceHooks(cwd: string): Promise<void> {
  let directory = path.resolve(cwd);
  try {
    directory = await realpath(directory);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }
  while (true) {
    const hooks = await readHooks(path.join(directory, '.agents', 'hooks.json'));
    assertNoActivePreToolUse(hooks, 'workspace');
    const parent = path.dirname(directory);
    if (parent === directory) {
      return;
    }
    directory = parent;
  }
}

function assertAntigravityHooks(hooks: Record<string, unknown>): void {
  if (JSON.stringify(hooks[namespace]) !== JSON.stringify(definition())) {
    throw new Error(
      'Antigravity requires its native permission hook. Run the launcher with --antigravity-setup.',
    );
  }
  for (const [name, value] of Object.entries(hooks)) {
    if (name === namespace || !value || typeof value !== 'object') {
      continue;
    }
    if ('enabled' in value && value.enabled === false) {
      continue;
    }
    assertNoActivePreToolUse({ [name]: value }, 'global');
  }
}

function assertNoActivePreToolUse(hooks: Record<string, unknown>, location: string): void {
  const suffix = location === 'global' ? '' : ` (${location})`;
  for (const value of Object.values(hooks)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      continue;
    }
    if ('enabled' in value && value.enabled === false) {
      continue;
    }
    if ('PreToolUse' in value) {
      throw new Error(
        `Antigravity cannot establish restriction precedence with another active PreToolUse hook${suffix}.`,
      );
    }
  }
  if ('PreToolUse' in hooks) {
    throw new Error(
      `Antigravity cannot establish restriction precedence with another active PreToolUse hook${suffix}.`,
    );
  }
}
