import { describe, expect, it } from "vitest";
import {
  clipPolygonToRect,
  coverage,
  distToGeometry,
  formatRect,
  isClosedPath,
  pathLengthInRect,
  polygonArea,
  rectToPolygon,
  segmentLengthInRect,
} from "../src/index.js";
import { ellipse } from "./helpers.js";

describe("geometry", () => {
  it("computes polygon area", () => {
    expect(polygonArea(rectToPolygon({ x: 0, y: 0, w: 10, h: 20 }))).toBe(200);
  });

  it("clips a concave polygon against a rect exactly", () => {
    // an L shape
    const L: [number, number][] = [[0, 0], [20, 0], [20, 10], [10, 10], [10, 20], [0, 20]];
    const clipped = clipPolygonToRect(L, { x: 5, y: 5, w: 10, h: 10 });
    // inside the window, the L covers 3 of 4 quadrants of 5×5
    expect(polygonArea(clipped)).toBeCloseTo(75, 5);
  });

  it("measures coverage of a rect by an ellipse", () => {
    const big = ellipse(50, 50, 100, 100, 64);
    expect(coverage(big, { x: 25, y: 25, w: 50, h: 50 })).toBeCloseTo(1, 5);
    const small = ellipse(50, 50, 10, 10, 64);
    expect(coverage(small, { x: 0, y: 0, w: 100, h: 100 })).toBeLessThan(0.05);
  });

  it("measures segment length inside a rect", () => {
    expect(segmentLengthInRect([-10, 5], [20, 5], { x: 0, y: 0, w: 10, h: 10 })).toBeCloseTo(10);
    expect(segmentLengthInRect([-10, 50], [20, 50], { x: 0, y: 0, w: 10, h: 10 })).toBe(0);
    expect(pathLengthInRect([[0, 5], [5, 5], [5, 20]], { x: 0, y: 0, w: 10, h: 10 })).toBeCloseTo(10);
  });

  it("detects closed loops relative to the bbox diagonal", () => {
    expect(isClosedPath(ellipse(0, 0, 50, 30), 0.15)).toBe(true);
    expect(isClosedPath([[0, 0], [50, 0], [100, 0], [150, 0]], 0.15)).toBe(false);
  });

  it("measures distance to geometry", () => {
    expect(distToGeometry([0, 10], { type: "arrow", from: [0, 0], to: [100, 0] })).toBe(10);
    expect(distToGeometry([5, 5], { type: "rect", x: 0, y: 0, w: 10, h: 10 })).toBe(0);
  });

  it("formats regions", () => {
    expect(formatRect({ x: 32.4, y: 612, w: 326, h: 48 })).toBe("(x 32, y 612, 326 × 48)");
    expect(formatRect({ x: 10, y: 20, w: 0, h: 0 })).toBe("(x 10, y 20)");
  });
});
