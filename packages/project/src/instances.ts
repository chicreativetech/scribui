import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { startServer, type ServerOptions } from "@scribui/server";

/**
 * One ScribUI server per project. Each running server records its port in
 * ~/.scribui/servers/, so a second `scribui` in the same project finds it
 * even when it was started with a custom --port.
 */

const SERVERS_DIR = join(homedir(), ".scribui", "servers");
const PORT_RANGE = 10;

const recordFile = (root: string) => join(SERVERS_DIR, `${createHash("sha1").update(root).digest("hex").slice(0, 16)}.json`);

/** The canvas URL of a server already running for this project, if any. */
export async function findRunning(root: string, port: number): Promise<string | null> {
  const ports = new Set<number>();
  try {
    const rec = JSON.parse(readFileSync(recordFile(root), "utf8")) as { port?: number };
    if (rec.port) ports.add(rec.port);
  } catch {
    /* no record */
  }
  for (let p = port; p < port + PORT_RANGE; p++) ports.add(p);
  for (const p of ports) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/api/project`, { signal: AbortSignal.timeout(500) });
      const body = (await r.json()) as { root?: string };
      if (body.root === root) return `http://127.0.0.1:${p}/`;
    } catch {
      /* free or someone else */
    }
  }
  return null;
}

/**
 * Start the server on `port`, or the next free one within the range. Returns
 * null when every port in the range is taken.
 */
export async function startOnFreePort(opts: ServerOptions & { port: number }) {
  for (let p = opts.port; p < opts.port + PORT_RANGE; p++) {
    let srv: Awaited<ReturnType<typeof startServer>>;
    try {
      srv = await startServer({ ...opts, port: p });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") continue;
      throw e;
    }
    const file = recordFile(opts.projectDir);
    try {
      mkdirSync(SERVERS_DIR, { recursive: true });
      writeFileSync(file, JSON.stringify({ root: opts.projectDir, port: srv.port, pid: process.pid }) + "\n");
    } catch {
      /* only used to find this server again */
    }
    const close = srv.close;
    return {
      ...srv,
      close: async () => {
        rmSync(file, { force: true });
        await close();
      },
    };
  }
  return null;
}

export const portRange = (port: number) => `${port}–${port + PORT_RANGE - 1}`;
