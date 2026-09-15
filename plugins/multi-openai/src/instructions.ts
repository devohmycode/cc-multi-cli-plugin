import { readFileSync } from 'node:fs';

// Adapted from Codex's gpt-6-astra instructions_template, fetched 2026-09-10.
// Keep this snapshot in the runtime package; never read a user's model cache at runtime.
const instructions = readFileSync(new URL('./instructions.md', import.meta.url), 'utf8').trim();

export function openaiInstructions(runtime: string): string {
  // Claude mixes built-in prose, appended policies and environment in one block.
  // Retain it intact: deleting that block would also delete user/worker restrictions.
  return `${runtime}\n\n# OpenAI provider instructions\n\n${instructions}`;
}
