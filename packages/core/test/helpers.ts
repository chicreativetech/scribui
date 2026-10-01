import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeTree, ScreenCapture, type RawElement, type UIElement } from "../src/index.js";

export const FIXTURES = join(import.meta.dirname, "../../../fixtures");

export function webCaptures(): Map<string, ScreenCapture> {
  const dir = join(FIXTURES, "web/checkout/trees");
  const out = new Map<string, ScreenCapture>();
  for (const f of readdirSync(dir).sort()) {
    const c = ScreenCapture.parse(JSON.parse(readFileSync(join(dir, f), "utf8")));
    out.set(c.screenId, c);
  }
  return out;
}

export function webTrees(): Map<string, UIElement> {
  return new Map([...webCaptures()].map(([id, c]) => [id, c.root]));
}

/** Build a small tree: screen 400×800 with helpers for children. */
export function el(
  type: string,
  bounds: [number, number, number, number],
  opts: { id?: string; label?: string; children?: RawElement[] } = {},
): RawElement {
  const [x, y, w, h] = bounds;
  const r: RawElement = { type, bounds: { x, y, w, h }, children: opts.children ?? [] };
  if (opts.id) {
    r.id = opts.id;
    r.idSource = "testId";
  }
  if (opts.label) r.label = opts.label;
  return r;
}

export function screen(children: RawElement[]): UIElement {
  return normalizeTree(el("screen", [0, 0, 400, 800], { children }));
}

export const ellipse = (cx: number, cy: number, rx: number, ry: number, n = 32): [number, number][] =>
  Array.from({ length: n + 1 }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry];
  });
