import { isAbsolute } from "node:path";
import { DESKTOP_PROTOCOL, validAck } from "@scribui/core";

/**
 * `scribui://open?dir=<absolute path>` (`desktopOpenUrl` in core): how the
 * CLI (or a link) opens a project in the app. `scribui://new?dir=…`
 * (`desktopNewUrl`) opens the new-project dialog with that folder filled in.
 * Nothing in a link captures, writes to a project or runs its commands.
 */
export const PROTOCOL = DESKTOP_PROTOCOL;

export type Link = { action: "open" | "new"; dir: string; ack?: string };

/** What a link asks for, or null for anything else. */
export function parseLink(raw: string, absolute: (p: string) => boolean = isAbsolute): Link | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== `${PROTOCOL}:` || (u.hostname !== "open" && u.hostname !== "new")) return null;
  const dir = u.searchParams.get("dir");
  if (!dir || dir.includes("\0") || !absolute(dir)) return null;
  const ack = u.searchParams.get("ack");
  return { action: u.hostname, dir, ...(u.hostname === "new" && validAck(ack) ? { ack } : {}) };
}

/** The project folder an open link asks to open, or null for anything else. */
export function parseOpenUrl(raw: string, absolute: (p: string) => boolean = isAbsolute): string | null {
  const link = parseLink(raw, absolute);
  return link?.action === "open" ? link.dir : null;
}

/** The link among a launch's arguments (Windows and Linux pass it on the command line). */
export function findLink(argv: string[]): Link | null {
  for (const a of argv) {
    if (!a.startsWith(`${PROTOCOL}://`)) continue;
    const link = parseLink(a);
    if (link) return link;
  }
  return null;
}

export function findOpenUrl(argv: string[]): string | null {
  const link = findLink(argv);
  return link?.action === "open" ? link.dir : null;
}
