import { DEFAULT_CONFIG, type ResolverConfig } from "./config.js";
import {
  area,
  bboxOf,
  coverage,
  distPointToRect,
  distToGeometry,
  isClosedPath,
  pathLength,
  pathLengthInRect,
  polygonArea,
  rectToPolygon,
  type Point,
} from "./geometry.js";
import type { Annotation, Rect, Resolution, UIElement } from "./schemas.js";
import { compareTie, TreeIndex } from "./tree.js";

type Ctx = {
  index: TreeIndex;
  allTrees?: Map<string, UIElement>;
  cfg: ResolverConfig;
};

const indexCache = new WeakMap<UIElement, TreeIndex>();
export function indexFor(root: UIElement): TreeIndex {
  let idx = indexCache.get(root);
  if (!idx) {
    idx = new TreeIndex(root);
    indexCache.set(root, idx);
  }
  return idx;
}

const unresolved = (): Resolution => ({ status: "unresolved", elements: [], confirmedByUser: false });
const resolved = (elements: string[], extra: Partial<Resolution> = {}): Resolution => ({
  status: "resolved",
  elements,
  confirmedByUser: false,
  ...extra,
});
const region = (r: Rect, extra: Partial<Resolution> = {}): Resolution => ({
  status: "region",
  elements: [],
  region: roundRect(r),
  confirmedByUser: false,
  ...extra,
});
const roundRect = (r: Rect): Rect => ({
  x: Math.round(r.x),
  y: Math.round(r.y),
  w: Math.round(r.w),
  h: Math.round(r.h),
});

/**
 * Resolve one annotation against its screen's element tree.
 * A resolution the human confirmed is returned unchanged.
 */
export function resolve(
  annotation: Annotation,
  tree: UIElement,
  allTrees?: Map<string, UIElement>,
  config: Partial<ResolverConfig> = {},
): Resolution {
  if (annotation.resolution?.confirmedByUser) return annotation.resolution;
  const ctx: Ctx = { index: indexFor(tree), allTrees, cfg: { ...DEFAULT_CONFIG, ...config } };
  const g = annotation.geometry;

  switch (annotation.kind) {
    case "rule":
      return resolveRule(annotation);

    case "comment": {
      const p = anchorPoint(annotation);
      return deepestAt(ctx, p) ?? region({ x: p[0], y: p[1], w: 0, h: 0 });
    }

    case "remove": {
      if (g.type === "path") {
        // a scratch-out: the element under the stroke's centre
        const bb = bboxOf(g.points);
        return deepestAt(ctx, [bb.x + bb.w / 2, bb.y + bb.h / 2]) ?? unresolved();
      }
      if (g.type === "rect") return deepestAt(ctx, [g.x + g.w / 2, g.y + g.h / 2]) ?? unresolved();
      return deepestAt(ctx, anchorPoint(annotation)) ?? unresolved();
    }

    case "circle": {
      const poly = g.type === "path" ? (g.points as Point[]) : g.type === "rect" ? rectToPolygon(g) : null;
      if (!poly || poly.length < 3) return unresolved();
      return resolveArea(ctx, poly, "circle");
    }

    case "rectangle": {
      const poly = g.type === "rect" ? rectToPolygon(g) : g.type === "path" ? (g.points as Point[]) : null;
      if (!poly || poly.length < 3) return unresolved();
      return resolveArea(ctx, poly, "rectangle");
    }

    case "arrow": {
      if (g.type !== "arrow") return unresolved();
      return resolveArrow(ctx, g.from, g.to, g.toScreenId, annotation.screenId);
    }

    case "freehand": {
      if (g.type !== "path" || g.points.length === 0) return unresolved();
      const pts = g.points as Point[];
      if (isClosedPath(pts, ctx.cfg.closedLoop)) return resolveArea(ctx, pts, "circle");
      return resolveOpenPath(ctx, pts);
    }
  }
}

/* ─────────────────────────── per-kind rules ─────────────────────────── */

function anchorPoint(a: Annotation): Point {
  const g = a.geometry;
  switch (g.type) {
    case "point":
      return [g.x, g.y];
    case "rect":
      return [g.x + g.w / 2, g.y + g.h / 2];
    case "arrow":
      return g.from;
    case "path": {
      const bb = bboxOf(g.points);
      return [bb.x + bb.w / 2, bb.y + bb.h / 2];
    }
  }
}

