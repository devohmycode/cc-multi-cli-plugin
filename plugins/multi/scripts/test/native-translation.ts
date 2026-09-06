// Opt-in live check. Sends only synthetic text/images through the Codex subscription.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createNativeGateway } from '../lib/native-gateway.ts';
import type { MessagesResponse } from '../lib/native-responses.ts';

// Generated 64x64 solid red and blue PNGs; no external image fetches.
const red = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC';
const blue = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdNvJ8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ2oPcf88OIhvJ6vAAAAAElFTkSuQmCC';
const image = (data: string) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } });
const token = randomBytes(32).toString('hex');
const nonce = randomBytes(8).toString('hex');
const authFile = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
const server = createNativeGateway({ token, authFile });
await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const address = server.address();
assert(address !== null && typeof address === 'object', 'Gateway port');
try {
  const format = { type: 'json_schema', schema: { type: 'object', properties: {
    user_colour: { type: 'string' }, tool_colour: { type: 'string' }, nonce: { type: 'string' }
  }, required: ['user_colour', 'tool_colour', 'nonce'], additionalProperties: false } };
  for (const legacy of [false, true]) {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: 'POST', signal: AbortSignal.timeout(180000),
      headers: { 'content-type': 'application/json', 'x-multi-gateway-token': token },
      body: JSON.stringify({ model: 'multi/openai/gpt-5.6-luna', stream: false,
        system: 'Return the solid colour of each supplied image as a lowercase English word, and repeat the nonce exactly.',
        output_config: { effort: 'low', ...(!legacy ? { format } : {}) }, ...(legacy ? { output_format: format } : {}),
        tools: [{ name: 'Read', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } }],
        tool_choice: { type: 'none' }, messages: [
          { role: 'user', content: [{ type: 'text', text: `Nonce: ${nonce}. Here is the user image. Compare it with the image from Read.` }, image(red)] },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'call_fixture', name: 'Read', input: { file_path: 'synthetic.png' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_fixture', content: [image(blue)] }] }
        ] })
    });
    const result: MessagesResponse = JSON.parse(await response.text());
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.stop_reason, 'end_turn');
    const answer = JSON.parse(result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''));
    assert.deepEqual(answer, { user_colour: 'red', tool_colour: 'blue', nonce });
    console.log(`PASS: ${legacy ? 'legacy' : 'modern'} structured output + user/tool-result images on Luna.`);
  }
} finally {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
