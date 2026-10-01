import { describe, expect, it } from "vitest";
import { classifyStrokes, type InkStroke } from "../src/index.js";
import { ellipse } from "./helpers.js";

const stroke = (pts: [number, number][], t0: number, dur = 200): InkStroke => ({
  points: pts.map(([x, y]) => [x, y, 0.5]),
  t0,
  t1: t0 + dur,
});
const line = (a: [number, number], b: [number, number], n = 12): [number, number][] =>
  Array.from({ length: n + 1 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);

describe("pen gestures", () => {
  it("closed loop → circle", () => {
    expect(classifyStrokes([stroke(ellipse(100, 100, 80, 40), 0)]).kind).toBe("circle");
  });
  it("shaft + two head strokes → arrow", () => {
    const r = classifyStrokes([
      stroke(line([0, 100], [200, 100]), 0),
      stroke(line([185, 88], [200, 100], 4), 250, 80),
      stroke(line([185, 112], [200, 100], 4), 380, 80),
    ]);
    expect(r).toMatchObject({ kind: "arrow", from: [0, 100], to: [200, 100] });
  });
  it("shaft with a hook → arrow", () => {
    const pts = [...line([0, 100], [200, 100], 20), ...line([200, 100], [185, 90], 4).slice(1)];
    expect(classifyStrokes([stroke(pts, 0)]).kind).toBe("arrow");
  });
  it("two crossing strokes → remove", () => {
    expect(classifyStrokes([stroke(line([0, 0], [100, 100]), 0), stroke(line([100, 0], [0, 100]), 300)]).kind).toBe("remove");
  });
  it("zig-zag scratch → remove", () => {
    const zig: [number, number][] = [];
    for (let i = 0; i <= 10; i++) zig.push([i % 2 ? 100 : 0, i * 4]);
    expect(classifyStrokes([stroke(zig, 0)]).kind).toBe("remove");
  });
  it("several short strokes close in time → handwriting", () => {
    const s = [0, 1, 2, 3].map((i) => stroke(line([i * 20, 0], [i * 20 + 10, 30], 5), i * 300, 150));
    expect(classifyStrokes(s).kind).toBe("handwriting");
  });
  it("anything else → freehand", () => {
    const wave: [number, number][] = Array.from({ length: 30 }, (_, i) => [i * 10, Math.sin(i / 3) * 30]);
    expect(classifyStrokes([stroke(wave, 0)]).kind).toBe("freehand");
  });
});
