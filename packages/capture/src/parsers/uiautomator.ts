import type { RawElement } from "@intentcue/core";
import { androidType } from "./typeMaps.js";

/**
 * Parse `adb shell uiautomator dump` XML. Bounds are already in screen pixels.
 * A tiny purpose-built parser: the dump only uses <hierarchy> and <node> tags
 * with double-quoted attributes.
 */
export function parseUiautomator(xml: string): RawElement {
  const tagRe = /<(\/?)(hierarchy|node)\b([^>]*?)(\/?)>/g;
  const attrRe = /([\w:-]+)="([^"]*)"/g;
  const root: RawElement = { type: "screen", bounds: { x: 0, y: 0, w: 0, h: 0 }, children: [] };
  const stack: RawElement[] = [root];
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xml))) {
    const [, closing, tag, attrText, selfClosing] = m;
    if (tag === "hierarchy") continue;
    if (closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const attrs: Record<string, string> = {};
    let a: RegExpExecArray | null;
    attrRe.lastIndex = 0;
    while ((a = attrRe.exec(attrText!))) attrs[a[1]!] = decode(a[2]!);
    const el = nodeToRaw(attrs);
    stack[stack.length - 1]!.children.push(el);
    if (!selfClosing) stack.push(el);
  }
  // root bounds = union of top-level nodes
  let w = 0;
  let h = 0;
  for (const c of root.children) {
    w = Math.max(w, c.bounds.x + c.bounds.w);
    h = Math.max(h, c.bounds.y + c.bounds.h);
  }
  root.bounds = { x: 0, y: 0, w, h };
  return root;
}

export function parseBoundsPair(s: string | undefined): { x: number; y: number; w: number; h: number } {
  const m = /\[(-?[\d.]+),(-?[\d.]+)\]\[(-?[\d.]+),(-?[\d.]+)\]/.exec(s ?? "");
  if (!m) return { x: 0, y: 0, w: 0, h: 0 };
  const [x1, y1, x2, y2] = m.slice(1).map(Number) as [number, number, number, number];
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

function nodeToRaw(attrs: Record<string, string>): RawElement {
  const native = attrs["class"];
  const clickable = attrs["clickable"] === "true";
  const resId = attrs["resource-id"] ?? "";
  const id = resId.includes(":id/") ? resId.slice(resId.indexOf(":id/") + 4) : resId;
  const label = (attrs["text"] || attrs["content-desc"] || "").trim();
  const el: RawElement = {
    type: androidType(native, { clickable }),
    bounds: parseBoundsPair(attrs["bounds"]),
    visible: attrs["visible-to-user"] !== "false",
    children: [],
  };
  if (native) el.nativeType = native;
  if (id) {
    el.id = id;
    el.idSource = "testId";
  }
  if (label) el.label = label;
  return el;
}

function decode(s: string): string {
  return s
    .replace(/&#10;/g, "\n")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}
