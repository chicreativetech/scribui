import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Which one-time hints (like the Capture Screens intro card) this user has
 * seen, across projects: the canvas's own storage is per port, so per
 * project. A missing or broken file means none.
 */

const validId = (id: unknown): id is string => typeof id === "string" && /^[a-z0-9-]{1,40}$/.test(id);

export function readSeen(file: string): string[] {
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as { seen?: unknown };
    return Array.isArray(v.seen) ? v.seen.filter(validId) : [];
  } catch {
    return [];
  }
}

export function hintSeen(file: string, id: unknown): boolean {
  return validId(id) && readSeen(file).includes(id);
}

export function markSeen(file: string, id: unknown) {
  if (!validId(id)) return;
  const seen = readSeen(file);
  if (seen.includes(id)) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ seen: [...seen, id] }, null, 2));
  } catch {
    /* shown again next time */
  }
}
