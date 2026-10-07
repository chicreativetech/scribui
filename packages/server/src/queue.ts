/**
 * The capture queue of the project's owner: rounds (from the canvas, the
 * agent, `scribui capture` or MCP handing over) and single views (the app
 * tab, the desktop app) run one at a time, in the order they arrive.
 */

export type JobKind = "round" | "view";
export type JobStatus = "queued" | "running" | "done" | "failed";

export type Job<R = unknown> = {
  id: string;
  kind: JobKind;
  /** Who asked: "gui", "agent-applied", "cli", "mcp", "desktop". */
  trigger: string;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: R;
  error?: string;
};

type Entry = { job: Job; run: (job: Job) => Promise<unknown>; done: Array<(j: Job) => void> };

export class CaptureQueue {
  private entries: Entry[] = [];
  private finished: Job[] = [];
  private running: Entry | null = null;
  private seq = 0;

  constructor(private onChange: () => void = () => {}) {}

  /** Add a job; it runs after everything already queued, never before `enqueue` returns. */
  enqueue<R>(kind: JobKind, trigger: string, run: (job: Job<R>) => Promise<R>): Job<R> {
    const job: Job<R> = { id: `j${Date.now().toString(36)}${(++this.seq).toString(36)}`, kind, trigger, status: "queued", createdAt: new Date().toISOString() };
    this.entries.push({ job, run: run as (job: Job) => Promise<unknown>, done: [] });
    this.onChange();
    queueMicrotask(() => void this.pump());
    return job;
  }

  /** Resolves when the job has finished (done or failed). */
  wait(id: string): Promise<Job> {
    const fin = this.finished.find((j) => j.id === id);
    if (fin) return Promise.resolve(fin);
    const e = this.running?.job.id === id ? this.running : this.entries.find((x) => x.job.id === id);
    if (!e) return Promise.reject(new Error(`no capture job ${id}`));
    return new Promise((resolve) => e.done.push(resolve));
  }

  get(id: string): (Job & { position: number }) | undefined {
    if (this.running?.job.id === id) return { ...this.running.job, position: 0 };
    const i = this.entries.findIndex((x) => x.job.id === id);
    if (i >= 0) return { ...this.entries[i]!.job, position: i + 1 + (this.running ? 1 : 0) };
    const f = this.finished.find((j) => j.id === id);
    return f ? { ...f, position: 0 } : undefined;
  }

  /** Jobs not finished yet, the running one first. */
  pending(): Job[] {
    return [...(this.running ? [this.running.job] : []), ...this.entries.map((e) => e.job)];
  }

  has(kind: JobKind, trigger?: string): boolean {
    return this.pending().some((j) => j.kind === kind && (!trigger || j.trigger === trigger));
  }

  private async pump() {
    if (this.running) return;
    const next = this.entries.shift();
    if (!next) return;
    this.running = next;
    next.job.status = "running";
    next.job.startedAt = new Date().toISOString();
    this.onChange();
    try {
      next.job.result = await next.run(next.job);
      next.job.status = "done";
    } catch (e) {
      next.job.status = "failed";
      next.job.error = (e as Error).message;
    }
    next.job.finishedAt = new Date().toISOString();
    this.running = null;
    this.finished = [next.job, ...this.finished].slice(0, 50);
    for (const d of next.done) d(next.job);
    this.onChange();
    void this.pump();
  }
}
