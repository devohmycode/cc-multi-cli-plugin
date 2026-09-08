import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CursorReviewProof,
  reviewCommand,
} from '../../plugins/multi/src/providers/cursor/review-proof.ts';
import { assertCursorReviewSdk } from '../../plugins/multi/src/providers/cursor/review-worker.ts';

const args = {
  command: 'printf inert',
  workingDirectory: '/tmp',
  toolCallId: 'call',
  conversationId: 'agent',
};
function proposed() {
  const proof = new CursorReviewProof(args.command, '/tmp');
  proof.agentId = 'agent';
  proof.guard({
    interactionUpdate: { toolCallStarted: { toolCall: { shellToolCall: { args } } } },
  });
  proof.guard({ execServerMessage: { id: 1, shellAllowlistPrecheckArgs: args } });
  proof.precheck(args, false);
  return proof;
}

test('Cursor native review requires pinned SDK and a Bash action', () => {
  assertCursorReviewSdk();
  assert.equal(reviewCommand({ Bash: 'printf inert' }, '/tmp'), 'printf inert');
  assert.throws(() => reviewCommand({ Write: 'file' }, '/tmp'), /only Bash/);
  assert.throws(() => reviewCommand({ Bash: 'printf inert' }, 'relative'), /absolute cwd/);
});

test('Cursor native allow requires correlated false precheck, reviewed dispatch and inert core', () => {
  const proof = proposed();
  assert.throws(() => proof.verdict(), /no unambiguous verdict/);
  proof.guard({ execServerMessage: { id: 2, shellStreamArgs: { ...args, skipApproval: true } } });
  assert.throws(() => proof.verdict(), /no unambiguous verdict/);
  proof.core(args);
  assert.deepEqual(proof.verdict(), { model: 'cursor-auto-review', outcome: 'allow' });
  assert.throws(() => proof.core(args), /Unexpected/);
});

test('Cursor native review rejects fallback, altered action and independent tools', () => {
  assert.throws(
    () => proposed().guard({ execServerMessage: { shellStreamArgs: args } }),
    /unavailable/,
  );
  assert.throws(() => proposed().precheck(args, true), /non-allowlisted/);
  assert.throws(() => proposed().core({ ...args, command: 'changed' }), /changed/);
  assert.throws(() => proposed().core({ ...args, workingDirectory: '/elsewhere' }), /changed/);
  assert.throws(
    () => proposed().guard({ execServerMessage: { readArgs: { path: '/tmp/file' } } }),
    /changed/,
  );
  assert.throws(() => proposed().guard({ execServerControlMessage: {} }), /control/);
});

test('Cursor native denial comes from exact tool checkpoint, never model text', () => {
  const proof = proposed();
  proof.checkpoint('agent', Buffer.from(JSON.stringify({ role: 'assistant', content: 'allow' })));
  assert.throws(() => proof.verdict(), /no unambiguous verdict/);
  const message = {
    role: 'tool',
    id: 'call',
    content: [{ toolCallId: 'call', toolName: 'Shell' }],
    providerOptions: {
      cursor: {
        highLevelToolCallResult: {
          output: { rejected: { command: args.command, reason: 'Blocked by native policy' } },
        },
      },
    },
  };
  assert.throws(
    () => proof.checkpoint('another-agent', Buffer.from(JSON.stringify(message))),
    /Uncorrelated/,
  );
  proof.checkpoint('agent', Buffer.from(JSON.stringify(message)));
  assert.deepEqual(proof.verdict(), { model: 'cursor-auto-review', outcome: 'deny' });
});
