import path from 'node:path';
import type { ApprovalVerdict } from '../../gateway/approval.ts';

export function reviewRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Cursor review record');
  }
  return value as Record<string, unknown>;
}

/** One isolated native proposal; model prose is never a verdict. */
export class CursorReviewProof {
  agentId = '';
  private callId?: string;
  private started = false;
  private prechecked = false;
  private dispatched = false;
  private reachedCore = false;
  private denied = false;

  private readonly command: string;
  private readonly cwd: string;

  constructor(command: string, cwd: string) {
    this.command = command;
    this.cwd = cwd;
  }

  private action(value: unknown) {
    const args = reviewRecord(value);
    if (
      args.command !== this.command ||
      typeof args.toolCallId !== 'string' ||
      !args.toolCallId ||
      (args.workingDirectory !== undefined &&
        args.workingDirectory !== '' &&
        args.workingDirectory !== this.cwd) ||
      (this.callId !== undefined && this.callId !== args.toolCallId)
    ) {
      throw new Error('Cursor reviewer changed the pending shell action');
    }
    this.callId = args.toolCallId;
    return args;
  }

  guard(value: unknown) {
    const wire = reviewRecord(value);
    if (wire.execServerControlMessage) {
      throw new Error('Cursor review cannot control external execution');
    }
    if (wire.execServerMessage) {
      this.execution(reviewRecord(wire.execServerMessage));
    }
    if (wire.interactionUpdate) {
      const update = reviewRecord(wire.interactionUpdate);
      if (update.toolCallStarted) {
        const call = reviewRecord(reviewRecord(update.toolCallStarted).toolCall);
        const shell = reviewRecord(call.shellToolCall);
        const args = this.action(shell.args);
        if (this.started || args.conversationId !== this.agentId) {
          throw new Error('Cursor review proposed multiple or uncorrelated actions');
        }
        this.started = true;
      }
    }
  }

  private execution(message: Record<string, unknown>) {
    const ignored = ['id', 'execId', 'spanContext', 'machineId', 'acceptHookAdditionalContexts'];
    const cases = Object.keys(message).filter((key) => !ignored.includes(key));
    if (cases.length !== 1) {
      throw new Error('Unknown Cursor review execution envelope');
    }
    const kind = cases[0];
    if (kind === 'requestContextArgs') {
      return;
    }
    const args = this.action(message[kind]);
    if (kind === 'shellAllowlistPrecheckArgs') {
      return;
    }
    if (
      !['shellArgs', 'shellStreamArgs'].includes(kind) ||
      this.dispatched ||
      !this.prechecked ||
      args.skipApproval !== true ||
      args.conversationId !== this.agentId
    ) {
      throw new Error('Cursor native reviewer unavailable or unexpected execution');
    }
    this.dispatched = true;
  }

  precheck(value: unknown, allowlisted: unknown) {
    this.action(value);
    if (this.prechecked || allowlisted !== false) {
      throw new Error('Cursor review requires one non-allowlisted action');
    }
    this.prechecked = true;
  }

  core(value: unknown) {
    const args = this.action(value);
    if (!this.dispatched || this.reachedCore || args.workingDirectory !== this.cwd) {
      throw new Error('Unexpected Cursor native core dispatch');
    }
    this.reachedCore = true;
  }

  checkpoint(agentId: string, data: Uint8Array) {
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(data).toString('utf8'));
    } catch {
      return; // Checkpoint storage also contains non-JSON binary protocol blobs.
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return;
    }
    const message = reviewRecord(value);
    if (message.role !== 'tool') {
      return;
    }
    const cursor = reviewRecord(reviewRecord(message.providerOptions).cursor);
    const output = reviewRecord(reviewRecord(cursor.highLevelToolCallResult).output);
    if (!output.rejected) {
      return;
    }
    const rejected = reviewRecord(output.rejected);
    const content = message.content;
    if (
      agentId !== this.agentId ||
      message.id !== this.callId ||
      !Array.isArray(content) ||
      content.length !== 1 ||
      reviewRecord(content[0]).toolCallId !== this.callId ||
      reviewRecord(content[0]).toolName !== 'Shell' ||
      rejected.command !== this.command ||
      typeof rejected.reason !== 'string' ||
      !rejected.reason ||
      (rejected.workingDirectory && rejected.workingDirectory !== this.cwd)
    ) {
      throw new Error('Uncorrelated Cursor native rejection');
    }
    this.denied = true;
  }

  verdict(): ApprovalVerdict {
    if (!this.started || !this.prechecked || this.denied === this.reachedCore) {
      throw new Error('Cursor native reviewer returned no unambiguous verdict');
    }
    return { model: 'cursor-auto-review', outcome: this.denied ? 'deny' : 'allow' };
  }
}

export function reviewCommand(value: unknown, cwd: unknown): string {
  const action = reviewRecord(value);
  if (
    Object.keys(action).length !== 1 ||
    typeof action.Bash !== 'string' ||
    !action.Bash.trim() ||
    typeof cwd !== 'string' ||
    !path.isAbsolute(cwd)
  ) {
    throw new Error(
      'Cursor native reviewer currently supports only Bash actions with absolute cwd',
    );
  }
  return action.Bash;
}
