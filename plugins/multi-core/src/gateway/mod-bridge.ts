import type { MessagesRequest } from './messages.ts';

export type NativeRowKind = 'read' | 'search' | 'edit' | 'shell' | 'other' | 'note';
export type NativeObservation =
  | { type: 'text'; text: string }
  | { type: 'started'; id: string; kind: NativeRowKind; description: string }
  | { type: 'completed'; id: string; text: string; error: boolean };

const MAX_EVENTS = 128;
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
  private sequence = 0;
  private readonly lifecycle = new Map<
    string,
    { model: string; startedAt: number; state: string; detail: string }
  >();
  private readonly telemetry = new Map<string, { model: string; effort?: string | number }>();
  private readonly pending = new Map<string, Map<string, PendingObservation>>();

  recordSession(key: string, value: { effective: Effective; cwd?: string; generation?: number }) {
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
    if (!this.snapshots.has(key) && this.snapshots.size >= MAX_KEYS) {
      throw new Error('Mod session capacity reached; restart the gateway');
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
      if (!this.pending.has(key) && this.pending.size >= MAX_KEYS) {
        return undefined;
      }
      let actions = this.pending.get(key);
      if (!actions) {
        actions = new Map();
        this.pending.set(key, actions);
      }
      actions.set(observation.id, {
        kind: observation.kind,
        description: bounded(observation.description, 160),
      });
      while (actions.size > MAX_EVENTS) {
        actions.delete(actions.keys().next().value as string);
      }
      const lifecycle = this.lifecycle.get(key);
      if (lifecycle) {
        lifecycle.detail = bounded(observation.description, 160);
      }
      return undefined;
    }
    const action = this.pending.get(key)?.get(observation.id);
    if (!action) {
      return undefined;
    }
    this.pending.get(key)?.delete(observation.id);
    const output = bounded(observation.text);
    const event: ModDisplayEvent = {
      sequence: ++this.sequence,
      toolUseId: observation.id,
      tool: `mcp__multi-core__cursor_${action.kind}`,
      input: {
        description: action.description,
        output,
        isError: observation.error,
        toolUseId: observation.id,
      },
    };
    return event;
  }

  begin(key: string, model: string) {
    if (!this.lifecycle.has(key) && this.lifecycle.size >= MAX_KEYS) {
      const completed = [...this.lifecycle].find(([, value]) => value.state !== 'running');
      if (!completed) {
        throw new Error('Native lifecycle capacity reached; restart the gateway');
      }
      this.lifecycle.delete(completed[0]);
    }
    this.lifecycle.set(key, { model, startedAt: Date.now(), state: 'running', detail: '' });
  }

  status(key: string) {
    const value = this.lifecycle.get(key);
    return value ? { ...value, elapsedMs: Date.now() - value.startedAt } : undefined;
  }

  step(key: string) {
    return this.telemetry.get(key);
  }

  observeStep(key: string, value: { model: string; effort?: string | number }) {
    if (!this.telemetry.has(key) && this.telemetry.size >= MAX_KEYS) {
      this.telemetry.delete(this.telemetry.keys().next().value as string);
    }
    this.telemetry.set(key, value);
  }

  complete(key: string, state = 'completed') {
    const value = this.lifecycle.get(key);
    if (value) {
      value.state = state;
    }
    this.pending.delete(key);
  }

  forgetSession(session: string) {
    for (const entries of [this.snapshots, this.pending, this.lifecycle, this.telemetry]) {
      for (const key of entries.keys()) {
        if (JSON.parse(key)[0] === session) {
          entries.delete(key);
        }
      }
    }
  }
}
