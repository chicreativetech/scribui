import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { ScreenEntry } from "@intentcue/core";

const exec = promisify(execFile);

const WALK_SKIP = new Set([
  ".git", ".intentcue", "node_modules", "build", "dist", ".gradle", ".kotlin", ".idea", ".next", ".expo",
  "Pods", "DerivedData", ".dart_tool", "coverage", ".turbo", ".cache",
]);
const MAX_FILES = 50_000;

/**
 * Project files modified after `sinceMs`, relative with "/" separators.
 * Uses git (respecting .gitignore) when available, else a bounded walk.
 * Returns null when the project can't be scanned.
 */
export async function changedFilesSince(root: string, sinceMs: number): Promise<string[] | null> {
  let files: string[] | null = null;
  try {
    const { stdout } = await exec("git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      maxBuffer: 64 * 1024 * 1024,
    });
    files = stdout.split("\0").filter(Boolean);
  } catch {
    files = await walk(root);
  }
  if (!files) return null;
  const out: string[] = [];
  const BATCH = 256;
  for (let i = 0; i < files.length; i += BATCH) {
    const slice = files.slice(i, i + BATCH);
    const stats = await Promise.all(slice.map((f) => stat(join(root, f)).catch(() => null)));
    stats.forEach((s, j) => {
      if (s && s.isFile() && s.mtimeMs > sinceMs) out.push(slice[j]!.split(sep).join("/"));
    });
  }
  return out.sort();
}

async function walk(root: string): Promise<string[] | null> {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!WALK_SKIP.has(e.name) && !e.name.startsWith(".")) stack.push(join(dir, e.name));
      } else if (e.isFile()) {
        out.push(relative(root, join(dir, e.name)));
        if (out.length > MAX_FILES) return null;
      }
    }
  }
  return out;
}

/** Fingerprint of what decides how a screen is reached: its manifest entry plus flow and setup files. */
export async function screenFingerprint(reviewDir: string, s: ScreenEntry): Promise<string> {
  const h = createHash("sha1");
  h.update(JSON.stringify({ flow: s.flow, url: s.url, viewport: s.viewport, setup: s.setup }));
  for (const f of [s.flow, s.setup]) {
    if (!f) continue;
    const p = resolve(reviewDir, f);
    if (existsSync(p)) h.update(await readFile(p).catch(() => Buffer.alloc(0)));
  }
  return h.digest("hex").slice(0, 16);
}
