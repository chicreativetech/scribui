import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawElement } from "@scribui/core";
import { CaptureError, run } from "../exec.js";
import { parseIdb } from "../parsers/idb.js";
import { decodePng, encodePng, pixelDifference, rotatePixels, type DecodedPng } from "../png.js";
import { turnFor, uiOrientation, type SimOrientation } from "./iosScreen.js";
import type { LiveCaptureStep } from "./session.js";

/**
 * Live iOS Simulator capture, verified as on Android: screenshot right away,
 * read the accessibility tree, screenshot again; the same picture means the
 * tree belongs to it, a different one is retried from the newer frame.
 *
 * The framebuffer is always portrait while the tree is in the UI's own
 * points, so a turned UI's screenshot is turned upright before it's saved.
 */

export type IosLiveCapture = {
  png: Buffer;
  raw: RawElement;
  /** Pixels of the upright screenshot. */
  width: number;
  height: number;
  scale: number;
  orientation: SimOrientation;
  /** The frontmost app's name, from the tree's root. */
  app: string | null;
  settled: boolean;
  elements: boolean;
  attempts: number;
  change: number;
  firstPng: Buffer;
  lastPng: Buffer;
};

type Opts = {
  udid: string;
  /** Points → pixels (the device type's screen scale). */
  scale: number;
  /** The orientation the device was turned to (which landscape the tree's landscape frame is). */
  device: SimOrientation;
  /** The frontmost app's accessibility tree, nested, as scribui-sim returns it. */
  describe: () => Promise<unknown>;
  attempts?: number;
  maxChange?: number;
  signal?: AbortSignal;
  progress?: (step: LiveCaptureStep, attempt: number) => void;
};

/** `simctl io screenshot`: the framebuffer as an sRGB PNG, portrait. */
export async function simScreenshot(udid: string): Promise<Buffer> {
  const tmp = join(tmpdir(), `scribui-sim-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  try {
    const r = await run("xcrun", ["simctl", "io", udid, "screenshot", "--type=png", tmp], { timeoutMs: 30_000 });
    if (r.code !== 0) throw new CaptureError("the Simulator's screenshot failed", r.stderr);
    return await readFile(tmp);
  } finally {
    await rm(tmp, { force: true });
  }
}

export async function captureIosLive(o: Opts): Promise<IosLiveCapture> {
  const attempts = o.attempts ?? 4;
  const maxChange = o.maxChange ?? 0.002;
  const check = () => {
    if (o.signal?.aborted) throw new CaptureError("capture cancelled");
  };
  const shot = async () => {
    const png = await simScreenshot(o.udid);
    return { png, img: decodePng(png) };
  };

  o.progress?.("screenshot", 1);
  let first = await shot();
  const firstShot = first;
  let tree: unknown = null;
  let change = 1;
  let last = first;
  let attempt = 1;
  for (; attempt <= attempts; attempt++) {
    check();
    if (attempt > 1) o.progress?.("retrying", attempt);
    o.progress?.("elements", attempt);
    tree = await o.describe();
    check();
    o.progress?.("verifying", attempt);
    const second = await shot();
    last = second;
    change = pixelDifference(first.img, second.img);
    if (change <= maxChange) break;
    first = second;
  }
  const settled = change <= maxChange;
  const kept = settled ? first : firstShot;

  const roots = (Array.isArray(tree) ? tree : [tree]) as { frame?: { width: number; height: number }; AXLabel?: string | null }[];
  const rootFrame = roots[0]?.frame ?? null;
  const orientation = uiOrientation(rootFrame, o.device);
  const turn = turnFor(orientation);
  const upright = (img: DecodedPng, png: Buffer) => (turn ? encodePng(rotatePixels(img, turn)) : png);
  const png = upright(kept.img, kept.png);
  const turned = turn === 90 || turn === 270;
  const width = turned ? kept.img.height : kept.img.width;
  const height = turned ? kept.img.width : kept.img.height;

  let raw: RawElement;
  try {
    raw = clipToScreen(parseIdb(JSON.stringify(tree), o.scale), width, height);
  } catch (e) {
    throw new CaptureError("could not read the Simulator's accessibility tree", (e as Error).message);
  }
  return {
    png,
    raw,
    width,
    height,
    scale: o.scale,
    orientation,
    app: roots[0]?.AXLabel?.trim() || null,
    settled,
    elements: true,
    attempts: Math.min(attempt, attempts),
    change,
    firstPng: upright(firstShot.img, firstShot.png),
    lastPng: upright(last.img, last.png),
  };
}

/** The root spans the screenshot; elements reported off-screen (scrolled away) are dropped. */
function clipToScreen(raw: RawElement, width: number, height: number): RawElement {
  const on = (e: RawElement) => e.bounds.x < width && e.bounds.y < height && e.bounds.x + e.bounds.w > 0 && e.bounds.y + e.bounds.h > 0;
  const visit = (e: RawElement): RawElement => ({ ...e, children: e.children.filter(on).map(visit) });
  return { ...visit(raw), bounds: { x: 0, y: 0, w: width, h: height } };
}
