import assert from 'node:assert/strict';
import test from 'node:test';
import {
  antigravityPickerOptions,
  parseAntigravityModels,
  selectAntigravityModel,
} from '../../plugins/multi-antigravity/src/models.ts';

test('Antigravity catalog resolves only advertised effort variants', () => {
  const models = parseAntigravityModels(
    'Fetching available models...\ngemini-3.8-flash-low\tGemini Low\ngemini-3.8-flash-high\tGemini High\nclaude-sonnet-4-6\tSonnet\n',
  );
  assert.equal(models.length, 3);
  assert.equal(selectAntigravityModel(models, models[0].model, 'high').id, 'gemini-3.8-flash-high');
  assert.equal(selectAntigravityModel(models, models[2].model).id, 'claude-sonnet-4-6');
  assert.throws(() => selectAntigravityModel(models, models[0].model, 'medium'), /advertise/);
  assert.deepEqual(selectAntigravityModel(models, models[2].model, 'high'), {
    ...models[2],
    effort: 'high',
  });
  assert.throws(() => selectAntigravityModel(models, 'multi/antigravity/unknown'), /Unknown/);
  assert.throws(() => parseAntigravityModels('not a catalog'), /no recognized/);
});

test('Antigravity picker groups exact suffix families and resolves only advertised defaults', () => {
  const models = parseAntigravityModels(
    [
      'gemini-low\tGemini (Low)',
      'gemini-high\tGemini (High)',
      'gemini-medium\tGemini (Medium)',
      'sonnet\tSonnet',
      'sonnet-thinking\tSonnet Thinking',
      'single-low\tSingle Low',
    ].join('\n'),
  );
  const before = structuredClone(models);
  const picker = antigravityPickerOptions(models);
  assert.deepEqual(
    picker.map(({ id }) => id),
    ['gemini', 'sonnet', 'sonnet-thinking', 'single'],
  );
  assert.equal(picker[0].label, 'Antigravity · Gemini');
  assert.equal(picker[0].worker, 'antigravity-gemini');
  assert.equal(selectAntigravityModel(models, picker[0].model).id, 'gemini-medium');
  for (const effort of ['low', 'medium', 'high']) {
    assert.equal(selectAntigravityModel(models, picker[0].model, effort).id, `gemini-${effort}`);
  }
  assert.equal(
    selectAntigravityModel(
      models.filter(({ id }) => id !== 'gemini-medium'),
      picker[0].model,
    ).id,
    'gemini-high',
  );
  assert.equal(selectAntigravityModel(models, picker[3].model).id, 'single-low');
  assert.throws(
    () => selectAntigravityModel(models, picker[3].model, 'high'),
    /does not advertise/,
  );
  assert.throws(
    () => selectAntigravityModel(models, picker[0].model, 'max'),
    /advertised low, medium or high/,
  );
  assert.equal(selectAntigravityModel(models, models[0].model).id, 'gemini-low');
  assert.deepEqual(models, before);
});

test('Antigravity never shadows a native base or collapses thinking identities by label', () => {
  const models = parseAntigravityModels(
    'gemini\tGemini\ngemini-high\tGemini High\nsonnet-thinking-low\tSonnet Low\nsonnet-low\tSonnet Low',
  );
  assert.deepEqual(
    antigravityPickerOptions(models).map(({ id }) => id),
    ['gemini', 'gemini-high', 'sonnet-thinking', 'sonnet'],
  );
  assert.deepEqual(selectAntigravityModel(models, 'multi/antigravity/gemini', 'low'), {
    ...models[0],
    effort: 'low',
  });
});
