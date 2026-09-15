import type { MessagesRequest } from './messages.ts';

export type NativeRowKind = 'read' | 'search' | 'edit' | 'shell' | 'other' | 'note';
export type NativeObservation =
  | { type: 'text'; text: string }
  | { type: 'started'; id: string; kind: NativeRowKind; description: string }
  | { type: 'completed'; id: string; text: string; error: boolean };

const MAX_EVENTS = 2048;
const MAX_TEXT = 4096;
const MAX_KEYS = 128;

type Effective = {
  permissionMode?: string;
  tools?: string[];
  disallowedTools?: string[];
};

type Snapshot = {
  generation: number;
  effective: Effective;
  cwd?: string;
};

type PendingObservation = {
  kind: NativeRowKind;
  description: string;
};

export type ModDisplayEvent = {
  sequence: number;
  toolUseId: string;
  tool: string;
  input: {
    description: string;
    output: string;
    isError: boolean;
    toolUseId: string;
  };
};

function bounded(value: string, limit = MAX_TEXT) {
  return value.slice(0, limit);
}

export class ModBridge {
  private generation = 0;
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly events = new Map<string, ModDisplayEvent[]>();
  private readonly pending = new Map<string, Map<string, PendingObservation>>();
  private readonly active = new Set<string>();

  recordSession(key: string, value: { effective: Effective; cwd?: string; generation?: number }) {
    return this.record(key, value);
  }

  recordWorker(key: string, value: { effective: Effective; cwd?: string }) {
    return this.record(key, value);
  }

  mode(key: string) {
    return this.snapshots.get(key);
  }

  available(body: MessagesRequest) {
    const tools = new Set(body.tools?.map((tool) => tool.name));
    return ['read', 'search', 'edit', 'shell', 'other', 'note'].every((name) =>
      tools.has(`mcp__multi-core__cursor_${name}`),
    );
  }

  private record(key: string, value: { effective: Effective; cwd?: string; generation?: number }) {
    if (
      value.generation !== undefined &&
      value.generation !== this.snapshots.get(key)?.generation
    ) {
      return undefined;
    }
    const snapshot = {
      generation: ++this.generation,
      effective: {
        permissionMode: value.effective.permissionMode,
        tools: value.effective.tools?.slice(0, 256),
        disallowedTools: value.effective.disallowedTools?.slice(0, 256),
      },
      cwd: value.cwd,
    };
    this.snapshots.set(key, snapshot);
    return snapshot;
  }

  observe(key: string, observation: NativeObservation): ModDisplayEvent | undefined {
    if (observation.type === 'text') {
      return undefined;
    }
    if (observation.type === 'started') {
      let actions = this.pending.get(key);
      if (!actions) {
        actions = new Map();
        this.pending.set(key, actions);
      }
      actions.set(observation.id, {
        kind: observation.kind,
        description: bounded(observation.description),
      });
      while (actions.size > MAX_EVENTS) {
        actions.delete(actions.keys().next().value as string);
      }
      this.active.add(key);
      return undefined;
    }
    const action = this.pending.get(key)?.get(observation.id);
    if (!action) {
      return undefined;
    }
    this.pending.get(key)?.delete(observation.id);
    const output = bounded(observation.text);
    const event: ModDisplayEvent = {
      sequence: (this.events.get(key)?.at(-1)?.sequence ?? 0) + 1,
      toolUseId: observation.id,
      tool: `mcp__multi-core__cursor_${action.kind}`,
      input: {
        description: action.description,
        output,
        isError: observation.error,
        toolUseId: observation.id,
      },
    };
    const list = this.events.get(key) ?? [];
    list.push(event);
    while (list.length > MAX_EVENTS) {
      list.shift();
    }
    this.events.set(key, list);
    this.trimKeys();
    return event;
  }

  display(key: string, cursor: number, limit: number) {
    const list = this.events.get(key) ?? [];
    const events = list.filter((event) => event.sequence > cursor).slice(0, limit);
    return { events, nextCursor: events.at(-1)?.sequence ?? cursor, done: !this.active.has(key) };
  }

  complete(key: string) {
    this.active.delete(key);
    this.pending.delete(key);
  }

  private trimKeys() {
    while (this.events.size > MAX_KEYS) {
      const oldest = this.events.keys().next();
      if (oldest.done) {
        return;
      }
      this.events.delete(oldest.value);
      this.pending.delete(oldest.value);
      this.active.delete(oldest.value);
    }
  }
}
