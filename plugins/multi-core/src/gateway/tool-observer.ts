import { once } from 'node:events';
import type { ServerResponse } from 'node:http';
import { readSse } from '../../../multi-openai/src/responses.ts';

interface Tool {
  id: string;
  name: string;
  input: unknown;
}

const MAX_BYTES = 8 * 1024 * 1024;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Observe provider output for attribution, never for permission grants. */
export class ToolObserver {
  private blocks = new Map<number, Tool & { json: string }>();
  private remember: (tool: Tool) => void;

  constructor(remember: (tool: Tool) => void) {
    this.remember = remember;
  }

  response(value: unknown) {
    if (record(value) && Array.isArray(value.content)) {
      for (const block of value.content) {
        const tool = this.tool(block);
        if (tool) {
          this.remember(tool);
        }
      }
    }
  }

  event(value: unknown) {
    if (!record(value) || typeof value.index !== 'number') {
      return;
    }
    if (value.type === 'content_block_start') {
      const tool = this.tool(value.content_block);
      if (tool) {
        this.blocks.set(value.index, { ...tool, json: '' });
      }
      return;
    }
    const tool = this.blocks.get(value.index);
    if (!tool) {
      return;
    }
    if (value.type === 'content_block_delta' && record(value.delta)) {
      this.append(tool, value.delta.partial_json);
    }
    if (value.type === 'content_block_stop') {
      this.remember({ ...tool, input: tool.json ? JSON.parse(tool.json) : tool.input });
      this.blocks.delete(value.index);
    }
  }

  private append(tool: Tool & { json: string }, delta: unknown) {
    if (typeof delta === 'string') {
      tool.json += delta;
      if (Buffer.byteLength(tool.json) > MAX_BYTES) {
        throw new Error('Observed tool input exceeds 8 MiB');
      }
    }
  }

  private tool(value: unknown): Tool | undefined {
    if (
      record(value) &&
      value.type === 'tool_use' &&
      typeof value.id === 'string' &&
      typeof value.name === 'string'
    ) {
      return { id: value.id, name: value.name, input: value.input };
    }
    return undefined;
  }
}

/** Keep passthrough bytes unchanged and couple observation to client backpressure. */
export async function forwardObservedTools(
  upstream: Response,
  res: ServerResponse,
  remember: (tool: Tool) => void,
  signal: AbortSignal,
) {
  if (!upstream.body) {
    res.end();
    return;
  }
  const observer = new ToolObserver(remember);
  if (upstream.headers.get('content-type')?.includes('text/event-stream')) {
    const source = upstream.body;
    const forwarded = async function* () {
      for await (const chunk of source) {
        if (!res.write(chunk)) {
          await once(res, 'drain', { signal });
        }
        yield chunk;
      }
    };
    for await (const event of readSse(forwarded())) {
      observer.event(event);
    }
  } else {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of upstream.body) {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) {
        throw new Error('Observed response exceeds 8 MiB');
      }
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    observer.response(JSON.parse(body.toString('utf8')));
    res.write(body);
  }
  res.end();
}
