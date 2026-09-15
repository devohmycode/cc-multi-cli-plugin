import type { EngineInterface, Register } from 'claude-code';
import { register as registerCompaction } from './compact.ts';
import { register as registerWorkers } from './workers.ts';

const displayTools = [
  ['read', 'Display-only Cursor file read.'],
  ['search', 'Display-only Cursor search.'],
  ['edit', 'Display-only Cursor edit.'],
  ['shell', 'Display-only Cursor shell action.'],
  ['other', 'Display-only Cursor action.'],
  ['note', 'Display-only Cursor progress note.'],
] as const;
const prefix = 'mcp__multi-core__cursor_';
const maxBody = 32000;

type DisplayInput = {
  description?: string;
  toolUseId?: string;
  output?: string;
  isError?: boolean;
};

type GatewayResponse = {
  output?: string;
  isError?: boolean;
  terminal?: boolean;
  accepted?: boolean;
  stale?: boolean;
  events?: Array<{
    sequence: number;
    toolUseId: string;
    tool: string;
    phase: string;
    input: DisplayInput;
    output?: string;
    isError?: boolean;
  }>;
  nextCursor?: number;
};

// Claude Code 2.1.272 loads exactly one entry from hooks.json `modules`; compose here.
export const register: Register = (on, options) => {
  registerCompaction(on, options);
  registerWorkers(on, options);
  for (const [name, _description] of displayTools) {
    const tool = `${prefix}${name}`;
    on('tool.call', { tool }, async (_$, event) => {
      // The tool's own arguments sit beside the reserved keys on the envelope.
      const input = event as unknown as DisplayInput;
      return {
        result: {
          type: 'text',
          text: input.output ?? 'Display result unavailable.',
          is_error: input.isError === true,
        },
      };
    });
    on('tool.check', { tool }, () => ({
      decision: 'allow' as const,
      reason: 'Display-only row; it never executes a Cursor action.',
    }));
    on('ui.render', { component: 'ToolUse', props: { tool } }, async ($, event, next) => {
      const { Box, Text } = $.ui.resolve(event);
      const input = event.props.input as DisplayInput;
      const row = await next(event);
      return Box({
        flexDirection: 'column',
        children: [
          Text({ color: 'cyan', children: `Cursor ${name}: ${input.description ?? ''}` }),
          row,
        ],
      });
    });
    on('ui.render', { component: 'ToolResult', props: { tool } }, async ($, event, next) => {
      const { Box, Text } = $.ui.resolve(event);
      const row = await next(event);
      return Box({
        flexDirection: 'column',
        children: [Text({ color: 'cyan', children: `Cursor ${name} complete` }), row],
      });
    });
  }
  on('session.start', async ($, event, next) => {
    if (!(await active($))) {
      return next(event);
    }
    for (const [name, description] of displayTools) {
      await $.tool.register({
        name: `cursor_${name}`,
        description,
        inputSchema: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            output: { type: 'string' },
            isError: { type: 'boolean' },
            toolUseId: { type: 'string' },
          },
          required: ['description', 'output', 'isError', 'toolUseId'],
          additionalProperties: false,
        },
      });
    }
    await request($, '/multi/mod/session', {
      sessionId: await $.session.id(),
      cwd: await $.session.cwd(),
      model: await $.session.model(),
      event: 'start',
    });
    return next(event);
  });
  on('classic.UserPromptSubmit', async ($, event, next) => {
    if (!(await active($))) {
      return next(event);
    }
    const response = await request($, '/multi/mod/session', {
      sessionId: event.session_id,
      cwd: event.cwd,
      model: await $.session.model(),
      event: 'prompt',
      permissionMode: event.permission_mode,
    });
    if (!response?.accepted) {
      return {
        block: 'Multi permission snapshot was not acknowledged; native execution is unavailable.',
      };
    }
    return next(event);
  });
  on('turn.complete', async ($, event, next) => {
    await $.ui.status(undefined);
    return next(event);
  });
};

async function active($: EngineInterface): Promise<boolean> {
  const base = await $.env.get('MULTI_MOD_GATEWAY_URL');
  const token = await $.env.get('MULTI_GATEWAY_TOKEN');
  return Boolean(base && token);
}

async function request($: EngineInterface, route: string, payload: Record<string, unknown>) {
  const base = await $.env.get('MULTI_MOD_GATEWAY_URL');
  const token = await $.env.get('MULTI_GATEWAY_TOKEN');
  if (!base || !token) {
    return undefined;
  }
  const body = JSON.stringify(payload).slice(0, maxBody);
  const isGet = route.startsWith('/multi/mod/display?');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = $.http.fetch(`${base}${route}`, {
      method: isGet ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-multi-gateway-token': token },
      ...(isGet ? {} : { body }),
    });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('gateway request timeout')), 1500);
    });
    const result = await Promise.race([response, timeout]);
    return result.ok ? (JSON.parse(result.text) as GatewayResponse) : undefined;
  } catch {
    return undefined;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
