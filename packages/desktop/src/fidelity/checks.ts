import { resolveAll, type ScreenCapture, type UIElement } from "@scribui/core";
import { decodePng, pixelDifference, type DecodedPng } from "@scribui/capture";

/**
 * The capture-fidelity checks (plan §5), free of Electron and devices so they
 * can be tested: where a probe colour really is in a screenshot against where
 * the element tree says it is, whether a mark around it resolves to it, the
 * raw colour values, and pixel differences between two capture paths.
 */

export type Box = { x: number; y: number; w: number; h: number };
export type Rgb = [number, number, number];

/** Bounding box of the pixels within `tol` of a colour (raw values, no colour management). */
export function colourBox(img: DecodedPng, rgb: Rgb, tol = 24): Box | null {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  const { width, height, channels, data } = img;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      if (Math.abs(data[i]! - rgb[0]) <= tol && Math.abs(data[i + 1]! - rgb[1]) <= tol && Math.abs(data[i + 2]! - rgb[2]) <= tol) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** The colour at a box's centre, as #rrggbb. */
export function colourAt(img: DecodedPng, b: Box): string {
  const i = ((b.y + (b.h >> 1)) * img.width + b.x + (b.w >> 1)) * img.channels;
  return "#" + [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!].map((v) => v.toString(16).padStart(2, "0")).join("");
}

export const flatten = (el: UIElement, out: UIElement[] = []) => {
  out.push(el);
  for (const c of el.children) flatten(c, out);
  return out;
};

/** The element whose id or label matches. */
export function findElement(cap: ScreenCapture, match: RegExp): UIElement | null {
  return flatten(cap.root).find((e) => match.test(e.id) || match.test(e.label ?? "")) ?? null;
}

const maxDelta = (a: Box, b: Box) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.w - b.w), Math.abs(a.h - b.h));

export type ProbeResult = {
  name: string;
  /** Where the tree has it and where its colour is, in screenshot pixels. */
  tree: Box | null;
  pixels: Box | null;
  /** Largest edge difference in pixels; null when either is missing. */
  deltaPx: number | null;
  ok: boolean;
};

/**
 * A probe: an element filled with one pure colour. Its tree bounds must match
 * the coloured pixels within `tolerancePx` (anti-aliased edges of transformed
 * elements need a pixel or two).
 */
export function checkProbe(
  cap: ScreenCapture,
  img: DecodedPng,
  probe: { name: string; match: RegExp; rgb: Rgb; tolerancePx?: number; bottomOnly?: boolean },
): ProbeResult {
  const el = findElement(cap, probe.match);
  const seen = colourBox(img, probe.rgb);
  const tree = el ? el.bounds : null;
  // bottomOnly: the colour also shows around the element (Safari paints a sticky header's colour
  // behind the status bar and into the side safe areas): only its bottom edge can be compared
  const edges = (b: Box) => (probe.bottomOnly ? { x: 0, y: b.y + b.h, w: 0, h: 0 } : b);
  const deltaPx = tree && seen ? +maxDelta(edges(tree), edges(seen)).toFixed(2) : null;
  return { name: probe.name, tree, pixels: seen, deltaPx, ok: deltaPx !== null && deltaPx <= (probe.tolerancePx ?? 1) };
}

/** A circle drawn just around an element resolves to that element. */
export function markResolves(cap: ScreenCapture, el: UIElement): { target: string | null; label: string | null; ok: boolean } {
  const b = el.bounds;
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const points: [number, number][] = Array.from({ length: 24 }, (_, i) => {
    const a = (i / 24) * Math.PI * 2;
    return [cx + Math.cos(a) * (b.w / 2 + 12), cy + Math.sin(a) * (b.h / 2 + 12)];
  });
  const [a] = resolveAll([{ id: "m", screenId: cap.screenId, kind: "circle", geometry: { type: "path", points } }], new Map([[cap.screenId, cap.root]]));
  const target = a?.resolution?.elements[0] ?? null;
  const label = target ? (flatten(cap.root).find((e) => e.id === target)?.label ?? null) : null;
  return { target, label, ok: target === el.id };
}

/** Two capture paths' pictures of the same page: share of differing pixels (tolerance 8 per channel). */
export function comparePixels(a: DecodedPng, b: DecodedPng) {
  if (a.width !== b.width || a.height !== b.height) return { sameSize: false as const, a: `${a.width}×${a.height}`, b: `${b.width}×${b.height}`, differingPct: 100 };
  return { sameSize: true as const, size: `${a.width}×${a.height}`, differingPct: +(pixelDifference(a, b) * 100).toFixed(3) };
}

/** Two trees of the same page: elements matched by id and the largest bounds difference. */
export function compareTrees(a: ScreenCapture, b: ScreenCapture) {
  const A = new Map(flatten(a.root).map((e) => [e.id, e]));
  const B = new Map(flatten(b.root).map((e) => [e.id, e]));
  let matched = 0;
  let delta = 0;
  for (const [id, ea] of A) {
    const eb = B.get(id);
    if (!eb) continue;
    matched++;
    delta = Math.max(delta, maxDelta(ea.bounds, eb.bounds));
  }
  return {
    elements: [A.size, B.size],
    matched,
    onlyFirst: [...A.keys()].filter((k) => !B.has(k)).slice(0, 8),
    onlySecond: [...B.keys()].filter((k) => !A.has(k)).slice(0, 8),
    maxBoundsDeltaPx: +delta.toFixed(2),
  };
}

export const decode = (png: Uint8Array) => decodePng(png);

/** A named check with its verdict; the suites' reports are lists of these. */
export type Check = { name: string; ok: boolean; detail?: unknown };

export function summary(checks: Check[]) {
  const failed = checks.filter((c) => !c.ok);
  return { total: checks.length, passed: checks.length - failed.length, failed: failed.map((c) => c.name) };
}

/**
 * On GitHub Actions, failed checks as error annotations and the result as a
 * notice: they show on the run's page (and through the API) without its log.
 */
export function announce(suite: string, checks: Check[]) {
  if (!process.env.GITHUB_ACTIONS) return;
  const esc = (v: string) => v.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  for (const c of checks.filter((x) => !x.ok))
    console.log(`::error title=${esc(`fidelity ${suite}`)}::${esc(`${c.name}: ${JSON.stringify(c.detail ?? null).slice(0, 600)}`)}`);
  const s = summary(checks);
  console.log(`::notice title=${esc(`fidelity ${suite}`)}::${s.passed}/${s.total} checks passed`);
}
