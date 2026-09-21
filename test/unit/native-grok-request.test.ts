import assert from 'node:assert/strict';
import test from 'node:test';
import type { MessagesRequest } from '../../plugins/multi-core/src/gateway/messages.ts';
import { grokHistoryHash, prepareGrokRequest } from '../../plugins/multi-grok/src/request.ts';

function request(overrides: Partial<MessagesRequest> = {}): MessagesRequest {
  return {
    model: 'multi/grok/grok-4.6',
    messages: [{ role: 'user', content: 'ship the fix' }],
    ...overrides,
  };
}

test('flattens a conversation into one native prompt behind a fixed preamble', () => {
  const prepared = prepareGrokRequest(
    request({
      messages: [
        { role: 'user', content: 'read the config' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'looking' },
            { type: 'tool_use', id: 'call-1', name: 'Read', input: { path: 'a.ts' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'export const a = 1' }],
        },
      ],
      // Claude's own system prompt never reaches a harness that has its own.
      system: 'you are Claude',
    }),
  );

  assert.match(prepared.prompt, /^You are the Grok Build coding agent/);
  assert.equal(prepared.prompt.includes('you are Claude'), false);
  assert.match(prepared.prompt, /user: read the config/);
  assert.match(prepared.prompt, /\[tool use Read\] \{"path":"a\.ts"\}/);
  assert.match(prepared.prompt, /\[tool result call-1\] export const a = 1/);
  assert.equal(prepared.model, 'multi/grok/grok-4.6');
  assert.equal(prepared.inputTokens > 0, true);
  assert.equal(prepareGrokRequest(request(), 'grok-4.5').model, 'grok-4.5');
});

test('drops Claude reasoning but refuses to smuggle it through a user turn', () => {
  const assistantThinking = prepareGrokRequest(
    request({
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'private', signature: 'sig' },
            { type: 'text', text: 'done' },
          ],
        },
      ],
    }),
  );
  assert.match(assistantThinking.prompt, /assistant: done/);
  assert.equal(assistantThinking.prompt.includes('private'), false);

  assert.throws(
    () =>
      prepareGrokRequest(
        request({
          messages: [
            { role: 'user', content: [{ type: 'thinking', thinking: 'private', signature: 's' }] },
          ],
        }),
      ),
    /provider-owned reasoning/,
  );
});

test('refuses request shapes the native CLI cannot honor', () => {
  assert.throws(() => prepareGrokRequest(request({ messages: [] })), /requires a conversation/);
  assert.throws(
    () => prepareGrokRequest(request({ messages: [{ role: 'tool', content: 'x' }] })),
    /valid conversation messages/,
  );
  assert.throws(
    () =>
      prepareGrokRequest(
        request({ output_config: { format: { type: 'json_schema', schema: {} } } }),
      ),
    /strict Messages output schemas/,
  );
  assert.throws(
    () => prepareGrokRequest(request({ tool_choice: { type: 'tool', name: 'Read' } })),
    /native automatic tools/,
  );
  assert.throws(() => prepareGrokRequest(request({ stop_sequences: ['STOP'] })), /stop sequences/);
  assert.throws(
    () => prepareGrokRequest(request({ thinking: { type: 'sometimes' } })),
    /valid thinking configuration/,
  );
  assert.throws(
    () =>
      prepareGrokRequest(
        request({ messages: [{ role: 'user', content: [{ type: 'image', source: undefined }] }] }),
      ),
    /does not support content block image/,
  );
});

/**
 * The reminder blocks a live Claude Code session actually sent to this provider on
 * 2026-09-20, with their measured sizes. They were 95,011 of a 95,852-character
 * prompt whose real message was 841 characters. The catalogues among them, 72,704
 * characters, are dropped; the rest are instructions the CLI reaches no other way
 * and are forwarded. If Claude Code renames one, the matching case here fails
 * rather than the change passing unnoticed.
 */
const CAPTURED_REMINDERS: readonly { size: number; kept: boolean; opening: string }[] = [
  {
    size: 34490,
    kept: false,
    opening: 'The following deferred tools are now available via ToolSearch.',
  },
  { size: 21990, kept: false, opening: '# MCP Server Instructions' },
  {
    size: 12383,
    kept: false,
    opening: 'The following skills are available for use with the Skill tool:',
  },
  { size: 8421, kept: true, opening: 'Codebase and user instructions are shown below.' },
  {
    size: 6031,
    kept: true,
    opening: 'Below are some potentially helpful/relevant pieces of information',
  },
  { size: 3841, kept: false, opening: 'Available agent types for the Agent tool:' },
  {
    size: 2211,
    kept: true,
    opening: "As you answer the user's questions, you can use the following context:",
  },
  { size: 2016, kept: true, opening: 'SessionStart:startup hook success: === REMEMBER ===' },
  { size: 1316, kept: true, opening: '## Auto Mode Active' },
  { size: 859, kept: true, opening: '# Environment' },
];

