import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hookCommand } from '../../multi-core/src/gateway/permission-hook.ts';
import { lockStateFile } from '../../multi-core/src/gateway/state-lock.ts';

const namespace = 'multi-cli-antigravity';

function definition() {
  return {
    PreToolUse: [
      {
        matcher: '*',
        hooks: [
          {
            type: 'command',
            command: `if [ "\${MULTI_ANTIGRAVITY_DENY+x}" = x ]; then ${hookCommand(new URL('./permission-hook.ts', import.meta.url))}; fi`,
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
  const unlock = await lockStateFile(`${file}.multi-lock`);
  try {
    const hooks = await readHooks(file);
    hooks[namespace] = definition();
    const temporary = `${file}.multi-${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(hooks, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await unlock();
  }
}

export async function checkAntigravityHooks(
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
}

function assertAntigravityHooks(hooks: Record<string, unknown>): void {
  if (JSON.stringify(hooks[namespace]) !== JSON.stringify(definition())) {
    throw new Error(
      'Antigravity requires its native permission hook. Run the launcher with --antigravity-setup.',
    );
  }
}
