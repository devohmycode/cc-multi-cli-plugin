import { expect, test } from 'claude-code/testing';
import { register } from '../workers.ts';

test('registers the worker admission hook', () => {
  expect(typeof register).toBe('function');
});

test('agent.offer hides an unsupported worker before dispatch', async ($, on) => {
  on('env.get', (_$, event) => ({
    value: event.name === 'MULTI_GATEWAY_TOKEN' ? 'token' : 'http://127.0.0.1:4000',
  }));
  on('session.id', () => ({ value: 's' }));
  on('session.cwd', () => ({ value: '/workspace' }));
  on('http.fetch', () => ({
    value: { ok: true, status: 200, headers: {}, text: '{"isOffered":false}' },
  }));
  on('agent.offer', () => ({ isOffered: true }));
  const result = await $.agent.offer({
    agent: 'unknown',
    description: 'unknown',
    source: 'plugin',
    provider: { plugin: 'engine', tier: 'core' },
  });
  expect(result.isOffered).toBe(false);
});

test('agent.offer preserves a known catalog worker', async ($, on) => {
  on('env.get', (_$, event) => ({
    value: event.name === 'MULTI_GATEWAY_TOKEN' ? 'token' : 'http://127.0.0.1:4000',
  }));
  on('session.id', () => ({ value: 's' }));
  on('session.cwd', () => ({ value: '/workspace' }));
  on('http.fetch', () => ({
    value: { ok: true, status: 200, headers: {}, text: '{"isOffered":true}' },
  }));
  on('agent.offer', () => ({ isOffered: true }));
  const result = await $.agent.offer({
    agent: 'cursor',
    description: 'known',
    source: 'plugin',
    provider: { plugin: 'engine', tier: 'core' },
  });
  expect(result.isOffered).toBe(true);
});

test('worker spawn is denied when gateway admission is unavailable', async ($, on) => {
  on('env.get', () => ({ value: 'configured' }));
  on('session.id', () => ({ value: 's' }));
  on('session.cwd', () => ({ value: '/workspace' }));
  on('http.fetch', () => ({ value: { ok: false, status: 503, headers: {}, text: '{}' } }));
  let started = false;
  on('agent.spawn', () => {
    started = true;
    return { model: 'm', agentId: 'worker' };
  });
  const result = await $.agent.spawn({ prompt: 'task', subagentType: 'cursor' });
  expect(typeof result.deny).toBe('string');
  expect(started).toBe(false);
});
