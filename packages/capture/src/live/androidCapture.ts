import type { RawElement } from "@scribui/core";
import { CaptureError, run } from "../exec.js";
import { parseUiautomator } from "../parsers/uiautomator.js";
import { decodePng, pixelDifference } from "../png.js";

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
  attempts: number;
  /** Changed pixels between the last pair of screenshots, 0–1. */
  change: number;
  /** The very first frame, kept as the preview when unsettled. */
  firstPng: Buffer;
};

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
  for (; attempt <= attempts; attempt++) {
    check();
    if (attempt > 1) o.progress?.("retrying", attempt);
    o.progress?.("elements", attempt);
    raw = await dumpTree(adb);
    check();
    o.progress?.("verifying", attempt);
    const second = await shot();
    change = pixelDifference(decodePng(first), decodePng(second));
    if (change <= maxChange) break;
    first = second; // the screen moved: the newer frame is the next candidate
  }
  const settled = change <= maxChange;
  const png = settled ? first : firstPng;
  const img = decodePng(png);

  const dens = await adb(["shell", "wm", "density"]);
  const dpi = Number(/(\d+)\s*$/.exec(dens.stdout.toString().trim())?.[1] ?? 160);
  const model = (await adb(["shell", "getprop", "ro.product.model"])).stdout.toString().trim();
  return {
    png,
    raw: raw!,
    width: img.width,
    height: img.height,
    scale: Math.round((dpi / 160) * 100) / 100 || 1,
    model: model || o.serial,
    settled,
    attempts: Math.min(attempt, attempts),
    change,
    firstPng,
  };
}

/**
 * The current screen's element tree. A failed dump ("null root node"
 * mid-transition) exits 0 and leaves the previous file: delete it first and
 * retry until a dump really succeeds.
 */
export async function dumpTree(adb: (args: string[], timeoutMs?: number) => ReturnType<typeof run>): Promise<RawElement> {
  let last = "";
  for (let i = 0; i < 6; i++) {
    if (i) await new Promise((r) => setTimeout(r, 400));
    await adb(["shell", "rm", "-f", "/sdcard/scribui_live.xml"]);
    const d = await adb(["shell", "uiautomator", "dump", "/sdcard/scribui_live.xml"], 60_000);
    const msg = `${d.stdout.toString()}${d.stderr}`;
    if (d.code !== 0 || /ERROR/i.test(msg)) {
      last = msg.trim();
      continue;
    }
    const x = await adb(["exec-out", "cat", "/sdcard/scribui_live.xml"]);
    if (x.code === 0 && x.stdout.length > 0) return parseUiautomator(x.stdout.toString());
  }
  throw new CaptureError("could not read the screen's element tree (uiautomator)", last);
}
