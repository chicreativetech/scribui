import { isAbsolute } from "node:path";
import { DESKTOP_PROTOCOL } from "@scribui/core";

/**
 * `scribui://open?dir=<absolute path>` (`desktopOpenUrl` in core): how the
 * CLI (or a link) opens a project in the app. Only opening is supported; nothing in a link captures or
 * runs a project's commands.
 */
export const PROTOCOL = DESKTOP_PROTOCOL;

/** The project folder a link asks to open, or null for anything else. */
export function parseOpenUrl(raw: string, absolute: (p: string) => boolean = isAbsolute): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== `${PROTOCOL}:` || u.hostname !== "open") return null;
  const dir = u.searchParams.get("dir");
  if (!dir || dir.includes("\0") || !absolute(dir)) return null;
  return dir;
}

/** The link among a launch's arguments (Windows and Linux pass it on the command line). */
export function findOpenUrl(argv: string[]): string | null {
  for (const a of argv) {
    if (!a.startsWith(`${PROTOCOL}://`)) continue;
    const dir = parseOpenUrl(a);
    if (dir) return dir;
  }
  return null;
}
