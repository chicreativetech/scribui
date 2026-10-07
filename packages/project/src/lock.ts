import { appendFileSync, existsSync, linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

/**
 * One owner per project: `.scribui/.lock`. The owner is either a server (the
 * CLI's `scribui`/`scribui open`, or the desktop app), which serializes every
 * capture, or a one-off capture (`scribui capture`, MCP) running while no
 * server owns the project.
 *
 * The file is written to a temporary name and hard-linked into place: `link()`
 * fails when the target exists, so taking the lock is exclusive (like O_EXCL)
 * and nobody ever reads a half-written lock. A lock whose process is gone is
 * renamed aside before it is replaced, so only one process can take it over.
 */

export const LOCK_FILE = ".lock";

export type LockRole = "server" | "capture";

export type LockInfo = {
  pid: number;
  host: string;
  role: LockRole;
  /** Who holds it: "cli", "desktop", "mcp". */
  app: string;
  /** A server's port, once it listens. */
  port?: number;
  startedAt: string;
};

export type AcquireResult = { lock: ProjectLock } | { held: LockInfo };

const lockPath = (reviewDir: string) => join(reviewDir, LOCK_FILE);

/** The lock belongs to one machine and one moment: keep it out of git (`.scribui/.gitignore`). */
export function ignoreLockInGit(reviewDir: string) {
  const p = join(reviewDir, ".gitignore");
  const cur = existsSync(p) ? readFileSync(p, "utf8") : "";
  if (cur.split(/\r?\n/).some((l) => l.trim() === `${LOCK_FILE}*`)) return;
  try {
    appendFileSync(p, `${cur && !cur.endsWith("\n") ? "\n" : ""}# ScribUI: who owns this project right now\n${LOCK_FILE}*\n`);
  } catch {
    /* read-only checkout: nothing to keep out */
  }
}

/** The lock as written, or null when there is none (or it can't be read). */
export function readLock(reviewDir: string): LockInfo | null {
  try {
    const v = JSON.parse(readFileSync(lockPath(reviewDir), "utf8")) as LockInfo;
    return typeof v.pid === "number" && typeof v.role === "string" ? v : null;
  } catch {
    return null;
  }
}

/**
 * Whether the lock's process still runs. A lock from another machine (a
 * shared folder) can't be checked from here and counts as alive.
 */
export function lockAlive(info: LockInfo): boolean {
  if (info.host !== hostname()) return true;
  try {
    process.kill(info.pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists but belongs to someone else
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class ProjectLock {
  private released = false;
  private onExit = () => this.releaseSync();

  private constructor(
    readonly reviewDir: string,
    public info: LockInfo,
  ) {
    process.once("exit", this.onExit);
  }

  /** Take the lock, or report who holds it. Stale locks (their process is gone) are taken over. */
  static acquire(reviewDir: string, owner: { role: LockRole; app: string; port?: number }): AcquireResult {
    const info: LockInfo = { pid: process.pid, host: hostname(), role: owner.role, app: owner.app, startedAt: new Date().toISOString(), ...(owner.port ? { port: owner.port } : {}) };
    const target = lockPath(reviewDir);
    for (let attempt = 0; attempt < 5; attempt++) {
      if (tryCreate(target, info)) return { lock: new ProjectLock(reviewDir, info) };
      const cur = readLock(reviewDir);
      if (cur && lockAlive(cur)) return { held: cur };
      // stale or unreadable: move it aside; if that fails, someone else just did
      const aside = `${target}.stale-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        renameSync(target, aside);
        unlinkSync(aside);
      } catch {
        /* taken over or removed by another process: try again */
      }
    }
    const cur = readLock(reviewDir);
    if (cur) return { held: cur };
    throw new Error(`could not take ${lockPath(reviewDir)}`);
  }

  /** Change what the lock says (a server's port once it listens). Only the owner writes it. */
  update(patch: Partial<Pick<LockInfo, "port" | "role">>) {
    if (this.released) return;
    this.info = { ...this.info, ...patch };
    const target = lockPath(this.reviewDir);
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.info, null, 2) + "\n");
    renameSync(tmp, target);
  }

  /** Give the lock up, unless another process has already taken it over. */
  release() {
    this.releaseSync();
  }

  private releaseSync() {
    if (this.released) return;
    this.released = true;
    process.off("exit", this.onExit);
    const cur = readLock(this.reviewDir);
    if (cur && cur.pid === this.info.pid && cur.startedAt === this.info.startedAt) {
      try {
        unlinkSync(lockPath(this.reviewDir));
      } catch {
        /* already gone */
      }
    }
  }
}

/** Write `info` to a temp file and link it into place: false when the lock exists. */
function tryCreate(target: string, info: LockInfo): boolean {
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.new`;
  writeFileSync(tmp, JSON.stringify(info, null, 2) + "\n");
  try {
    linkSync(tmp, target);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* gone */
    }
  }
}
