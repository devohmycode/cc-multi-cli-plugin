import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentCatalog } from '../../plugins/multi-core/src/gateway/agent-catalog.ts';
import type { MessagesRequest } from '../../plugins/multi-core/src/gateway/messages.ts';

const workers = {
  'openai-native': {
    model: 'multi/openai/gpt-6-astra',
    description: 'Astra',
    tools: ['Read', 'Bash'],
  },
  'openai-native-high': {
    model: 'multi/openai/gpt-6-astra',
    description: 'Astra high',
    tools: ['Read', 'Bash'],
  },
  'zen-other': { model: 'multi/zen/other', description: 'Other', tools: ['Read'] },
};
const rows = Object.entries(workers).map(
  ([name, worker]) => `- ${name}: ${worker.description} (Tools: ${worker.tools.join(', ')})`,
);
const custom = '- custom: User-owned worker (Tools: Read)';
const listing = (heading = 'Available agent types for the Agent tool:') =>
  `<system-reminder>\nBefore\n${heading}\n${[...rows, custom].join('\n')}\n\nAfter\n</system-reminder>`;
const request = (content: string): MessagesRequest => ({ messages: [{ role: 'user', content }] });

test('catalog advertises one worker per picker model without mutating registration or history', () => {
  const original = structuredClone(workers);
  const catalog = new AgentCatalog(workers, ['multi/openai/gpt-6-astra']);
  for (const heading of [
    'Available agent types for the Agent tool:',
    'New agent types are now available for the Agent tool:',
  ]) {
    const body = request(listing(heading));
    const before = structuredClone(body);
    const compacted = catalog.compact(body);
    assert.deepEqual(body, before);
    const expected = listing(heading).replace(`${rows[1]}\n`, '').replace(`${rows[2]}\n`, '');
    assert.deepEqual(compacted, request(expected));
    assert.strictEqual(catalog.compact(compacted), compacted);
  }
  assert.deepEqual(workers, original);
});

test('catalog preserves ordinary text, custom overrides, tool results and unknown formats', () => {
  const catalog = new AgentCatalog(workers, []);
  for (const content of [
    rows.join('\n'),
    listing().replaceAll('Agent tool:', 'Future tool:'),
    listing().replaceAll('Astra', 'Custom Astra').replace(rows[2], custom),
  ]) {
    const body = request(content);
    assert.strictEqual(catalog.compact(body), body);
  }
  const body: MessagesRequest = {
    system: listing(),
    messages: [
      { role: 'assistant', content: listing() },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: listing() }] },
    ],
  };
  assert.strictEqual(catalog.compact(body), body);
});

test('catalog handles bare native system announcements without changing ordinary user text', () => {
  const catalog = new AgentCatalog(workers, ['multi/openai/gpt-6-astra']);
  const text = `Available agent types for the Agent tool:\n${[...rows, custom].join('\n')}\n\nKeep concurrency instructions.`;
  const body: MessagesRequest = {
    messages: [
      { role: 'system', content: text },
      { role: 'user', content: text },
    ],
  };
  assert.deepEqual(catalog.compact(body), {
    messages: [
      { role: 'system', content: text.replace(`${rows[1]}\n`, '').replace(`${rows[2]}\n`, '') },
      { role: 'user', content: text },
    ],
  });
});

test('catalog compacts text blocks only and follows a changed picker selection', () => {
  const catalog = new AgentCatalog(workers, ['multi/zen/other']);
  const body: MessagesRequest = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: listing(), cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'Keep user instructions' },
        ],
      },
    ],
  };
  assert.deepEqual(catalog.compact(body), {
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: listing().replace(`${rows[0]}\n`, '').replace(`${rows[1]}\n`, ''),
            cache_control: { type: 'ephemeral' },
          },
          { type: 'text', text: 'Keep user instructions' },
        ],
      },
    ],
  });
});
