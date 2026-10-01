import { area, containsRect, type RawElement } from "@intentcue/core";
import { iosType } from "./typeMaps.js";

type IdbItem = {
  AXFrame?: string;
  frame?: { x: number; y: number; width: number; height: number };
  AXUniqueId?: string | null;
  AXLabel?: string | null;
  AXValue?: string | null;
  title?: string | null;
  type?: string | null;
  role?: string | null;
  children?: IdbItem[];
};

/**
 * Parse `idb ui describe-all --json` (flat list) or `--nested` output.
 * Bounds are in points; `scale` converts them to screenshot pixels.
 */
export function parseIdb(json: string, scale: number): RawElement {
  const data = JSON.parse(extractJson(json)) as IdbItem[] | IdbItem;
  const items = Array.isArray(data) ? data : [data];
  const nested = items.some((i) => Array.isArray(i.children) && i.children.length > 0);
  const raws = nested ? items.map((i) => toRawNested(i, scale)) : items.map((i) => toRaw(i, scale));
  if (nested) {
    if (raws.length === 1) return asRoot(raws[0]!);
    return asRoot(wrap(raws));
  }
  return asRoot(buildByContainment(raws));
}

function extractJson(s: string): string {
  const i = s.search(/[[{]/);
  return i >= 0 ? s.slice(i) : s;
}

function frameOf(i: IdbItem): { x: number; y: number; w: number; h: number } {
  if (i.frame) return { x: i.frame.x, y: i.frame.y, w: i.frame.width, h: i.frame.height };
  const m = /\{\{(-?[\d.]+),\s*(-?[\d.]+)\},\s*\{(-?[\d.]+),\s*(-?[\d.]+)\}\}/.exec(i.AXFrame ?? "");
  if (!m) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: +m[1]!, y: +m[2]!, w: +m[3]!, h: +m[4]! };
}

function toRaw(i: IdbItem, scale: number): RawElement {
  const f = frameOf(i);
  const native = i.type ?? i.role ?? undefined;
  const el: RawElement = {
    type: iosType(native ?? undefined),
    bounds: { x: f.x * scale, y: f.y * scale, w: f.w * scale, h: f.h * scale },
    children: [],
  };
  if (native) el.nativeType = native;
  if (i.AXUniqueId) {
    el.id = i.AXUniqueId;
    el.idSource = "accessibility";
  }
  const label = (i.AXLabel || i.title || i.AXValue || "").trim();
  if (label) el.label = label;
  return el;
}

function toRawNested(i: IdbItem, scale: number): RawElement {
  const el = toRaw(i, scale);
  el.children = (i.children ?? []).map((c) => toRawNested(c, scale));
  return el;
}

/** Flat list → tree: each element goes into the smallest earlier element that contains it. */
export function buildByContainment(items: RawElement[]): RawElement {
  const sorted = items
    .map((el, i) => ({ el, i }))
    .sort((a, b) => area(b.el.bounds) - area(a.el.bounds) || a.i - b.i);
  const placed: RawElement[] = [];
  const roots: RawElement[] = [];
  for (const { el } of sorted) {
    let parent: RawElement | null = null;
    for (const p of placed) {
      if (containsRect(p.bounds, el.bounds) && (!parent || area(p.bounds) <= area(parent.bounds))) parent = p;
    }
    if (parent) parent.children.push(el);
    else roots.push(el);
    placed.push(el);
  }
  // restore reading order among siblings
  const order = new Map(items.map((el, i) => [el, i]));
  const sortKids = (e: RawElement) => {
    e.children.sort((a, b) => order.get(a)! - order.get(b)!);
    e.children.forEach(sortKids);
  };
  roots.forEach(sortKids);
  return roots.length === 1 ? roots[0]! : wrap(roots);
}

function wrap(children: RawElement[]): RawElement {
  let w = 0;
  let h = 0;
  for (const c of children) {
    w = Math.max(w, c.bounds.x + c.bounds.w);
    h = Math.max(h, c.bounds.y + c.bounds.h);
  }
  return { type: "screen", bounds: { x: 0, y: 0, w, h }, children };
}

function asRoot(e: RawElement): RawElement {
  return { ...e, type: "screen" };
}
