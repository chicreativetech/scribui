import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Where project windows open: maximized the first time, then the way the last one was left
 * (size, position, maximized or full screen). Pure apart from the file, so it's testable
 * without Electron.
 */

export type Box = { x: number; y: number; width: number; height: number };
export type WindowState = { bounds?: Box; maximized?: boolean; fullScreen?: boolean };
export type Placement = { bounds?: Box; maximized: boolean; fullScreen: boolean };

/** Pixels each further open window moves down and right, so it doesn't hide the one before. */
const CASCADE = 28;
/** At least this much of a saved window must be on a display for the position to be kept. */
const VISIBLE = 120;

export function readWindowState(file: string): WindowState {
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as WindowState;
    return typeof s === "object" && s ? s : {};
  } catch {
    return {};
  }
}

export function writeWindowState(file: string, s: WindowState) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(s));
  } catch {
    /* not saved: the next window opens maximized */
  }
}

const overlap = (a: Box, b: Box) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/**
 * How to open a project window. Nothing saved: maximized. Saved bounds are kept when they're
 * still on a display (a monitor may have been unplugged), shrunk to fit it, and cascaded when
 * `open` other project windows are already showing.
 */
export function placeWindow(saved: WindowState, workAreas: Box[], open = 0): Placement {
  const b = saved.bounds;
  const valid = !!b && [b.x, b.y, b.width, b.height].every(Number.isFinite) && b.width > 0 && b.height > 0;
  if (!valid || saved.maximized || !workAreas.length) return { maximized: !valid || !!saved.maximized, fullScreen: !!saved.fullScreen, ...(valid && !saved.maximized ? { bounds: b } : {}) };
  // the display it was on, or failing that the first one
  const area = [...workAreas].sort((p, q) => overlap(b, q) - overlap(b, p))[0]!;
  const onScreen = overlap(b, area) >= Math.min(VISIBLE * VISIBLE, b.width * b.height);
  const width = Math.min(b.width, area.width);
  const height = Math.min(b.height, area.height);
  let x = onScreen ? b.x : area.x + Math.round((area.width - width) / 2);
  let y = onScreen ? b.y : area.y + Math.round((area.height - height) / 2);
  x += open * CASCADE;
  y += open * CASCADE;
  // keep it inside the display
  x = Math.max(area.x, Math.min(x, area.x + area.width - width));
  y = Math.max(area.y, Math.min(y, area.y + area.height - height));
  return { bounds: { x, y, width, height }, maximized: false, fullScreen: !!saved.fullScreen };
}
