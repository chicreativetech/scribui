import type { Point } from "./geometry.js";

/**
 * The paint bucket: flood fill on a raster of what's drawn, traced back into outlines.
 * Pure, so it's testable without a browser; the canvas rasterizes the shapes.
 */

/** 1 where something is drawn. */
export type Raster = { w: number; h: number; data: Uint8Array };

/** Grow what's drawn by `r` pixels (a square brush), to close small gaps in hand-drawn lines. */
export function dilate(src: Raster, r: number): Raster {
  if (r <= 0) return src;
  const { w, h } = src;
  const rows = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    // distance since the last drawn pixel, left to right and right to left
    let last = -Infinity;
    for (let x = 0; x < w; x++) {
      if (src.data[y * w + x]) last = x;
      if (x - last <= r) rows[y * w + x] = 1;
    }
    last = Infinity;
    for (let x = w - 1; x >= 0; x--) {
      if (src.data[y * w + x]) last = x;
      if (last - x <= r) rows[y * w + x] = 1;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let last = -Infinity;
    for (let y = 0; y < h; y++) {
      if (rows[y * w + x]) last = y;
      if (y - last <= r) out[y * w + x] = 1;
    }
    last = Infinity;
    for (let y = h - 1; y >= 0; y--) {
      if (rows[y * w + x]) last = y;
      if (last - y <= r) out[y * w + x] = 1;
    }
  }
  return { w, h, data: out };
}

export type Flood = { mask: Raster; count: number; touchesEdge: boolean };

/** The empty pixels connected to (x, y), 4-connected. Null when (x, y) is drawn on or outside. */
export function floodFill(wall: Raster, x: number, y: number): Flood | null {
  const { w, h, data } = wall;
  x = Math.floor(x);
  y = Math.floor(y);
  if (x < 0 || y < 0 || x >= w || y >= h || data[y * w + x]) return null;
  const mask = new Uint8Array(w * h);
  const stack: number[] = [x, y];
  let count = 0;
  let touchesEdge = false;
  const open = (i: number) => !data[i] && !mask[i];
  while (stack.length) {
    const sy = stack.pop()!;
    let sx = stack.pop()!;
    let i = sy * w + sx;
    if (!open(i)) continue;
    // run left, then fill right, queueing the rows above and below
    while (sx > 0 && open(i - 1)) {
      sx--;
      i--;
    }
    let up = false;
    let down = false;
    for (; sx < w && open(i); sx++, i++) {
      mask[i] = 1;
      count++;
      if (sx === 0 || sx === w - 1 || sy === 0 || sy === h - 1) touchesEdge = true;
      if (sy > 0) {
        const o = open(i - w);
        if (o && !up) stack.push(sx, sy - 1);
        up = o;
      }
      if (sy < h - 1) {
        const o = open(i + w);
        if (o && !down) stack.push(sx, sy + 1);
        down = o;
      }
    }
  }
  return { mask: { w, h, data: mask }, count, touchesEdge };
}

/**
 * Grow a mask into `allowed` pixels, up to `steps` pixels away (4-connected): a fill made with
 * gaps closed reaches back into the corners that closing them cut off, without crossing a line.
 */
export function growInto(mask: Raster, allowed: Raster, steps: number): Raster {
  const { w, h } = mask;
  const out = mask.data.slice();
  let frontier: number[] = [];
  for (let i = 0; i < w * h; i++) if (out[i]) frontier.push(i);
  for (let s = 0; s < steps && frontier.length; s++) {
    const next: number[] = [];
    for (const i of frontier) {
      const x = i % w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (j < 0 || j >= w * h || out[j] || !allowed.data[j]) continue;
        out[j] = 1;
        next.push(j);
      }
    }
    frontier = next;
  }
  return { w, h, data: out };
}

/**
 * The outlines of a mask: one loop per edge between filled and empty, holes included, in
 * pixel-corner coordinates, simplified to within `tolerance` pixels. Fill them even-odd.
 */
export function traceLoops(mask: Raster, tolerance = 0.75): Point[][] {
  const { w, h, data } = mask;
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && data[y * w + x] === 1;
  // directed edges around each filled pixel, clockwise; edges between two filled pixels cancel
  const W = w + 1;
  const next = new Map<number, number[]>();
  const add = (x0: number, y0: number, x1: number, y1: number) => {
    const k = y0 * W + x0;
    const list = next.get(k);
    if (list) list.push(y1 * W + x1);
    else next.set(k, [y1 * W + x1]);
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!at(x, y)) continue;
      if (!at(x, y - 1)) add(x, y, x + 1, y);
      if (!at(x + 1, y)) add(x + 1, y, x + 1, y + 1);
      if (!at(x, y + 1)) add(x + 1, y + 1, x, y + 1);
      if (!at(x - 1, y)) add(x, y + 1, x, y);
    }
  const loops: Point[][] = [];
  for (const [start, outs] of next) {
    while (outs.length) {
      const loop: Point[] = [];
      let from = start;
      let to = outs.pop()!;
      for (let guard = 0; guard < 4 * W * (h + 1); guard++) {
        loop.push([from % W, Math.floor(from / W)]);
        if (to === start) break;
        const choices = next.get(to);
        if (!choices?.length) break;
        // where two loops touch at a corner, turn right so each stays its own
        let pick = choices.length - 1;
        if (choices.length > 1) {
          const dx = (to % W) - (from % W);
          const dy = Math.floor(to / W) - Math.floor(from / W);
          const right = choices.findIndex((c) => (c % W) - (to % W) === -dy && Math.floor(c / W) - Math.floor(to / W) === dx);
          if (right >= 0) pick = right;
        }
        from = to;
        to = choices.splice(pick, 1)[0]!;
      }
      if (loop.length > 2) loops.push(simplifyLoop(loop, tolerance));
    }
  }
  return loops.filter((l) => l.length > 2);
}

/** A closed loop with fewer points, none further than `tol` from the original. */
export function simplifyLoop(loop: Point[], tol: number): Point[] {
  if (loop.length < 4) return loop;
  // split at the point furthest from the first, then simplify both halves as open lines
  let far = 0;
  let best = -1;
  for (let i = 1; i < loop.length; i++) {
    const d = Math.hypot(loop[i]![0] - loop[0]![0], loop[i]![1] - loop[0]![1]);
    if (d > best) {
      best = d;
      far = i;
    }
  }
  const a = rdp(loop.slice(0, far + 1), tol);
  const b = rdp([...loop.slice(far), loop[0]!], tol);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

function rdp(pts: Point[], tol: number): Point[] {
  if (pts.length < 3) return pts;
  const [x0, y0] = pts[0]!;
  const [x1, y1] = pts[pts.length - 1]!;
  const len = Math.hypot(x1 - x0, y1 - y0) || 1;
  let far = 0;
  let best = -1;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x, y] = pts[i]!;
    const d = Math.abs((x1 - x0) * (y0 - y) - (x0 - x) * (y1 - y0)) / len;
    if (d > best) {
      best = d;
      far = i;
    }
  }
  if (best <= tol) return [pts[0]!, pts[pts.length - 1]!];
  return [...rdp(pts.slice(0, far + 1), tol).slice(0, -1), ...rdp(pts.slice(far), tol)];
}
