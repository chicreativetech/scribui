import { area, containsPoint, rectEquals } from "./geometry.js";
import type { IdSource, Rect, UIElement } from "./schemas.js";

/* ─────────────────────────── normalization ─────────────────────────── */

/** Raw element as produced by a platform parser, before normalization. */
export type RawElement = {
  id?: string;
  idSource?: Exclude<IdSource, "generated">;
  type: string;
  nativeType?: string;
  label?: string;
  bounds: Rect;
  visible?: boolean;
  children: RawElement[];
  source?: UIElement["source"];
};

const ID_RANK: Record<IdSource, number> = { accessibility: 0, testId: 1, dom: 2, generated: 3 };

export const isRealId = (e: Pick<UIElement, "idSource">): boolean => e.idSource !== "generated";

/**
 * Normalize a raw tree:
 * - drop invisible and zero-size elements (the root is always kept),
 * - collapse wrappers with exactly one child and identical bounds,
 * - assign stable generated ids where no real id exists,
 * - de-duplicate repeated real ids.
 */
export function normalizeTree(raw: RawElement): UIElement {
  const pruned = prune(raw, true) ?? { ...raw, children: [] };
  const collapsed = collapse(pruned);
  const withIds = assignIds(collapsed, "", 0, new Map());
  return withIds;
}

function prune(e: RawElement, isRoot: boolean): RawElement | null {
  if (!isRoot) {
    if (e.visible === false) return null;
    if (e.bounds.w <= 0 || e.bounds.h <= 0) return null;
  }
  const children: RawElement[] = [];
  for (const c of e.children) {
    const p = prune(c, false);
    if (p) children.push(p);
  }
  return { ...e, children };
}

function collapse(e: RawElement): RawElement {
  let node: RawElement = { ...e, children: e.children.map(collapse) };
  while (node.children.length === 1 && rectEquals(node.bounds, node.children[0]!.bounds)) {
    const child = node.children[0]!;
    node = mergeWrapper(node, child);
  }
  return node;
}

/** Merge a single-child wrapper into its child, keeping the most useful facts of both. */
function mergeWrapper(parent: RawElement, child: RawElement): RawElement {
  const parentRank = parent.id ? ID_RANK[parent.idSource ?? "dom"] : 9;
  const childRank = child.id ? ID_RANK[child.idSource ?? "dom"] : 9;
  const useParentId = parentRank < childRank;
  const genericChild = child.type === "container" || child.type === "other";
  return {
    ...child,
    id: useParentId ? parent.id : child.id,
    idSource: useParentId ? parent.idSource : child.idSource,
    type: genericChild && parent.type !== "container" ? parent.type : child.type,
    nativeType: child.nativeType ?? parent.nativeType,
    label: child.label ?? parent.label,
    source: child.source ?? parent.source,
    children: child.children,
  };
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
}

/**
 * Generated ids are derived from the path of types and same-type sibling
 * indexes, plus the label when present, so an unchanged screen yields the same
 * ids on every capture.
 */
function assignIds(
  e: RawElement,
  parentPath: string,
  typeIndex: number,
  seen: Map<string, number>,
): UIElement {
  const segment = `${e.type}.${typeIndex}`;
  const path = parentPath ? `${parentPath}/${segment}` : segment;
  let id: string;
  let idSource: IdSource;
  if (e.id && e.id.trim()) {
    id = e.id.trim();
    idSource = e.idSource ?? "dom";
  } else {
    id = e.label ? `${path}~${slug(e.label)}` : path;
    idSource = "generated";
  }
  const n = (seen.get(id) ?? 0) + 1;
  seen.set(id, n);
  if (n > 1) id = `${id}#${n}`;

  const typeCounts = new Map<string, number>();
  const children = e.children.map((c) => {
    const i = typeCounts.get(c.type) ?? 0;
    typeCounts.set(c.type, i + 1);
    return assignIds(c, path, i, seen);
  });

  const out: UIElement = {
    id,
    idSource,
    type: e.type,
    bounds: roundRect(e.bounds),
    visible: true,
    children,
  };
  if (e.nativeType) out.nativeType = e.nativeType;
  if (e.label) out.label = e.label;
  if (e.source) out.source = e.source;
  return out;
}

const roundRect = (r: Rect): Rect => ({
  x: Math.round(r.x),
  y: Math.round(r.y),
  w: Math.round(r.w),
  h: Math.round(r.h),
});

/* ─────────────────────────── queries ─────────────────────────── */

export type FlatElement = {
  el: UIElement;
  parent: FlatElement | null;
  depth: number;
};

export class TreeIndex {
  readonly root: UIElement;
  readonly all: FlatElement[] = [];
  readonly byId = new Map<string, FlatElement>();
  readonly screenArea: number;

  constructor(root: UIElement) {
    this.root = root;
    this.screenArea = Math.max(1, area(root.bounds));
    const walk = (el: UIElement, parent: FlatElement | null, depth: number) => {
      const f: FlatElement = { el, parent, depth };
      this.all.push(f);
      if (!this.byId.has(el.id)) this.byId.set(el.id, f);
      for (const c of el.children) walk(c, f, depth + 1);
    };
    walk(root, null, 0);
  }

  get(id: string): UIElement | undefined {
    return this.byId.get(id)?.el;
  }

  isHuge(el: UIElement, share: number): boolean {
    return el === this.root || area(el.bounds) >= share * this.screenArea;
  }

  /** All elements containing the point, deepest first; ties prefer real ids, then smaller area. */
  stackAt(x: number, y: number): FlatElement[] {
    return this.all.filter((f) => containsPoint(f.el.bounds, x, y)).sort(compareDeepest);
  }

  ancestors(id: string): UIElement[] {
    const out: UIElement[] = [];
    let f = this.byId.get(id)?.parent ?? null;
    while (f) {
      out.push(f.el);
      f = f.parent;
    }
    return out;
  }

  isAncestor(maybeAncestor: UIElement, of: UIElement): boolean {
    let f = this.byId.get(of.id)?.parent ?? null;
    while (f) {
      if (f.el === maybeAncestor) return true;
      f = f.parent;
    }
    return false;
  }
}

/** Sort key: deeper first, then real ids, then smaller area, then id. */
export function compareDeepest(a: FlatElement, b: FlatElement): number {
  if (a.depth !== b.depth) return b.depth - a.depth;
  return compareTie(a.el, b.el);
}

/** Tie-breaking from the spec: prefer real ids, then smaller area. */
export function compareTie(a: UIElement, b: UIElement): number {
  const ra = isRealId(a) ? 0 : 1;
  const rb = isRealId(b) ? 0 : 1;
  if (ra !== rb) return ra - rb;
  const d = area(a.bounds) - area(b.bounds);
  if (d !== 0) return d;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function countElements(root: UIElement): number {
  let n = 1;
  for (const c of root.children) n += countElements(c);
  return n;
}