/** Deepest meaningful element under a point; `null` when only the root / full-screen containers are there. */
function deepestAt(ctx: Ctx, p: Point, index = ctx.index): Resolution | null {
  const el = deepestElementAt(index, p, ctx.cfg);
  return el ? resolved([el.id]) : null;
}

function deepestElementAt(index: TreeIndex, p: Point, cfg: ResolverConfig): UIElement | null {
  const stack = index.stackAt(p[0], p[1]);
  const hit = stack.find((f) => !index.isHuge(f.el, cfg.hugeElement));
  return hit?.el ?? null;
}

function resolveRule(a: Annotation): Resolution {
  const targets = a.targets ?? [];
  return targets.length > 0 ? resolved(targets) : unresolved();
}

/**
 * Circle / rectangle: coverage-based selection.
 * Candidates cover ≥ `coverage`. The smallest candidate container whose area is
 * ≥ `containerFill` covered by candidate descendants wins; otherwise all
 * top-level candidates are returned.
 */
function resolveArea(ctx: Ctx, poly: Point[], kind: "circle" | "rectangle"): Resolution {
  const { index, cfg } = ctx;
  if (polygonArea(poly) < 4) return unresolved();

  const scored = index.all.map((f) => ({ f, cov: coverage(poly, f.el.bounds) }));
  let candidates = scored.filter((s) => s.cov >= cfg.coverage && !index.isHuge(s.f.el, cfg.hugeElement));
  if (candidates.length === 0) {
    // nothing but full-screen containers qualifies
    const huge = scored.filter((s) => s.cov >= cfg.coverage && s.f.el !== index.root);
    if (kind === "circle" && huge.length > 0) candidates = huge;
  }
  if (candidates.length === 0) return region(bboxOf(poly));

  const candidateSet = new Set(candidates.map((c) => c.f.el));

  // containers: candidates with candidate descendants covering ≥ containerFill of them
  const containers = candidates
    .filter((c) => c.f.el.children.length > 0)
    .filter((c) => {
      const top = topLevelDescendants(c.f.el, candidateSet);
      if (top.length === 0) return false;
      const covered = top.reduce((s, el) => s + area(el.bounds), 0);
      return covered / Math.max(1, area(c.f.el.bounds)) >= cfg.containerFill;
    })
    .map((c) => c.f.el)
    .sort(compareTie);

  if (containers.length > 0) {
    const smallest = containers[0]!;
    // only when it holds every other candidate that is not nested inside it
    const outside = candidates.filter(
      (c) => c.f.el !== smallest && !index.isAncestor(smallest, c.f.el) && !index.isAncestor(c.f.el, smallest),
    );
    if (outside.length === 0) return resolved([smallest.id]);
  }

  const topLevel = candidates
    .map((c) => c.f)
    .filter((f) => {
      let p = f.parent;
      while (p) {
        if (candidateSet.has(p.el)) return false;
        p = p.parent;
      }
      return true;
    })
    .map((f) => f.el)
    .sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x || compareTie(a, b));
  return resolved(topLevel.map((e) => e.id));
}

/** Candidate descendants of `el` that have no candidate between them and `el`. */
function topLevelDescendants(el: UIElement, set: Set<UIElement>): UIElement[] {
  const out: UIElement[] = [];
  const walk = (e: UIElement) => {
    for (const c of e.children) {
      if (set.has(c)) out.push(c);
      else walk(c);
    }
  };
  walk(el);
  return out;
}

function resolveArrow(
  ctx: Ctx,
  from: Point,
  to: Point,
  toScreenId: string | undefined,
  screenId: string,
): Resolution {
  const start = deepestElementAt(ctx.index, from, ctx.cfg);
  if (!start) return unresolved();

  let toIndex = ctx.index;
  if (toScreenId && toScreenId !== screenId) {
    const t = ctx.allTrees?.get(toScreenId);
    if (!t) return resolved([start.id]);
    toIndex = indexFor(t);
  }
  const end = deepestElementAt(toIndex, to, ctx.cfg);
  if (end && end !== start) return resolved([start.id], { toElements: [end.id] });
  if (toScreenId && toScreenId !== screenId) {
    // lands on another tile's empty area: the screen itself is the destination
    return resolved([start.id], { toElements: [toIndex.root.id] });
  }
  return resolved([start.id], { region: roundRect({ x: to[0], y: to[1], w: 0, h: 0 }) });
}

