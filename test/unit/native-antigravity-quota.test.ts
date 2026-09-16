import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  formatAntigravityQuota,
  parseAntigravityCommandEnvelope,
  readAntigravityAccountStatus,
} from '../../plugins/multi-antigravity/src/quota.ts';

const usageEnvelope = {
  command: {
    name: 'usage',
    data: {
      groups: [
        {
          name: 'Gemini',
          buckets: [{ id: 'weekly', name: 'Weekly', remaining_fraction: 0.75 }],
        },
      ],
    },
  },
};

function fakeChild(output?: string, code = 0) {
  const child = new ChildProcess();
  child.stdout = new PassThrough();
  if (output !== undefined) {
    queueMicrotask(() => {
      child.stdout?.emit('data', output);
      child.emit('close', code);
    });
  }
  return child;
}

test('native quota commands preserve quota when credits fail and honor Windows invocation', async () => {
  const commands: string[][] = [];
  const status = await readAntigravityAccountStatus({
    executable: process.execPath,
    platform: 'win32',
    spawn: (_command, args, options) => {
      const argv = Array.isArray(args) ? [...args] : [];
      commands.push(argv);
      assert.equal(options?.detached, false);
      assert.equal(options?.shell, undefined);
      return argv.includes('/usage')
        ? fakeChild(JSON.stringify(usageEnvelope))
        : fakeChild('{}', 1);
    },
  });
  assert.deepEqual(commands, [
    ['-p', '/usage', '--output-format', 'json'],
    ['-p', '/credits', '--output-format', 'json'],
  ]);
  const view = formatAntigravityQuota(status);
  assert.match(view.summary, /75% remaining/);
  assert(view.details.includes('AI credits: unavailable'));
  assert(
    formatAntigravityQuota({ ...status, remaining_credits: 0 }).details.includes('AI credits: 0'),
  );
});

test('native quota rejects malformed JSON, failed exit, overflow and unresponsive subprocesses', async () => {
  for (const [output, code, error] of [
    ['{broken', 0, /invalid account status JSON/],
    [JSON.stringify(usageEnvelope), 1, /exited with code 1/],
    ['x'.repeat(2 * 1024 * 1024 + 1), 0, /output limit/],
    [undefined, 0, /timed out/],
  ] as const) {
    await assert.rejects(
      readAntigravityAccountStatus({
        executable: process.execPath,
        timeoutMs: 10,
        spawn: () => fakeChild(output, code),
      }),
      error,
    );
  }
});

test('parses native usage groups and reset metadata', () => {
  const parsed = parseAntigravityCommandEnvelope({
    command: {
      name: 'usage',
      data: {
        groups: [
          {
            name: 'Gemini Models',
            buckets: [
              {
                id: 'gemini-5h',
                name: 'Five Hour Limit Remaining',
                remaining_fraction: 0.75,
                reset_time: '2026-09-17T02:54:25Z',
              },
            ],
          },
        ],
      },
    },
  });
  assert.deepEqual(parsed.quota?.[0]?.buckets[0], {
    id: 'gemini-5h',
    name: 'Five Hour Limit Remaining',
    remaining_fraction: 0.75,
    reset_time: '2026-09-17T02:54:25Z',
  });
});

test('parses native credits without exposing unrelated command data', () => {
  assert.deepEqual(
    parseAntigravityCommandEnvelope({
      command: {
        name: 'credits',
        data: { remaining_credits: 12, upgrade_uri: 'https://example.test' },
      },
    }),
    { remaining_credits: 12 },
  );
});

test('rejects malformed quota buckets instead of treating them as empty usage', () => {
  const parsed = parseAntigravityCommandEnvelope({
    command: { name: 'usage', data: { groups: [{ name: 'broken', buckets: [{ id: 'x' }] }] } },
  });
  assert.deepEqual(parsed, {});
});
