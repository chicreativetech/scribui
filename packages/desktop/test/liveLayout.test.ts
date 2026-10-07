import { describe, expect, it } from "vitest";
import { fitZoom, layoutLiveView, MARGIN, scaleRect } from "../src/liveLayout.js";

const area = { x: 6, y: 91, width: 1130, height: 737 };
/** What the page is laid out at for a view size and zoom: the same whether Chromium floors or rounds. */
const css = (px: number, zoom: number) => {
  const v = px / zoom;
  expect(Math.floor(v)).toBe(Math.round(v));
  return Math.floor(v);
};

describe("layoutLiveView", () => {
  it("fills the area when no size is chosen", () => {
    expect(layoutLiveView(area, null)).toEqual({ bounds: area, zoom: 1 });
  });

  it("centres a size that fits, below a margin, unscaled", () => {
    const l = layoutLiveView(area, { width: 390, height: 600 });
    expect(l.zoom).toBe(1);
    expect(l.bounds).toEqual({ x: 6 + Math.round((1130 - 390) / 2), y: 91 + MARGIN, width: 390, height: 600 });
  });

  it("scales a size larger than the room, centred, inside the margins", () => {
    const l = layoutLiveView(area, { width: 1440, height: 900 });
    expect(l.zoom).toBeLessThan(1);
    expect(l.bounds.width).toBeLessThanOrEqual(1130 - 2 * MARGIN + 1);
    expect(l.bounds.height).toBeLessThanOrEqual(737 - 2 * MARGIN + 1);
    expect(css(l.bounds.width, l.zoom)).toBe(1440);
    expect(css(l.bounds.height, l.zoom)).toBe(900);
  });
});

describe("fitZoom", () => {
  it("gives the page exactly the chosen size across sizes and rooms", () => {
    const sizes = [
      { width: 390, height: 844 },
      { width: 1440, height: 900 },
      { width: 1280, height: 800 },
      { width: 834, height: 1194 },
      { width: 1920, height: 1080 },
    ];
    for (const size of sizes)
      for (let want = 0.3; want < 1; want += 0.0137) {
        const f = fitZoom(size, want);
        expect(css(f.width, f.zoom), `${size.width}@${want}`).toBe(size.width);
        expect(css(f.height, f.zoom), `${size.height}@${want}`).toBe(size.height);
        expect(Math.abs(f.zoom - want)).toBeLessThan(0.02);
      }
  });
});

describe("scaleRect", () => {
  it("maps canvas CSS pixels to window pixels", () => {
    expect(scaleRect({ x: 10, y: 20, width: 100, height: 50 }, 1.25)).toEqual({ x: 13, y: 25, width: 125, height: 63 });
  });
});
