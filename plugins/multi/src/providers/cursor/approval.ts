import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { ApprovalAction, ApprovalContext, ApprovalVerdict } from '../../gateway/approval.ts';
import { NativeApprovalBridge } from '../../gateway/approval.ts';
import type { CursorModelOption } from './models.ts';
import { assertCursorReviewSdk } from './review-worker.ts';

interface ReviewInput {
  selection: CursorModelOption['selection'];
  cwd: string;
  action: ApprovalAction;
  context: ApprovalContext;
}

async function runReview(input: ReviewInput, signal: AbortSignal): Promise<unknown> {
  const payload = JSON.stringify(input);
  if (Buffer.byteLength(payload) > 1048576) {
    throw new Error('Cursor review context exceeds 1 MiB');
  }
  try {
    const child = promisify(execFile)(
      process.execPath,
      [fileURLToPath(new URL('./review-worker.ts', import.meta.url))],
      { cwd: input.cwd, signal, timeout: 60000, maxBuffer: 65536 },
    );
    // Evidence belongs on stdin, never in process arguments or shell commands.
    child.child.stdin?.on('error', () => {});
    child.child.stdin?.end(payload);
    const { stdout } = await child;
    return JSON.parse(stdout);
  } catch {
    signal.throwIfAborted();
    // SDK/subprocess diagnostics can contain evidence or credentials.
    throw new Error('Cursor native review failed; no approval was returned');
  }
}

/** Only obtains a native verdict. Claude Code owns the pending action's execution. */
export async function createCursorApproval(
  options: CursorModelOption[],
  cwd: string,
  review: (input: ReviewInput, signal: AbortSignal) => Promise<unknown> = runReview,
) {
  await assertCursorReviewSdk();
  const selections = new Map(options.map((option) => [option.model, option.selection]));
  return new NativeApprovalBridge(async (action, signal, context) => {
    const selection = context && selections.get(context.model);
    if (!context?.model.startsWith('multi/cursor/') || !selection) {
      throw new Error('Cursor review requires the originating Cursor agent and account model');
    }
    if (context.worker && !context.rootRequest) {
      throw new Error('Worker review is missing root authorization context');
    }
    if (Object.keys(action.action).length !== 1 || typeof action.action.Bash !== 'string') {
      throw new Error('Cursor native review currently supports Bash actions only');
    }
    const reviewCwd = context.cwd ?? cwd;
    if (!path.isAbsolute(reviewCwd)) {
      throw new Error('Cursor review requires an absolute working directory');
    }
    signal.throwIfAborted();
    const verdict = await review({ selection, cwd: reviewCwd, action, context }, signal);
    return nativeVerdict(verdict);
  });
}

function nativeVerdict(verdict: unknown): ApprovalVerdict {
  if (
    !verdict ||
    typeof verdict !== 'object' ||
    !('model' in verdict) ||
    verdict.model !== 'cursor-auto-review' ||
    !('outcome' in verdict) ||
    (verdict.outcome !== 'allow' && verdict.outcome !== 'deny')
  ) {
    throw new Error('Cursor native reviewer returned no valid verdict');
  }
  return { model: 'cursor-auto-review', outcome: verdict.outcome };
}
