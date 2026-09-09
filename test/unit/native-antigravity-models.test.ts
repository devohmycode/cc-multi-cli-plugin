import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseAntigravityModels,
  selectAntigravityModel,
} from '../../plugins/multi/src/providers/antigravity/models.ts';

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
