import { expect, mock, test } from 'claude-code/testing';

test('turn.step telemetry preserves core model, effort and streamed chunks', async ($, on) => {
  mock.env(on, {});
  on('session.id', () => ({ value: 's' }));
  on('turn.step', async function* (_$, event) {
    expect(event.model).toBe('multi/openai/gpt-6-astra');
    expect(event.effort).toBe('high');
    yield { kind: 'text', index: 0, text: 'core response' };
    return {
      turnId: event.turnId,
      index: event.index,
      answer: 'core response',
      toolUses: [],
      stopReason: 'end_turn',
      usage: null,
    };
  });
  const chunks: string[] = [];
  for await (const chunk of $.turn.step({
    turnId: 't',
    index: 0,
    model: 'multi/openai/gpt-6-astra',
    effort: 'high',
    messageCount: 1,
  })) {
    if (chunk.kind === 'text') {
      chunks.push(chunk.text);
    }
  }
  expect(chunks).toEqual(['core response']);
});
