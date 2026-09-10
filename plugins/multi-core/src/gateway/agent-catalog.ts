import type { MessagesRequest } from './messages.ts';

interface Worker {
  model: string;
  description: string;
  tools: string[];
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Registration is unchanged: only exact Multi-owned announcement rows are hidden. */
export class AgentCatalog {
  private hidden = new Set<string>();

  constructor(workers: Record<string, Worker>, models: readonly string[]) {
    const remaining = new Set(models);
    for (const [name, worker] of Object.entries(workers)) {
      if (remaining.delete(worker.model)) {
        continue;
      }
      this.hidden.add(`- ${name}: ${worker.description} (Tools: ${worker.tools.join(', ')})`);
    }
  }

  compact(body: MessagesRequest): MessagesRequest {
    if (!Array.isArray(body.messages)) {
      return body;
    }
    let changed = false;
    const messages = body.messages.map((message) => {
      if (!record(message) || !['user', 'system'].includes(message.role)) {
        return message;
      }
      const content = this.content(message.content, message.role === 'system');
      if (content === message.content) {
        return message;
      }
      changed = true;
      return { ...message, content };
    });
    return changed ? { ...body, messages } : body;
  }

  private content(content: string | NonNullable<MessagesRequest['system']>, system: boolean) {
    if (typeof content === 'string') {
      return this.text(content, system);
    }
    if (!Array.isArray(content)) {
      return content;
    }
    let changed = false;
    const blocks = content.map((block) => {
      if (!record(block) || block.type !== 'text' || typeof block.text !== 'string') {
        return block;
      }
      const text = this.text(block.text, system);
      if (text === block.text) {
        return block;
      }
      changed = true;
      return { ...block, text };
    });
    return changed ? blocks : content;
  }

  private text(text: string, system: boolean): string {
    // Native CLI announcements may be bare system messages or wrapped user reminders.
    if (system) {
      return this.section(text);
    }
    return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, (reminder) =>
      this.section(reminder),
    );
  }

  private section(text: string): string {
    return text.replace(
      /^(Available agent types for the Agent tool:|New agent types are now available for the Agent tool:)\n((?:- [^\n]*(?:\n|$))+)/gm,
      (section: string, heading: string, rows: string) => {
        const kept = rows
          .split('\n')
          .filter((line) => !this.hidden.has(line))
          .join('\n');
        return kept === rows ? section : `${heading}\n${kept}`;
      },
    );
  }
}
