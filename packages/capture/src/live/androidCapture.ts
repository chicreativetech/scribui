import type { RawElement } from "@scribui/core";
import { CaptureError, run } from "../exec.js";
import { parseUiautomator } from "../parsers/uiautomator.js";
import { decodePng, pixelDifference } from "../png.js";
import { addKeyboard, parseInputShown, parseKeyboardFrame, parseRotation } from "./androidScreen.js";
import type { Rotation } from "./session.js";

/**
 * Live Android capture: the frame on screen when the user pressed Capture,
 * checked against the element tree.
 *
 * 1. screenshot right away (what the user saw)
 * 2. read the element tree (uiautomator)
 * 3. screenshot again; same picture: the tree belongs to the first frame
 * 4. different: the screen was still changing; try again from the newer frame,
 *    up to `attempts` times, then give back the first frame marked unsettled
 *
 * A blinking caret or a ticking clock changes a few pixels without moving any
 * element, so "same" allows a small share of changed pixels (`maxChange`).
 * A keyboard on screen is added to the tree (uiautomator leaves it out).
 */

export type AndroidCaptureStep = "screenshot" | "elements" | "verifying" | "retrying";

export type AndroidLiveCapture = {
  /** The PNG of the frame the tree was verified against (the first one when unsettled). */
  png: Buffer;
  raw: RawElement;
  width: number;
  height: number;
  /** Logical pixels per device pixel's inverse: dpi / 160. */
  scale: number;
  model: string;
  /** The tree matched the frame (both screenshots agreed). */
  settled: boolean;
  /** uiautomator could read the screen; false when it never went idle (the tree is then just the screen). */
  elements: boolean;
  attempts: number;
  /** Changed pixels between the last pair of screenshots, 0–1. */
  change: number;
  /** The very first frame, kept as the preview when unsettled. */
  firstPng: Buffer;
  /** The last screenshot taken: what the screen had changed to (equals `png` when settled). */
  lastPng: Buffer;
  rotation: Rotation;
  /** The on-screen keyboard was up (and is in the tree). */
  keyboard: boolean;
};

type Adb = (args: string[], timeoutMs?: number) => ReturnType<typeof run>;

type Opts = {
  adb?: string;
  serial: string;
  attempts?: number;
  maxChange?: number;
  signal?: AbortSignal;
  progress?: (step: AndroidCaptureStep, attempt: number) => void;
};

export async function captureAndroidLive(o: Opts): Promise<AndroidLiveCapture> {
  const adb = (args: string[], timeoutMs = 30_000) => run(o.adb ?? "adb", ["-s", o.serial, ...args], { timeoutMs });
  const attempts = o.attempts ?? 4;
  const maxChange = o.maxChange ?? 0.002;
  const check = () => {
    if (o.signal?.aborted) throw new CaptureError("capture cancelled");
  };

  const shot = async () => {
    const s = await adb(["exec-out", "screencap", "-p"]);
    if (s.code !== 0 || s.stdout.length < 24) throw new CaptureError("screencap failed", s.stderr);
    return s.stdout as Buffer;
  };

  o.progress?.("screenshot", 1);
  let first = await shot();
  const firstPng = first;
  let raw: RawElement | null = null;
  let change = 1;
  let attempt = 1;
  let last = first;
  for (; attempt <= attempts; attempt++) {
    check();
    if (attempt > 1) o.progress?.("retrying", attempt);
    o.progress?.("elements", attempt);
    try {
      raw = await dumpTree(adb);
    } catch (e) {
      if (!(e instanceof NotIdleError)) throw e;
      // a running timer, a video, a spinner: uiautomator can't read it at all; keep the
      // pictures, without elements (marks on it become regions)
      check();
      o.progress?.("verifying", attempt);
      last = await shot();
      raw = null;
      change = 1;
      break;
    }
    check();
    o.progress?.("verifying", attempt);
    const second = await shot();
    last = second;
    change = pixelDifference(decodePng(first), decodePng(second));
    if (change <= maxChange) break;
    first = second; // the screen moved: the newer frame is the next candidate
  }
  const settled = raw !== null && change <= maxChange;
  const png = settled ? first : firstPng;
  const img = decodePng(png);
  const elements = raw !== null;
  raw ??= { type: "screen", bounds: { x: 0, y: 0, w: img.width, h: img.height }, children: [] };
  const kb = await readKeyboard(adb);
  if (kb) raw = addKeyboard(raw, kb);

  const dens = await adb(["shell", "wm", "density"]);
  const dpi = Number(/(\d+)\s*$/.exec(dens.stdout.toString().trim())?.[1] ?? 160);
  const model = (await adb(["shell", "getprop", "ro.product.model"])).stdout.toString().trim();
  return {
    png,
    raw,
    width: img.width,
    height: img.height,
    scale: Math.round((dpi / 160) * 100) / 100 || 1,
    model: model || o.serial,
    settled,
    elements,
    attempts: Math.min(attempt, attempts),
    change,
    firstPng,
    lastPng: last,
    rotation: await readRotation(adb, img.width > img.height),
    keyboard: !!kb,
  };
}

/** The keyboard's visible area when it's up, in screen pixels. */
export async function readKeyboard(adb: Adb) {
  const shown = await adb(["shell", "dumpsys", "input_method"]);
  if (!parseInputShown(shown.stdout.toString())) return null;
  return parseKeyboardFrame((await adb(["shell", "dumpsys", "window", "InputMethod"])).stdout.toString());
}

/** The display's rotation; a guess from the screen's shape when dumpsys doesn't say. */
export async function readRotation(adb: Adb, landscape: boolean): Promise<Rotation> {
  const d = await adb(["shell", "dumpsys", "window", "displays"]);
  return parseRotation(d.stdout.toString()) ?? (landscape ? 90 : 0);
}

/** uiautomator waits for the screen to go idle and gives up on one that never does. */
export class NotIdleError extends CaptureError {}

/**
 * The current screen's element tree. A failed dump ("null root node"
 * mid-transition) exits 0 and leaves the previous file: delete it first and
 * retry until a dump really succeeds. A screen that never goes idle fails
 * each try after about 10 s: two of those and it's a `NotIdleError`.
 */
export async function dumpTree(adb: Adb): Promise<RawElement> {
  let last = "";
  let notIdle = 0;
  for (let i = 0; i < 6; i++) {
    if (i) await new Promise((r) => setTimeout(r, 400));
    await adb(["shell", "rm", "-f", "/sdcard/scribui_live.xml"]);
    const d = await adb(["shell", "uiautomator", "dump", "/sdcard/scribui_live.xml"], 60_000);
    const msg = `${d.stdout.toString()}${d.stderr}`;
    if (d.code !== 0 || /ERROR/i.test(msg)) {
      last = msg.trim();
      if (/could not get idle state/i.test(msg) && ++notIdle >= 2)
        throw new NotIdleError("the screen never stops changing, so its elements can't be read (uiautomator)", last);
      continue;
    }
    const x = await adb(["exec-out", "cat", "/sdcard/scribui_live.xml"]);
    if (x.code === 0 && x.stdout.length > 0) return parseUiautomator(x.stdout.toString());
  }
  throw new CaptureError("could not read the screen's element tree (uiautomator)", last);
}
