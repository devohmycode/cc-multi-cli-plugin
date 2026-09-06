import { createHash } from 'node:crypto';
import type { ModelListItem, ModelSelection } from '@cursor/sdk';

export interface CursorModelOption {
  model: string;
  label: string;
  description: string;
  worker: string;
  nativeWorker: boolean;
  selection: ModelSelection;
  catalog: ModelListItem;
}

/** Only expose models and parameter presets actually advertised to this account. */
export function cursorModelOptions(catalog: ModelListItem[]): CursorModelOption[] {
  const options = new Map<string, CursorModelOption>();
  const workers = new Set<string>();
  for (const item of catalog) {
    const variants = item.variants ?? [];
    const defaultVariant = variants.find(v => v.isDefault);
    const selections = [
      { params: defaultVariant?.params, label: item.displayName, base: true },
      ...variants.map(v => ({ params: v.params, label: `${item.displayName} · ${v.displayName}`, base: false }))
    ];
    for (const { params, label, base } of selections) {
      // Router requires an explicit optimize_for; never invent its default.
      if (item.id === 'auto-smart' && !params?.some(p => p.id === 'optimize_for')) continue;
      const suffix = params?.map(p => `${encodeURIComponent(p.id)}=${encodeURIComponent(p.value)}`).sort().join(',');
      const model = `multi/cursor/${encodeURIComponent(item.id)}${!base && suffix ? '/' + suffix : ''}`;
      const slug = item.id.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40);
      const changed = params?.filter(p => defaultVariant?.params.find(d => d.id === p.id)?.value !== p.value) ?? [];
      const nativeWorker = base || (changed.length === 1 && ['effort', 'reasoning_effort'].includes(changed[0].id));
      const preset = (nativeWorker ? changed : params)?.map(p => `${p.id}-${p.value}`).join('-').toLowerCase().replace(/[^a-z0-9-]/g, '-');
      let worker = `cursor-${slug}${!base && preset ? '-' + preset : ''}`.slice(0, 90);
      if (workers.has(worker)) worker += '-' + createHash('sha256').update(model).digest('hex').slice(0, 8);
      workers.add(worker);
      options.set(model, { model, label: `${label} via Cursor`, description: 'Cursor SDK · Claude Code executes tools',
        worker, nativeWorker,
        selection: { id: item.id, ...(params?.length ? { params } : {}) }, catalog: item });
    }
  }
  return [...options.values()];
}

export function cursorSelection(option: CursorModelOption, effort?: string): ModelSelection {
  const parameter = option.catalog.parameters?.find(p => p.id === 'effort' || p.id === 'reasoning_effort');
  // Explicit presets win; models without an effort parameter have nothing to set.
  if (!effort || !parameter || option.model.split('/').length > 3) return option.selection;
  if (!parameter.values.some(v => v.value === effort)) {
    throw new Error(`Cursor ${option.selection.id} supports ${parameter.id}: ${parameter.values.map(v => v.value).join(', ')}; received ${effort}`);
  }
  return { id: option.selection.id, params: [
    ...(option.selection.params ?? []).filter(p => p.id !== parameter.id), { id: parameter.id, value: effort }
  ] };
}