function reminder(opening: string, size: number): string {
  const width = Math.max(0, size - opening.length);
  // Words, not one long run of a single character: the estimator tokenizes this
  // fixture, and a degenerate run costs seconds of test time for no realism.
  const filler = 'line of reminder body '.repeat(Math.ceil(width / 22)).slice(0, width);
  return `<system-reminder>${'\n'}${opening}${'\n'}${filler}${'\n'}</system-reminder>`;
}

test('Claude catalogues are dropped and instruction reminders are forwarded', () => {
  const content = [
    ...CAPTURED_REMINDERS.map(({ opening, size }) => reminder(opening, size)),
    'ship the fix',
  ].join('\n');
  const prepared = prepareGrokRequest(
    request({ messages: [{ role: 'user', content: [{ type: 'text', text: content }] }] }),
  );

  assert.match(prepared.prompt, /user: .*ship the fix/s);
  for (const { opening, kept } of CAPTURED_REMINDERS) {
    assert.equal(prepared.prompt.includes(opening), kept, opening);
  }
  // Catalogues of Claude's own tools describe capabilities this provider lacks.
  assert.equal(prepared.prompt.includes('ToolSearch'), false);
  assert.equal(prepared.prompt.includes('Skill tool'), false);
  // They remain the bulk of what a live session sent.
  const dropped = CAPTURED_REMINDERS.filter(({ kept }) => !kept);
  assert.equal(
    dropped.reduce((total, { size }) => total + size, 0),
    72704,
  );
});

test('an unrecognised reminder is forwarded rather than dropped', () => {
  // A renamed catalogue only costs tokens, while a renamed instruction block would
  // cost the worker the rules it is meant to follow, so the filter fails that way.
  const text = `${reminder('Some block Claude Code has not shipped yet', 200)}${'\n'}ship it`;
  const prepared = prepareGrokRequest(
    request({ messages: [{ role: 'user', content: [{ type: 'text', text }] }] }),
  );

  assert.match(prepared.prompt, /Some block Claude Code has not shipped yet/);
});

test('a turn that carried only catalogues adds nothing, and an empty one fails', () => {
  const noise = reminder('# MCP Server Instructions', 400);
  const prepared = prepareGrokRequest(
    request({
      messages: [
        { role: 'user', content: [{ type: 'text', text: noise }] },
        { role: 'user', content: 'the real question' },
      ],
    }),
  );
  assert.equal(prepared.prompt.split('user:').length - 1, 1);

  assert.throws(
    () =>
      prepareGrokRequest(
        request({ messages: [{ role: 'user', content: [{ type: 'text', text: noise }] }] }),
      ),
    /conversation with content/,
  );
});

test('request identity follows the prompt, not the reminders around it', () => {
  const withReminder = (opening: string, text: string) => [
    {
      role: 'user',
      content: [{ type: 'text', text: `${reminder(opening, 300)}${'\n'}${text}` }],
    },
  ];
  const question = grokHistoryHash([
    { role: 'user', content: [{ type: 'text', text: `${'\n'}same question` }] },
  ]);
  // A retry carrying only a fresh reminder is the same request; a different key
  // would make it a competing run and pay for the same turn twice. A forwarded
  // instruction block follows the same rule: it reaches the CLI, never identity.
  const instructions = 'Codebase and user instructions are shown below.';
  assert.equal(
    grokHistoryHash(withReminder('# MCP Server Instructions', 'same question')),
    question,
  );
  assert.equal(grokHistoryHash(withReminder(instructions, 'same question')), question);
  assert.notEqual(
    grokHistoryHash(withReminder(instructions, 'same question')),
    grokHistoryHash(withReminder(instructions, 'other question')),
  );
});

test('history identity ignores cache markers and follows real content', () => {
  const plain = grokHistoryHash([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]);
  const cached = grokHistoryHash([
    {
      role: 'user',
      content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }],
    },
  ]);
  assert.equal(cached, plain);

  const nested = grokHistoryHash([
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'call-1',
          content: [{ type: 'text', text: 'out', cache_control: { type: 'ephemeral' } }],
        },
      ],
    },
  ]);
  const nestedPlain = grokHistoryHash([
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call-1', content: [{ type: 'text', text: 'out' }] },
      ],
    },
  ]);
  assert.equal(nested, nestedPlain);
  assert.notEqual(
    plain,
    grokHistoryHash([{ role: 'user', content: [{ type: 'text', text: 'hello!' }] }]),
  );
});