/**
 * Open freehand: the smallest element that holds most of the path; otherwise
 * the element with the longest stretch of path inside it.
 */
function resolveOpenPath(ctx: Ctx, pts: Point[]): Resolution {
  const { index, cfg } = ctx;
  const total = pathLength(pts);
  if (total <= 0) return deepestAt(ctx, pts[0]!) ?? region(bboxOf(pts));

  const scored = index.all
    .filter((f) => !index.isHuge(f.el, cfg.hugeElement))
    .map((f) => ({ el: f.el, len: pathLengthInRect(pts, f.el.bounds) }))
    .filter((s) => s.len > 0);
  if (scored.length === 0) return region(bboxOf(pts));

  const holders = scored.filter((s) => s.len >= cfg.freehandContainment * total).map((s) => s.el);
  if (holders.length > 0) return resolved([holders.sort(compareTie)[0]!.id]);

  scored.sort((a, b) => b.len - a.len || compareTie(a.el, b.el));
  return resolved([scored[0]!.el.id]);
}

/* ─────────────────────────── whole round ─────────────────────────── */

const ATTACHABLE = new Set(["circle", "arrow", "rectangle", "remove", "freehand"]);

/**
 * Link free comments to nearby annotations (typed pins within `attachDistance`,
 * handwriting within `inkAttachDistance`). Explicit `attachedTo` is kept.
 */
export function attachComments(
  annotations: Annotation[],
  config: Partial<ResolverConfig> = {},
): Annotation[] {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const taken = new Set(annotations.filter((a) => a.attachedTo).map((a) => a.attachedTo!));
  return annotations.map((a) => {
    if (a.kind !== "comment" || a.attachedTo) return a;
    const isInk = !!a.ink?.handwriting;
    const limit = isInk ? cfg.inkAttachDistance : cfg.attachDistance;
    const kinds = isInk ? new Set(["circle", "arrow", "remove"]) : ATTACHABLE;
    let best: { id: string; d: number } | null = null;
    for (const o of annotations) {
      if (o === a || o.screenId !== a.screenId || !kinds.has(o.kind) || taken.has(o.id)) continue;
      const d = isInk && a.ink ? inkDistance(a, o) : distToGeometry(anchorPoint(a), o.geometry);
      if (d <= limit && (!best || d < best.d)) best = { id: o.id, d };
    }
    if (!best) return a;
    taken.add(best.id);
    return { ...a, attachedTo: best.id };
  });
}

function inkDistance(ink: Annotation, other: Annotation): number {
  const pts = ink.ink!.strokes.flatMap((s) => s.points.map((p) => [p[0], p[1]] as Point));
  const bb = bboxOf(pts);
  let d = Infinity;
  const og = other.geometry;
  // sample the other geometry and measure against the ink bbox
  const samples: Point[] =
    og.type === "path"
      ? (og.points as Point[])
      : og.type === "arrow"
        ? [og.from, og.to, [(og.from[0] + og.to[0]) / 2, (og.from[1] + og.to[1]) / 2]]
        : og.type === "rect"
          ? rectToPolygon(og)
          : [[og.x, og.y]];
  for (const s of samples) d = Math.min(d, distPointToRect(s, bb));
  return d;
}

/**
 * Resolve every annotation of a round. Attached comments inherit the
 * resolution of the annotation they belong to. Confirmed resolutions are kept.
 */
export function resolveAll(
  annotations: Annotation[],
  trees: Map<string, UIElement>,
  config: Partial<ResolverConfig> = {},
): Annotation[] {
  const linked = attachComments(annotations, config);
  const byId = new Map(linked.map((a) => [a.id, a]));
  const first = linked.map((a) => {
    const tree = trees.get(a.screenId);
    if (!tree) return { ...a, resolution: a.resolution?.confirmedByUser ? a.resolution : unresolved() };
    return { ...a, resolution: resolve(a, tree, trees, config) };
  });
  const resolvedById = new Map(first.map((a) => [a.id, a]));
  return first.map((a) => {
    if (a.kind !== "comment" || !a.attachedTo || a.resolution?.confirmedByUser) return a;
    const parent = resolvedById.get(a.attachedTo) ?? byId.get(a.attachedTo);
    if (!parent?.resolution) return a;
    return { ...a, resolution: { ...parent.resolution, confirmedByUser: false } };
  });
}
