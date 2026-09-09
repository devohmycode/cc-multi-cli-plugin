import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { antigravityEnvironment } from './cli.ts';

export interface AntigravityModel {
  id: string;
  model: string;
  label: string;
  worker: string;
  effort?: 'low' | 'medium' | 'high';
}

export function parseAntigravityModels(output: string): AntigravityModel[] {
  const models = new Map<string, AntigravityModel>();
  for (const line of output.split('\n')) {
    const match = /^([a-z0-9][a-z0-9.-]*)\t([^\t\r\n]+)\r?$/.exec(line);
    if (!match) {
      continue;
    }
    const [, id, label] = match;
    models.set(id, {
      id,
      model: `multi/antigravity/${id}`,
      label: `Antigravity · ${label}`,
      worker: `antigravity-${id}`,
    });
  }
  if (!models.size) {
    throw new Error('Antigravity returned no recognized model catalog; run agy models.');
  }
  return [...models.values()];
}

export async function discoverAntigravityModels(): Promise<AntigravityModel[]> {
  const { stdout } = await promisify(execFile)('agy', ['models'], {
    timeout: 15000,
    maxBuffer: 1024 * 1024,
    env: antigravityEnvironment({ NO_COLOR: '1' }),
  });
  return parseAntigravityModels(stdout);
}

/** Resolve advertised variants; let agy validate effort for models without suffixes. */
export function selectAntigravityModel(
  models: readonly AntigravityModel[],
  model: string | undefined,
  effort?: unknown,
): AntigravityModel {
  const selected = models.find((option) => option.model === model);
  if (!selected) {
    throw new Error('Unknown Antigravity model; run agy models for native selections.');
  }
  if (effort === undefined) {
    return selected;
  }
  if (effort !== 'low' && effort !== 'medium' && effort !== 'high') {
    throw new Error('Antigravity effort must be an advertised low, medium or high variant.');
  }
  const base = selected.id.replace(/-(low|medium|high)$/, '');
  if (base === selected.id) {
    return { ...selected, effort };
  }
  const variant = models.find((option) => option.id === `${base}-${effort}`);
  if (!variant) {
    throw new Error(`Antigravity model ${selected.id} does not advertise ${effort} effort.`);
  }
  return variant;
}
