import { DEFAULT_CONFIG, type ResolverConfig } from "./config.js";
import { bboxOf, dist, isClosedPath, pathLength, type Point } from "./geometry.js";

/**
 * Deterministic pen-gesture classification. No handwriting recognition: a
 * stroke group is only classified, and the user can change the result.
 */

export type InkStroke = { points: [number, number, number][]; t0: number; t1: number };
export type GestureKind = "circle" | "arrow" | "remove" | "handwriting" | "freehand";

const xy = (s: InkStroke): Point[] => s.points.map((p) => [p[0], p[1]]);
const diag = (pts: Point[]) => {
  const b = bboxOf(pts);
  return Math.hypot(b.w, b.h);
};

/** chord / length: 1 for a straight line. */
export function straightness(pts: Point[]): number {
  const l = pathLength(pts);
  if (l === 0) return 0;
  return dist(pts[0]!, pts[pts.length - 1]!) / l;
}

/** Direction reversals along the dominant axis (zig-zag count). */
export function reversals(pts: Point[]): number {
  if (pts.length < 3) return 0;
  const b = bboxOf(pts);
  const axis = b.w >= b.h ? 0 : 1;
  const minStep = Math.max(2, Math.max(b.w, b.h) * 0.08);
  let dir = 0;
  let count = 0;
  let anchor = pts[0]![axis];
  for (const p of pts) {
    const d = p[axis] - anchor;
    if (Math.abs(d) < minStep) continue;
    const s = Math.sign(d);
    if (dir !== 0 && s !== dir) count++;
    dir = s;
    anchor = p[axis];
  }
  return count;
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const o = (p: Point, q: Point, r: Point) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}

export function strokesCross(s1: Point[], s2: Point[]): number {
  let n = 0;
  for (let i = 1; i < s1.length; i++)
    for (let j = 1; j < s2.length; j++) if (segmentsIntersect(s1[i - 1]!, s1[i]!, s2[j - 1]!, s2[j]!)) n++;
  return n;
}

/** Does the end of a stroke bend back sharply (a hooked arrow head)? */
function hasHook(pts: Point[]): boolean {
  if (pts.length < 6) return false;
  const total = pathLength(pts);
  // the tip is the point furthest from the start; the hook is everything after it
  const tipIdx = pts.indexOf(tipOf(pts));
  const shaft = pts.slice(0, tipIdx + 1);
  const tail = pts.slice(tipIdx);
  const tailLen = pathLength(tail);
  if (tail.length < 2 || tailLen < total * 0.03 || tailLen > total * 0.35) return false;
  if (straightness(shaft) < DEFAULT_CONFIG.arrowStraightness) return false;
  const v1: Point = [shaft[shaft.length - 1]![0] - shaft[0]![0], shaft[shaft.length - 1]![1] - shaft[0]![1]];
  const v2: Point = [tail[tail.length - 1]![0] - tail[0]![0], tail[tail.length - 1]![1] - tail[0]![1]];
  const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2) || 1);
  return cos < -0.3; // turns back by more than ~107°
}

export type Classified = {
  kind: GestureKind;
  /** For arrows: shaft start and tip. */
  from?: Point;
  to?: Point;
};

/**
 * Classify a group of strokes that ended together.
 * `strokes` are in drawing order with timestamps (ms).
 */
export function classifyStrokes(strokes: InkStroke[], config: Partial<ResolverConfig> = {}): Classified {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  if (strokes.length === 0) return { kind: "freehand" };
  const all = strokes.flatMap(xy);
  const first = xy(strokes[0]!);

  // handwriting: several short strokes, close in time and space
  if (strokes.length >= 3) {
    const short = strokes.every((s) => diag(xy(s)) <= cfg.handwritingStrokeMax);
    const quick = strokes.every((s, i) => i === 0 || s.t0 - strokes[i - 1]!.t1 <= cfg.handwritingWindowMs);
    if (short && quick) return { kind: "handwriting" };
  }

  // remove: two crossing strokes (an X)
  if (strokes.length === 2) {
    const a = first;
    const b = xy(strokes[1]!);
    const bothStraight = straightness(a) > 0.85 && straightness(b) > 0.85;
    const quick = strokes[1]!.t0 - strokes[0]!.t1 <= cfg.handwritingWindowMs;
    if (bothStraight && quick && strokesCross(a, b) >= 1) {
      // an arrow drawn as shaft + short head also crosses; heads are much shorter
      const la = pathLength(a);
      const lb = pathLength(b);
      if (Math.min(la, lb) / Math.max(la, lb) > 0.5) return { kind: "remove" };
    }
  }

  if (strokes.length === 1) {
    if (reversals(first) >= cfg.zigzagReversals && straightness(first) < 0.35) return { kind: "remove" };
    if (isClosedPath(first, cfg.closedLoop)) return { kind: "circle" };
    if (hasHook(first)) {
      return { kind: "arrow", from: first[0], to: tipOf(first) };
    }
  }

  // arrow: straight shaft, then one or two short head strokes within the window
  if (strokes.length <= 3) {
    const shaft = first;
    const heads = strokes.slice(1);
    const shaftLen = pathLength(shaft);
    const straight = straightness(shaft) >= cfg.arrowStraightness;
    const headsOk =
      heads.length > 0 &&
      heads.every((h, i) => {
        const prevEnd = (i === 0 ? strokes[0] : heads[i - 1])!.t1;
        const pts = xy(h);
        const nearTip = Math.min(...pts.map((p) => dist(p, shaft[shaft.length - 1]!)));
        return h.t0 - prevEnd <= cfg.arrowHeadWindowMs && pathLength(pts) < shaftLen * 0.5 && nearTip < shaftLen * 0.25;
      });
    if (straight && headsOk) return { kind: "arrow", from: shaft[0], to: shaft[shaft.length - 1] };
  }

  if (strokes.length === 1 && isClosedPath(all, cfg.closedLoop)) return { kind: "circle" };
  return { kind: "freehand" };
}

function tipOf(pts: Point[]): Point {
  // the point furthest from the start is the arrow tip
  let best = pts[0]!;
  let d = 0;
  for (const p of pts) {
    const dd = dist(p, pts[0]!);
    if (dd > d) {
      d = dd;
      best = p;
    }
  }
  return best;
}
