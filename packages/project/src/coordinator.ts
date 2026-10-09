import { PRODUCT } from "@scribui/core";
import type { CaptureRunResult, CaptureState, Job, ReviewStore, ServerOptions } from "@scribui/server";
import { captureRound, type CaptureOptions, type CaptureResult } from "./capture.js";
import { renameGenericProject } from "./detect.js";
import { findRunning, startOnFreePort } from "./instances.js";
import { ignoreLockInGit, lockAlive, ProjectLock, readLock, type LockInfo } from "./lock.js";

/**
 * Who works on a project, and how everyone else reaches them.
 *
 * - A server (`scribui`, `scribui open`, the desktop app) takes the lock for as
 *   long as it runs and queues every capture: rounds and single views.
 * - `scribui capture` and MCP hand their capture to that server and wait for
 *   it; with no server, they take the lock for the duration of the capture.
 * - A second server for the same project doesn't start: it's pointed at the
 *   one that runs.
 */

export type Owner = {
  role: LockInfo["role"];
  app: string;
  pid: number;
  /** The server's canvas URL; null for a one-off capture (or a server still starting). */
  url: string | null;
  /** A server from before the lock existed, found by its port. */
  legacy?: boolean;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WAIT_LIMIT_MS = 30 * 60_000;

/** The current owner of the project, if any. */
export async function findOwner(store: ReviewStore, port: number = PRODUCT.defaultPort): Promise<Owner | null> {
  const info = readLock(store.dir);
  if (info && lockAlive(info)) {
    return { role: info.role, app: info.app, pid: info.pid, url: info.role === "server" && info.port ? `http://127.0.0.1:${info.port}/` : null };
  }
  const legacy = await findRunning(store.root, port);
  return legacy ? { role: "server", app: "cli", pid: 0, url: legacy, legacy: true } : null;
}

type Started = NonNullable<Awaited<ReturnType<typeof startOnFreePort>>>;

export type HostResult =
  /** This process now owns the project and runs its server. */
  | { kind: "owner"; server: Started; lock: ProjectLock | null }
  /** Another server already owns it. */
  | { kind: "running"; owner: Owner }
  /** Every port in the range is taken. */
  | { kind: "no-port" };

/**
 * Take the project for a server and start it. Waits (calling `onWait`) while a
 * one-off capture holds the project. Closing the server releases the lock.
 */
export async function hostProject(
  store: ReviewStore,
  opts: { app: string; port?: number; server: Omit<ServerOptions, "projectDir" | "port">; onWait?: (owner: Owner) => void; waitLimitMs?: number },
): Promise<HostResult> {
  await renameGenericProject(store);
  const port: number = opts.port ?? PRODUCT.defaultPort;
  const deadline = Date.now() + (opts.waitLimitMs ?? WAIT_LIMIT_MS);
  let told = false;
  for (;;) {
    const owner = await findOwner(store, port);
    if (owner?.role === "server") return { kind: "running", owner };
    if (owner?.role === "capture") {
      if (!told) opts.onWait?.(owner);
      told = true;
      if (Date.now() > deadline) throw new Error(`a capture (pid ${owner.pid}) has held the project for too long`);
      await sleep(500);
      continue;
    }
    ignoreLockInGit(store.dir);
    const got = ProjectLock.acquire(store.dir, { role: "server", app: opts.app });
    if ("held" in got) continue;
    const lock = got.lock;
    let server: Awaited<ReturnType<typeof startOnFreePort>>;
    try {
      server = await startOnFreePort({ ...opts.server, projectDir: store.root, port });
    } catch (e) {
      lock.release();
      throw e;
    }
    if (!server) {
      lock.release();
      return { kind: "no-port" };
    }
    lock.update({ port: server.port });
    const close = server.close;
    return {
      kind: "owner",
      lock,
      server: {
        ...server,
        close: async () => {
          await close();
          lock.release();
        },
      },
    };
  }
}

export type ProjectCapture =
  | { via: "local"; result: CaptureResult | null }
  | { via: "server"; url: string; job: string; result: CaptureRunResult };

/**
 * A one-off capture (`scribui capture`, MCP, a plain `scribui` run by an
 * agent): handed to the project's server when one runs, otherwise run here
 * with the lock held. A dry run only reads, so it never waits.
 */
export async function captureProject(
  store: ReviewStore,
  opts: CaptureOptions & {
    app: string;
    port?: number;
    onWait?: (owner: Owner) => void;
    onHandOver?: (owner: Owner) => void;
    onProgress?: (state: CaptureState, job: Job) => void;
    waitLimitMs?: number;
  },
): Promise<ProjectCapture> {
  if (opts.dryRun) return { via: "local", result: await captureRound(store, opts) };
  const deadline = Date.now() + (opts.waitLimitMs ?? WAIT_LIMIT_MS);
  let told = false;
  for (;;) {
    const owner = await findOwner(store, opts.port);
    if (owner?.role === "server" && owner.url) {
      opts.onHandOver?.(owner);
      return handOver(owner.url, opts);
    }
    if (owner) {
      // a one-off capture, or a server that hasn't written its port yet
      if (!told) opts.onWait?.(owner);
      told = true;
      if (Date.now() > deadline) throw new Error(`the project has been busy for too long (pid ${owner.pid})`);
      await sleep(500);
      continue;
    }
    ignoreLockInGit(store.dir);
    const got = ProjectLock.acquire(store.dir, { role: "capture", app: opts.app });
    if ("held" in got) continue;
    try {
      return { via: "local", result: await captureRound(store, opts) };
    } finally {
      got.lock.release();
    }
  }
}

/** Queue the capture on the running server and follow it until it's done. */
async function handOver(
  url: string,
  opts: CaptureOptions & { app: string; onProgress?: (state: CaptureState, job: Job) => void },
): Promise<ProjectCapture> {
  const body = { ...(opts.screens?.length ? { screens: opts.screens } : {}), ...(opts.all ? { all: true } : {}), trigger: opts.app === "mcp" ? "mcp" : "cli" };
  const r = await fetch(new URL("/api/capture", url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const started = (await r.json()) as { job?: string; error?: string };
  if (!r.ok || !started.job) throw new Error(started.error ?? `the server at ${url} refused the capture (${r.status})`);
  for (;;) {
    await sleep(400);
    const s = await fetch(new URL(`/api/capture/jobs/${started.job}`, url));
    const { job, capture } = (await s.json()) as { job: Job & { position: number }; capture: CaptureState | null };
    if (capture) opts.onProgress?.(capture, job);
    if (job.status === "failed") throw new Error(job.error ?? "the capture failed");
    if (job.status === "done") return { via: "server", url, job: job.id, result: job.result as CaptureRunResult };
  }
}
