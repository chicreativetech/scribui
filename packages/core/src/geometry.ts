import type { Geometry, Rect } from "./schemas.js";

export type Point = [number, number];

export const area = (r: Rect): number => Math.max(0, r.w) * Math.max(0, r.h);

export const containsPoint = (r: Rect, x: number, y: number): boolean =>
  x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

export const containsRect = (outer: Rect, inner: Rect): boolean =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.w <= outer.x + outer.w &&
  inner.y + inner.h <= outer.y + outer.h;

export const rectEquals = (a: Rect, b: Rect, eps = 0.5): boolean =>
  Math.abs(a.x - b.x) <= eps &&
  Math.abs(a.y - b.y) <= eps &&
  Math.abs(a.w - b.w) <= eps &&
  Math.abs(a.h - b.h) <= eps;

export function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w);
  const bt = Math.min(a.y + a.h, b.y + b.h);
  if (r <= x || bt <= y) return null;
  return { x, y, w: r - x, h: bt - y };
}

export function bboxOf(points: readonly (readonly number[])[]): Rect {
  if (points.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    const x = p[0]!;
    const y = p[1]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function unionRect(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const pts: Point[] = [];
  for (const r of rects) pts.push([r.x, r.y], [r.x + r.w, r.y + r.h]);
  return bboxOf(pts);
}

/** Shoelace area of a simple polygon (absolute value). */
export function polygonArea(poly: readonly Point[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i]!;
    const [x2, y2] = poly[(i + 1) % poly.length]!;
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

/**
 * Sutherland–Hodgman: clip a (possibly concave) subject polygon against an
 * axis-aligned rectangle. The shoelace area of the result is exact.
 */
export function clipPolygonToRect(poly: readonly Point[], r: Rect): Point[] {
  type Edge = { inside: (p: Point) => boolean; cut: (a: Point, b: Point) => Point };
  const x0 = r.x;
  const x1 = r.x + r.w;
  const y0 = r.y;
  const y1 = r.y + r.h;
  const atX = (a: Point, b: Point, x: number): Point => {
    const t = (x - a[0]) / (b[0] - a[0]);
    return [x, a[1] + t * (b[1] - a[1])];
  };
  const atY = (a: Point, b: Point, y: number): Point => {
    const t = (y - a[1]) / (b[1] - a[1]);
    return [a[0] + t * (b[0] - a[0]), y];
  };
  const edges: Edge[] = [
    { inside: (p) => p[0] >= x0, cut: (a, b) => atX(a, b, x0) },
    { inside: (p) => p[0] <= x1, cut: (a, b) => atX(a, b, x1) },
    { inside: (p) => p[1] >= y0, cut: (a, b) => atY(a, b, y0) },
    { inside: (p) => p[1] <= y1, cut: (a, b) => atY(a, b, y1) },
  ];
  let out: Point[] = poly.slice() as Point[];
  for (const e of edges) {
    if (out.length === 0) break;
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i]!;
      const prev = input[(i + input.length - 1) % input.length]!;
      const ci = e.inside(cur);
      const pi = e.inside(prev);
      if (ci) {
        if (!pi) out.push(e.cut(prev, cur));
        out.push(cur);
      } else if (pi) {
        out.push(e.cut(prev, cur));
      }
    }
  }
  return out;
}

/** Share of `r`'s area that lies inside `poly` (0..1). */
export function coverage(poly: readonly Point[], r: Rect): number {
  const a = area(r);
  if (a <= 0) return 0;
  return Math.min(1, polygonArea(clipPolygonToRect(poly, r)) / a);
}

export const rectToPolygon = (r: Rect): Point[] => [
  [r.x, r.y],
  [r.x + r.w, r.y],
  [r.x + r.w, r.y + r.h],
  [r.x, r.y + r.h],
];

export const dist = (a: readonly number[], b: readonly number[]): number =>
  Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!);

export function pathLength(points: readonly (readonly number[])[]): number {
  let l = 0;
  for (let i = 1; i < points.length; i++) l += dist(points[i - 1]!, points[i]!);
  return l;
}

/** Liang–Barsky: length of segment a→b inside rect r. */
export function segmentLengthInRect(a: Point, b: Point, r: Rect): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let t0 = 0;
  let t1 = 1;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  if (
    clip(-dx, a[0] - r.x) &&
    clip(dx, r.x + r.w - a[0]) &&
    clip(-dy, a[1] - r.y) &&
    clip(dy, r.y + r.h - a[1])
  ) {
    return Math.max(0, t1 - t0) * Math.hypot(dx, dy);
  }
  return 0;
}

export function pathLengthInRect(points: readonly Point[], r: Rect): number {
  let l = 0;
  for (let i = 1; i < points.length; i++) l += segmentLengthInRect(points[i - 1]!, points[i]!, r);
  return l;
}

/** True when the path's end returns close to its start (relative to bbox diagonal). */
export function isClosedPath(points: readonly Point[], threshold: number): boolean {
  if (points.length < 4) return false;
  const bb = bboxOf(points);
  const diag = Math.hypot(bb.w, bb.h);
  if (diag < 8) return false;
  return dist(points[0]!, points[points.length - 1]!) <= threshold * diag;
}

function distPointToSegment(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(p, a);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return dist(p, [a[0] + t * dx, a[1] + t * dy]);
}

export function distPointToRect(p: Point, r: Rect): number {
  const dx = Math.max(r.x - p[0], 0, p[0] - (r.x + r.w));
  const dy = Math.max(r.y - p[1], 0, p[1] - (r.y + r.h));
  return Math.hypot(dx, dy);
}

/** Shortest distance from a point to the drawn geometry of an annotation. */
export function distToGeometry(p: Point, g: Geometry): number {
  switch (g.type) {
    case "point":
      return dist(p, [g.x, g.y]);
    case "rect": {
      // distance to the outline, or 0 inside
      return distPointToRect(p, g);
    }
    case "arrow":
      return distPointToSegment(p, g.from, g.to);
    case "path": {
      if (g.points.length === 1) return dist(p, g.points[0]!);
      let d = Infinity;
      for (let i = 1; i < g.points.length; i++)
        d = Math.min(d, distPointToSegment(p, g.points[i - 1]!, g.points[i]!));
      return d;
    }
  }
}

export function geometryBBox(g: Geometry): Rect {
  switch (g.type) {
    case "point":
      return { x: g.x, y: g.y, w: 0, h: 0 };
    case "rect":
      return { x: g.x, y: g.y, w: g.w, h: g.h };
    case "arrow":
      return bboxOf([g.from, g.to]);
    case "path":
      return bboxOf(g.points);
  }
}

export function distRectToRect(a: Rect, b: Rect): number {
  const dx = Math.max(b.x - (a.x + a.w), 0, a.x - (b.x + b.w));
  const dy = Math.max(b.y - (a.y + a.h), 0, a.y - (b.y + b.h));
  return Math.hypot(dx, dy);
}

export const round1 = (n: number): number => Math.round(n);

export function formatRect(r: Rect): string {
  if (r.w <= 1 && r.h <= 1) return `(x ${round1(r.x)}, y ${round1(r.y)})`;
  return `(x ${round1(r.x)}, y ${round1(r.y)}, ${round1(r.w)} × ${round1(r.h)})`;
}
