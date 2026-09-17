import { expect, test } from 'claude-code/testing';
import { compactionModel, register } from '../compact.ts';

test('registers the compaction boundary hook', () => {
  expect(typeof register).toBe('function');
});

test('compaction with an unknown generation skips without calling core', async ($, on) => {
  on('env.get', () => ({ value: 'configured' }));
  on('session.model', () => ({ value: 'multi/cursor/auto' }));
  on('session.id', () => ({ value: 's' }));
  on('http.fetch', () => ({ value: { ok: false, status: 409, headers: {}, text: '{}' } }));
  let core = false;
  on('session.compact', () => {
    core = true;
    return { skip: 'core' };
  });
  const result = await $.session.compact({});
  expect(result.skip).toBe('Multi compaction policy generation is unavailable.');
  expect(core).toBe(false);
});

test('a stale digest falls through to core compaction', async ($, on) => {
  on('env.get', () => ({ value: 'configured' }));
  on('session.model', () => ({ value: 'multi/cursor/auto' }));
  on('session.id', () => ({ value: 's' }));
  on('http.fetch', (_$, event) => ({
    value: {
      ok: true,
      status: 200,
      headers: {},
      text: event.url.includes('/mode?') ? '{"generation":1}' : '{"allow":true}',
    },
  }));
  on('session.compact', () => ({ skip: 'core fallback' }));
  const result = await $.session.compact({});
  expect(result.skip).toBe('core fallback');
});

test('failed fallback authorization skips instead of running core with ordinary tools', async ($, on) => {
  on('env.get', () => ({ value: 'configured' }));
  on('session.model', () => ({ value: 'multi/cursor/auto' }));
  on('session.id', () => ({ value: 's' }));
  on('http.fetch', (_$, event) => ({
    value: { ok: event.url.includes('/mode?'), status: 200, headers: {}, text: '{"generation":1}' },
  }));
  let core = false;
  on('session.compact', () => {
    core = true;
    return { skip: 'core' };
  });
  const result = await $.session.compact({});
  expect(result.skip).toBe('Multi tool-free compaction authorization was not acknowledged.');
  expect(core).toBe(false);
});

test('ready authenticated summary replaces the transcript without calling core', async ($, on) => {
  on('env.get', () => ({ value: 'configured' }));
  on('session.model', () => ({ value: 'multi/cursor/auto' }));
  on('session.id', () => ({ value: 's' }));
  on('http.fetch', (_$, event) => ({
    value: {
      ok: true,
      status: 200,
      headers: {},
      text: event.url.includes('/mode?')
        ? '{"generation":1}'
        : '{"allow":true,"messages":[{"role":"user","text":"summary","toolUses":[]}]}',
    },
  }));
  let core = false;
  on('session.compact', () => {
    core = true;
    return { skip: 'core' };
  });
  const result = await $.session.compact({});
  expect(result.messages?.[0].text).toBe('summary');
  expect(core).toBe(false);
});

for (const model of [
  'claude-opus-4-6',
  'claude-sonnet-5',
  'opus',
  'sonnet',
  'multi/openai/gpt-6-astra',
  'multi/zen/glm-5',
]) {
  test(`native ${model} compacts without consulting the gateway`, async ($, on) => {
    on('session.model', () => ({ value: model }));
    on('env.get', () => ({ value: 'configured' }));
    let fetches = 0;
    on('http.fetch', () => {
      fetches += 1;
      return { value: { ok: false, status: 409, headers: {}, text: '{}' } };
    });
    on('session.compact', () => ({ skip: 'native compaction reached' }));
    const result = await $.session.compact({});
    expect(result.skip).toBe('native compaction reached');
    expect(fetches).toBe(0);
  });
}

test('compaction uses the child model without borrowing its parent model', async ($, on) => {
  on('session.model', () => ({ value: 'multi/cursor/auto' }));
  const models = new Map([
    ['claude-child', 'claude-sonnet-5'],
    ['external-child', 'multi/cursor/auto'],
  ]);
  expect(await compactionModel($, 'claude-child', models)).toBe('claude-sonnet-5');
  expect(await compactionModel($, 'external-child', models)).toBe('multi/cursor/auto');
  expect(await compactionModel($, 'unknown-child', models)).toBe(undefined);
});
