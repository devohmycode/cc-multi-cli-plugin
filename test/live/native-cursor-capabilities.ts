// Opt-in: separates inert callback support from image interpretation for account models.
import assert from 'node:assert/strict';
import { Cursor } from '@cursor/sdk';
import type { ContentBlock, MessagesRequest } from '../../plugins/multi/src/gateway/messages.ts';
import { CursorBridge } from '../../plugins/multi/src/providers/cursor/bridge.ts';
import { cursorModelOptions } from '../../plugins/multi/src/providers/cursor/models.ts';

const redPng =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC';

async function main() {
  if (!process.env.CURSOR_API_KEY && (await Cursor.auth.status()).status !== 'logged-in') {
    throw new Error(
      'Cursor SDK login required: node plugins/multi/src/native-model-gateway.ts --cursor-login',
    );
  }
  const catalog = cursorModelOptions(await Cursor.models.list());
  const requested = process.argv.slice(2);
  const names = requested.length ? requested : ['default', 'composer-2.5', 'grok-4.6'];
  const selected = names.flatMap((name) => {
    const option = catalog.find(
      (candidate) =>
        candidate.selection.id === name || candidate.model === name || candidate.worker === name,
    );
    if (!option && requested.length) {
      throw new Error(`Cursor model is unavailable: ${name}`);
    }
    return option ? [option] : [];
  });
  assert(selected.length, 'No requested Cursor capability models are available to this account');

  for (const model of selected) {
    const bridge = new CursorBridge([model]);
    try {
      const probe = async (text: string, image = false) => {
        const content: ContentBlock[] = [{ type: 'text', text }];
        if (image) {
          content.push({
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: redPng },
          });
        }
        const request: MessagesRequest = {
          model: model.model,
          messages: [{ role: 'user', content }],
          tools: [
            {
              name: 'Probe',
              description: 'An inert test callback that returns a fixed acknowledgement.',
              input_schema: {
                type: 'object',
                properties: { value: { type: 'string' } },
                required: ['value'],
              },
            },
          ],
        };
        const scope = `live/capabilities/${model.worker}/${image ? 'image' : 'plain'}`;
        const first = await bridge.handle(request, scope, AbortSignal.timeout(120000));
        assert.equal(first.stop_reason, 'tool_use');
        const call = first.content.find((block) => block.type === 'tool_use');
        assert(call?.type === 'tool_use');
        assert(request.messages);
        const result = await bridge.handle(
          {
            ...request,
            messages: [
              ...request.messages,
              { role: 'assistant', content: first.content },
              {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: call.id, content: 'ACK' }],
              },
            ],
          },
          scope,
          AbortSignal.timeout(120000),
        );
        assert.equal(result.stop_reason, 'end_turn');
        return call.input;
      };
      assert.deepEqual(
        await probe('Call Probe once with value plain. Do not use any other action.'),
        {
          value: 'plain',
        },
      );
      const image = await probe(
        'Inspect the attached image. Call Probe once with value equal to its dominant color in lowercase. Do not use any other action.',
        true,
      );
      const vision = JSON.stringify(image) === JSON.stringify({ value: 'red' });
      console.log(
        `PASS: ${model.label} plain_callback=ok image_value=${JSON.stringify(image)} vision=${vision ? 'red' : 'unverified'}.`,
      );
    } finally {
      await bridge.close();
    }
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`FAIL: Cursor capability probe: ${message}`);
  process.exitCode = 1;
});
