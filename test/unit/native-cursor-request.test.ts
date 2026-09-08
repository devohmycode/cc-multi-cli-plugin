import assert from 'node:assert/strict';
import test from 'node:test';
import type { MessagesRequest } from '../../plugins/multi/src/gateway/messages.ts';
import { prepareCursorRequest } from '../../plugins/multi/src/providers/cursor/request.ts';
import { estimateTextTokens } from '../../plugins/multi/src/providers/openai/tokens.ts';

const body: MessagesRequest = {
  model: 'multi/cursor/test',
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Describe the attached image.' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'cGl4ZWxz' } },
      ],
    },
  ],
  tools: [
    {
      name: 'PreserveSchema',
      description: 'Claude tool schema is context, not native SDK tool configuration.',
      input_schema: { type: 'object', properties: { nested: { type: 'array' } } },
    },
  ],
};

test('native Cursor prepares media and counts only the prompt and image allowance', () => {
  const prepared = prepareCursorRequest(body);
  assert.deepEqual(prepared.prompt.images, [{ data: 'cGl4ZWxz', mimeType: 'image/png' }]);
  assert.match(prepared.prompt.text ?? '', /Attached image 1/);
  assert.match(prepared.prompt.text ?? '', /Use your native tools and permissions/);
  assert.doesNotMatch(prepared.prompt.text ?? '', /PreserveSchema|custom-user-tools/);
  assert.equal(prepared.inputTokens, estimateTextTokens(prepared.prompt.text ?? '') + 4096);
});

test('Cursor request preparation reuses shared image validation and rejects PDFs', () => {
  const remote = prepareCursorRequest({
    ...body,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Inspect this.' },
          { type: 'image', source: { type: 'url', url: 'https://example.com/image.png' } },
        ],
      },
    ],
  });
  assert.deepEqual(remote.prompt.images, [{ url: 'https://example.com/image.png' }]);
  assert.throws(() =>
    prepareCursorRequest({
      ...body,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: 'cGRm' },
            },
          ],
        },
      ],
    }),
  );
});

test('native Cursor rejects unsupported Messages controls', () => {
  for (const control of [
    { tool_choice: { type: 'none' } },
    { tool_choice: { type: 'any' } },
    { stop_sequences: ['STOP'] },
    { output_format: { type: 'json_schema', schema: {} } },
  ]) {
    assert.throws(() => prepareCursorRequest({ ...body, ...control }));
  }
});

test('native Cursor estimates shrink with supplied context and preserve completed tool history', () => {
  const short = prepareCursorRequest({
    ...body,
    messages: [{ role: 'user', content: 'Continue.' }],
  });
  const expanded = prepareCursorRequest({
    ...body,
    messages: [{ role: 'user', content: 'Disposable context detail. '.repeat(2000) }],
  });
  assert(expanded.inputTokens > short.inputTokens + 5000);
  const history = prepareCursorRequest({
    ...body,
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'old', name: 'Read', input: { path: 'fixture.txt' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'old', content: 'Already inspected' }],
      },
    ],
  });
  assert.match(history.prompt.text ?? '', /Already inspected/);
  assert.match(history.prompt.text ?? '', /never repeat them/);
});
