import { getEncoding } from 'js-tiktoken';
import type { ResponsesRequest, ResponsesInputContent } from './native-responses.ts';

let encoding: ReturnType<typeof getEncoding> | undefined;
/** Local estimate, not a provider billing count. Media expansion uses heuristics. */
export function estimateInputTokens(request: ResponsesRequest): number {
  encoding ??= getEncoding('o200k_base');
  const text = (value: string) => encoding!.encode(value, [], []).length;
  // ponytail: media allowances are heuristic; replace with provider counting if the subscription endpoint exposes it.
  const parts = (content: ResponsesInputContent[]) => content.reduce((n, part) => n +
    (part.type === 'input_image' ? 4096 : part.type === 'input_file'
      ? Math.ceil(Buffer.byteLength(part.file_data) * 3 / 4) : text(part.text)), 0);
  let total = text(request.instructions) + text(JSON.stringify(request.tools)) + 8;
  for (const item of request.input) {
    total += 8;
    if ('role' in item) total += parts(item.content);
    else if (item.type === 'function_call') total += text(item.name) + text(item.arguments);
    else if (item.type === 'function_call_output') total += typeof item.output === 'string' ? text(item.output) : parts(item.output);
    // Opaque reasoning is not text input; do not tokenize the ciphertext.
  }
  if (request.text) total += text(JSON.stringify(request.text));
  return total;
}
