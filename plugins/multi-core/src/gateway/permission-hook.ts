import { fileURLToPath, pathToFileURL } from 'node:url';

export function hookCommand(file: URL, platform: NodeJS.Platform = process.platform): string {
  return [process.execPath, fileURLToPath(file)]
    .map((value) => {
      if (platform !== 'win32') {
        return `'${value.replaceAll("'", "'\\''")}'`;
      }
      if (/["%\r\n!]/.test(value)) {
        throw new Error('Unsupported characters in hook path');
      }
      return `"${value}"`;
    })
    .join(' ');
}

export interface PendingApprovalTool {
  session: string;
  model: string;
  name: string;
  input: unknown;
  scope?: string;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let raw = '';
    for await (const chunk of process.stdin) {
      raw += chunk;
      if (raw.length > 1048576) {
        throw new Error('Hook input too large');
      }
    }
    // Permission mode is enforced by Claude; only classifier requests invoke review.
    const response = await fetch(new URL('/multi/permission', process.env.ANTHROPIC_BASE_URL), {
      method: 'POST',
      headers: { 'x-multi-gateway-token': process.env.MULTI_GATEWAY_TOKEN ?? '' },
      body: raw,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      throw new Error('Capability lookup failed');
    }
    console.log(JSON.stringify(await response.json()));
  } catch {
    console.log(JSON.stringify({}));
  }
}
