import assert from 'node:assert/strict';
import test from 'node:test';
import type { InteractionUpdate } from '@cursor/sdk';
import {
  cursorRowObservation,
  formatCursorProgress,
} from '../../plugins/multi-cursor/src/progress.ts';

const shell = {
  type: 'shell',
  args: { command: 'printf hello', workingDirectory: '/workspace' },
} satisfies Extract<InteractionUpdate, { type: 'tool-call-started' }>['toolCall'];

test('formats public native tool activity without producing Claude tool calls', () => {
  const started = {
    type: 'tool-call-started',
    callId: 'shell-1',
    modelCallId: 'model-1',
    toolCall: shell,
  } satisfies InteractionUpdate;
  const write = {
    type: 'tool-call-started',
    callId: 'write-1',
    modelCallId: 'model-1',
    toolCall: { type: 'write', args: { path: 'notes.txt', fileText: 'private content' } },
  } satisfies InteractionUpdate;
  assert.equal(formatCursorProgress(started), '[Cursor] Shell: printf hello started.');
  assert.equal(formatCursorProgress(write), '[Cursor] write: notes.txt started.');
});

test('reports completed and explicitly denied native tools without claiming approval', () => {
  const completed = {
    type: 'tool-call-completed',
    callId: 'shell-1',
    modelCallId: 'model-1',
    toolCall: {
      ...shell,
      result: {
        status: 'success',
        value: { exitCode: 0, signal: '', stdout: 'hello', stderr: '', executionTime: 12 },
      },
    },
  } satisfies InteractionUpdate;
  const denied = {
    type: 'tool-call-completed',
    callId: 'shell-2',
    modelCallId: 'model-1',
    toolCall: { ...shell, result: { status: 'error', error: 'Permission denied' } },
  } satisfies InteractionUpdate;
  assert.equal(
    formatCursorProgress(completed),
    '[Cursor] Shell completed (exit 0). (12 ms)\nstdout:\n```text\nhello\n```',
  );
  assert.equal(formatCursorProgress(denied), '[Cursor] Shell: printf hello was denied.');
});

test('shows compaction lifecycle and ignores hidden reasoning updates', () => {
  const thinking = {
    type: 'thinking-delta',
    text: 'private reasoning',
  } satisfies InteractionUpdate;
  assert.equal(formatCursorProgress({ type: 'summary-started' }), '[Cursor] Compacting context…');
  assert.equal(formatCursorProgress({ type: 'summary-completed' }), '[Cursor] Context compacted.');
  assert.equal(formatCursorProgress(thinking), undefined);
});

test('sanitizes terminal controls in public command and path summaries', () => {
  const command = {
    type: 'tool-call-started',
    callId: 'shell-control',
    modelCallId: 'model-1',
    toolCall: { type: 'shell', args: { command: 'printf ok\u001b[2J\nnext' } },
  } satisfies InteractionUpdate;
  const file = {
    type: 'tool-call-started',
    callId: 'write-control',
    modelCallId: 'model-1',
    toolCall: { type: 'write', args: { path: 'safe\r\nname.txt', fileText: 'private' } },
  } satisfies InteractionUpdate;
  const commandProgress = formatCursorProgress(command);
  const fileProgress = formatCursorProgress(file);
  assert.equal(commandProgress, '[Cursor] Shell: printf ok next started.');
  assert.equal(fileProgress, '[Cursor] write: safe name.txt started.');
  assert.doesNotMatch(`${commandProgress}${fileProgress}`, /[\p{Cc}]/u);
});

test('removes complete terminal title sequences from public command summaries', () => {
  const command = {
    type: 'tool-call-started',
    callId: 'shell-title',
    modelCallId: 'model-1',
    toolCall: { type: 'shell', args: { command: 'printf before\u001b]0;private\u0007after' } },
  } satisfies InteractionUpdate;
  assert.equal(formatCursorProgress(command), '[Cursor] Shell: printf beforeafter started.');
});

test('renders bounded edit diffs without allowing terminal controls or fence escapes', () => {
  const update = {
    type: 'tool-call-completed',
    callId: 'edit-1',
    modelCallId: 'model-1',
    toolCall: {
      type: 'edit',
      args: { path: 'notes.txt' },
      result: {
        status: 'success',
        value: {
          linesAdded: 1,
          linesRemoved: 0,
          diffString: `+hello\u001b[2J\n\`\`\`\n+world\u202e\n${'+line\n'.repeat(20)}`,
        },
      },
    },
  } satisfies InteractionUpdate;
  const result = formatCursorProgress(update) ?? '';
  assert.match(result, /^\[Cursor\] edit: notes.txt completed\. \(\+1 -0 lines\)/);
  assert.match(result, /\n````diff\n\+hello\n```\n\+world/);
  assert.ok(result.endsWith('\n… (truncated)\n````'));
  assert.doesNotMatch(result.replaceAll('\n', ''), /[\p{Cc}\p{Cf}]/u);
  assert.ok(result.split('\n').length <= 16);
});

test('bounds each shell stream and preserves exit status for unsuccessful commands', () => {
  const update = {
    type: 'tool-call-completed',
    callId: 'shell-output',
    modelCallId: 'model-1',
    toolCall: {
      ...shell,
      result: {
        status: 'success',
        value: {
          exitCode: 7,
          signal: '',
          stdout: 'x'.repeat(2000),
          stderr: '\u001b]0;hidden\u0007failure\u0000',
          executionTime: 1200,
        },
      },
    },
  } satisfies InteractionUpdate;
  const result = formatCursorProgress(update) ?? '';
  assert.ok(result.startsWith('[Cursor] Shell completed (exit 7). (1200 ms)'));
  assert.match(result, /stdout:\n```text\nx{1200}\n… \(truncated\)\n```/);
  assert.match(result, /stderr:\n```text\nfailure\n```$/);
  assert.doesNotMatch(result.replaceAll('\n', ''), /hidden|[\p{Cc}]/u);
});

test('omits unavailable edit details rather than inventing counts or diffs', () => {
  assert.equal(
    formatCursorProgress({
      type: 'tool-call-completed',
      callId: 'edit-empty',
      modelCallId: 'model-1',
      toolCall: {
        type: 'edit',
        args: { path: 'notes.txt' },
        result: { status: 'success', value: {} },
      },
    }),
    '[Cursor] edit: notes.txt completed.',
  );
});

test('display outcomes distinguish nonzero shell exit from successful transport', () => {
  const update = {
    type: 'tool-call-completed',
    callId: 'shell-1',
    modelCallId: 'model-1',
    toolCall: {
      ...shell,
      result: {
        status: 'success',
        value: { exitCode: 1, signal: '', stdout: '', stderr: 'failed', executionTime: 1 },
      },
    },
  } satisfies InteractionUpdate;
  const observed = cursorRowObservation(update);
  assert.ok(observed?.type === 'completed');
  assert.equal(observed.error, true);
  assert.match(observed.text, /exit 1/);
  assert.equal(cursorRowObservation({ type: 'thinking-delta', text: 'hidden' }), undefined);
});
