import { randomUUID } from 'node:crypto';
import type { WorkerPermissions } from './agent-definitions.ts';

export type PreparedPolicy = {
  cwd: string;
  workers: Record<string, WorkerPermissions>;
  restrictions: WorkerPermissions;
};
type Job = {
  cwd: string;
  consumed: boolean;
  generation: string;
  status: 'pending' | 'ready' | 'failed';
  policy?: PreparedPolicy;
  error?: string;
};

/** File discovery runs detached from the bounded hook requests. */
export class ModPolicies {
  private inFlight = 0;
  private readonly jobs = new Map<string, Job>();
  private readonly load: (cwd: string) => Promise<PreparedPolicy>;

  constructor(load: (cwd: string) => Promise<PreparedPolicy>) {
    this.load = load;
  }

  begin(session: string, cwd: string) {
    const existing = this.jobs.get(session);
    if (existing && existing.cwd === cwd && !existing.consumed && existing.status !== 'failed') {
      return { generation: existing.generation, status: existing.status };
    }
    if (this.inFlight >= 64) {
      throw new Error('Policy discovery capacity reached');
    }
    if (!this.jobs.has(session) && this.jobs.size >= 128) {
      throw new Error('Policy session capacity reached');
    }
    const job: Job = { cwd, consumed: false, generation: randomUUID(), status: 'pending' };
    this.jobs.set(session, job);
    this.inFlight++;
    void this.load(cwd).then(
      (policy) => {
        this.inFlight--;
        if (this.jobs.get(session) === job) {
          job.policy = structuredClone(policy);
          job.status = 'ready';
        }
      },
      (error: unknown) => {
        this.inFlight--;
        job.status = 'failed';
        job.error = error instanceof Error ? error.message : 'Policy discovery failed';
      },
    );
    return { generation: job.generation, status: job.status };
  }

  status(session: string, generation: string) {
    const job = this.jobs.get(session);
    if (!job || job.generation !== generation) {
      throw new Error('Policy generation is unavailable or stale');
    }
    return { generation, status: job.status, error: job.error };
  }

  consume(session: string, generation: string, cwd: string): PreparedPolicy {
    this.status(session, generation);
    const job = this.jobs.get(session);
    const policy = job?.policy;
    if (!job || !policy || policy.cwd !== cwd) {
      throw new Error('Policy generation is not ready for this workspace');
    }
    job.consumed = true;
    return structuredClone(policy);
  }

  forget(session: string) {
    this.jobs.delete(session);
  }
}
