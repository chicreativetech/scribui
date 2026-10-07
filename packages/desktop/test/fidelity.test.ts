import { describe, expect, it } from "vitest";
import type { ScreenCapture, UIElement } from "@scribui/core";
import { checkProbe, colourAt, colourBox, comparePixels, compareTrees, markResolves, summary } from "../src/fidelity/checks.js";

/** A white RGB image with coloured rectangles. */
function image(w: number, h: number, rects: { x: number; y: number; w: number; h: number; rgb: [number, number, number] }[]) {
  const data = new Uint8Array(w * h * 3).fill(255);
  for (const r of rects)
    for (let y = r.y; y < r.y + r.h; y++)
      for (let x = r.x; x < r.x + r.w; x++) data.set(r.rgb, (y * w + x) * 3);
  return { width: w, height: h, channels: 3 as const, data, hasColourProfile: false };
}

const el = (id: string, x: number, y: number, w: number, h: number, children: UIElement[] = []): UIElement =>
  ({ id, idSource: "generated", type: id === "root" ? "screen" : "container", bounds: { x, y, w, h }, visible: true, children }) as unknown as UIElement;

const capture = (root: UIElement): ScreenCapture =>
  ({ screenId: "s", platform: "web", device: { name: "t", width: 100, height: 80, scale: 1 }, screenshot: "s.png", root }) as unknown as ScreenCapture;

const MAGENTA: [number, number, number] = [255, 0, 255];

describe("fidelity checks", () => {
  const img = image(100, 80, [{ x: 20, y: 10, w: 30, h: 20, rgb: MAGENTA }]);

  it("finds a probe colour's pixels", () => {
    expect(colourBox(img, MAGENTA)).toEqual({ x: 20, y: 10, w: 30, h: 20 });
    expect(colourAt(img, { x: 20, y: 10, w: 30, h: 20 })).toBe("#ff00ff");
    expect(colourBox(img, [0, 255, 255])).toBeNull();
  });

  it("passes a probe whose tree bounds match its pixels, and fails one that's off", () => {
    const at = (x: number) => capture(el("root", 0, 0, 100, 80, [el("probe", x, 10, 30, 20)]));
    expect(checkProbe(at(20), img, { name: "p", match: /^probe$/, rgb: MAGENTA })).toMatchObject({ ok: true, deltaPx: 0 });
    expect(checkProbe(at(21), img, { name: "p", match: /^probe$/, rgb: MAGENTA })).toMatchObject({ ok: true, deltaPx: 1 });
    expect(checkProbe(at(23), img, { name: "p", match: /^probe$/, rgb: MAGENTA })).toMatchObject({ ok: false, deltaPx: 3 });
    expect(checkProbe(at(23), img, { name: "p", match: /^probe$/, rgb: MAGENTA, tolerancePx: 3 }).ok).toBe(true);
    // missing in the tree or in the picture
    expect(checkProbe(capture(el("root", 0, 0, 100, 80)), img, { name: "p", match: /^probe$/, rgb: MAGENTA })).toMatchObject({ ok: false, deltaPx: null });
  });

  it("checks that a circle around an element resolves to it", () => {
    const probe = el("probe", 20, 10, 30, 20);
    const cap = capture(el("root", 0, 0, 100, 80, [probe, el("other", 60, 40, 30, 30)]));
    expect(markResolves(cap, probe)).toMatchObject({ ok: true, target: "probe" });
  });

  it("compares two paths' pictures and trees", () => {
    const other = image(100, 80, [{ x: 20, y: 10, w: 30, h: 21, rgb: MAGENTA }]);
    expect(comparePixels(img, img)).toEqual({ sameSize: true, size: "100×80", differingPct: 0 });
    expect(comparePixels(img, other).differingPct).toBe(0.375); // 30 of 8000 pixels
    expect(comparePixels(img, image(50, 80, [])).sameSize).toBe(false);
    const a = capture(el("root", 0, 0, 100, 80, [el("probe", 20, 10, 30, 20), el("x", 0, 0, 5, 5)]));
    const b = capture(el("root", 0, 0, 100, 80, [el("probe", 20, 12, 30, 20)]));
    expect(compareTrees(a, b)).toMatchObject({ matched: 2, onlyFirst: ["x"], maxBoundsDeltaPx: 2 });
  });

  it("summarises a run", () => {
    expect(summary([{ name: "a", ok: true }, { name: "b", ok: false }])).toEqual({ total: 2, passed: 1, failed: ["b"] });
  });
});
