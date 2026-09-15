import { expect, mock, test } from 'claude-code/testing';

test('registers display tools and posts a session snapshot', async ($, on) => {
  mock.env(on, {
    MULTI_GATEWAY_TOKEN: 'test-token',
    MULTI_MOD_GATEWAY_URL: 'http://127.0.0.1:4000',
  });
  on('session.start', () => ({ cwd: '/tmp' }));
  const requests: string[] = [];
  on('session.id', () => ({ value: 'test-session' }));
  on('session.cwd', () => ({ value: '/tmp' }));
  on('session.model', () => ({ value: 'multi/cursor/auto' }));
  on('tool.register', (_$, event) => ({ value: { tool: `mcp__multi-core__${event.name}` } }));
  on('tool.call', () => ({ value: { result: { type: 'text', text: 'stub' } } }));
  on('ui.status', () => ({ value: undefined }));
  on('ui.invalidate', () => ({ value: undefined }));
  on('http.fetch', (_$, event) => {
    requests.push(event.url);
    return {
      value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ accepted: true }) },
    };
  });
  await $.session.start({ cwd: '/tmp', model: 'multi/cursor/auto' });
  expect(requests).toContain('http://127.0.0.1:4000/multi/mod/session');
});

test('mod is dormant without launcher environment', async ($, on) => {
  mock.env(on, {});
  on('session.start', () => ({ cwd: '/tmp' }));
  on('session.id', () => ({ value: 'inactive-session' }));
  on('session.cwd', () => ({ value: '/tmp' }));
  on('session.model', () => ({ value: 'claude-sonnet' }));
  let fetches = 0;
  on('http.fetch', () => {
    fetches += 1;
    return { value: { status: 200, ok: true, headers: {}, text: '{}' } };
  });
  await $.session.start({ cwd: '/tmp', model: 'claude-sonnet' });
  expect(fetches).toBe(0);
});

test('display tool checks allow and calls answer from the streamed block input', async ($, on) => {
  mock.env(on, {
    MULTI_GATEWAY_TOKEN: 'test-token',
    MULTI_MOD_GATEWAY_URL: 'http://127.0.0.1:4000',
  });
  on('session.start', () => ({ cwd: '/tmp' }));
  on('session.id', () => ({ value: 'call-session' }));
  on('session.cwd', () => ({ value: '/tmp' }));
  on('session.model', () => ({ value: 'multi/cursor/auto' }));
  on('tool.register', (_$, event) => ({ value: { tool: `mcp__multi-core__${event.name}` } }));
  let fetches = 0;
  on('http.fetch', () => {
    fetches += 1;
    return {
      value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ accepted: true }) },
    };
  });
  await $.session.start({ cwd: '/tmp', model: 'multi/cursor/auto' });
  const before = fetches;
  const check = await $.tool.check({ tool: 'mcp__multi-core__cursor_read' });
  expect(check.decision).toBe('allow');
  const result = await $.tool.call({
    tool: 'mcp__multi-core__cursor_read',
    description: 'README.md',
    toolUseId: 'action',
    output: 'streamed output',
    isError: false,
  } as never);
  expect(result.result.text).toBe('streamed output');
  expect(result.result.is_error).toBe(false);
  expect(fetches).toBe(before);
});
