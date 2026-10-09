import { describe, expect, it } from "vitest";
import { dilate, floodFill, growInto, traceLoops, type Raster } from "../src/index.js";

/** A raster from rows of text: "#" is drawn. */
const raster = (rows: string[]): Raster => {
  const w = rows[0]!.length;
  const data = new Uint8Array(w * rows.length);
  rows.forEach((r, y) => [...r].forEach((c, x) => (data[y * w + x] = c === "#" ? 1 : 0)));
  return { w, h: rows.length, data };
};

/** A w × h square outline, with `gap` pixels missing from its right side. */
function square(w: number, h: number, gap = 0): Raster {
  const data = new Uint8Array(w * h);
  for (let x = 4; x < w - 4; x++) data[4 * w + x] = data[(h - 5) * w + x] = 1;
  for (let y = 4; y < h - 4; y++) {
    data[y * w + 4] = 1;
    if (y < h / 2 || y >= h / 2 + gap) data[y * w + w - 5] = 1;
  }
  return { w, h, data };
}

describe("paint bucket", () => {
  it("fills the inside of a closed shape, not the outside", () => {
    const f = floodFill(square(40, 30), 20, 15)!;
    expect(f.touchesEdge).toBe(false);
    expect(f.count).toBe(30 * 20);
    expect(floodFill(square(40, 30), 1, 1)!.touchesEdge).toBe(true);
    expect(floodFill(square(40, 30), 4, 10)).toBeNull();
  });

  it("leaks through a gap, unless the lines are grown to close it", () => {
    expect(floodFill(square(40, 30, 3), 20, 15)!.touchesEdge).toBe(true);
    expect(floodFill(dilate(square(40, 30, 3), 2), 20, 15)!.touchesEdge).toBe(false);
  });

  it("grows a fill back into the band along the lines, never across one", () => {
    const lines = square(40, 30);
    const closed = dilate(lines, 2);
    const band = { w: 40, h: 30, data: closed.data.map((d, i) => (d && !lines.data[i] ? 1 : 0)) };
    const f = floodFill(closed, 20, 15)!;
    expect(f.count).toBe(26 * 16);
    const grown = growInto(f.mask, band, 8);
    expect(grown.data.reduce((a, b) => a + b, 0)).toBe(30 * 20);
  });

  it("traces a filled area into an outline, with its holes", () => {
    const ring = raster([
      "........",
      ".######.",
      ".######.",
      ".##..##.",
      ".##..##.",
      ".######.",
      "........",
    ]);
    const loops = traceLoops(ring, 0.1);
    expect(loops).toHaveLength(2);
    const area = (l: [number, number][]) => Math.abs(l.reduce((s, [x, y], i) => s + x * l[(i + 1) % l.length]![1] - l[(i + 1) % l.length]![0] * y, 0) / 2);
    expect(loops.map(area).sort((a, b) => a - b)).toEqual([4, 30]);
    // a rectangle is four corners
    expect(loops.find((l) => area(l) === 30)).toHaveLength(4);
  });
});
