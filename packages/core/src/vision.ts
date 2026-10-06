import { bboxOf, type Point } from "./geometry.js";
import { strokeOutlinePath } from "./render.js";
import type { Rect, SketchShape, SketchStyle, VisionCanvas, VisionItem } from "./schemas.js";

/**
 * The vision board: white canvases the user sketches a visual direction on.
 * Shared by the canvas (live) and the server (PNG export for the agent).
 */

export const VISION_FONT = "Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif";
/** Line height of vision and sketch text, as a multiple of the font size. */
export const TEXT_LINE = 1.25;

const n = (v: number) => Math.round(v * 100) / 100;
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* ─────────────────────────── geometry ─────────────────────────── */

/** Axis-aligned bounds of an item, rotation included. */
export function itemBounds(item: VisionItem): Rect {
  switch (item.type) {
    case "stroke": {
      const b = bboxOf(item.points.map((p) => [p[0], p[1]] as Point));
      const r = item.style.width / 2;
      return { x: b.x - r, y: b.y - r, w: b.w + 2 * r, h: b.h + 2 * r };
    }
    case "line": {
      const b = bboxOf([item.from, item.to]);
      const r = item.style.width / 2;
      return { x: b.x - r, y: b.y - r, w: b.w + 2 * r, h: b.h + 2 * r };
    }
    default:
      return rotatedBounds(item, item.rotation ?? 0);
  }
}

function rotatedBounds(r: Rect, deg: number): Rect {
  if (!deg) return { x: r.x, y: r.y, w: r.w, h: r.h };
  const a = (deg * Math.PI) / 180;
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const pts: Point[] = [
    [r.x, r.y],
    [r.x + r.w, r.y],
    [r.x + r.w, r.y + r.h],
    [r.x, r.y + r.h],
  ].map(([x, y]) => [cx + (x! - cx) * Math.cos(a) - (y! - cy) * Math.sin(a), cy + (x! - cx) * Math.sin(a) + (y! - cy) * Math.cos(a)]);
  return bboxOf(pts);
}

const contains = (c: Rect, p: Point) => p[0] >= c.x && p[0] <= c.x + c.w && p[1] >= c.y && p[1] <= c.y + c.h;

/** The canvas an item belongs to: the one its centre is on. */
export function canvasOf(item: VisionItem, canvases: VisionCanvas[]): VisionCanvas | undefined {
  const b = itemBounds(item);
  const c: Point = [b.x + b.w / 2, b.y + b.h / 2];
  return canvases.find((k) => contains(k, c));
}

/**
 * A new canvas for something drawn off every canvas: `size` big (larger when the
 * drawing is), centred on the drawing, kept clear of the canvases around it.
 */
export function wrapCanvas(drawn: Rect, canvases: Rect[], size: { w: number; h: number }, gap = 80, pad = 40): Rect {
  // start with the drawing plus padding, then grow toward `size` without running into neighbours
  let r = { x: drawn.x - pad, y: drawn.y - pad, w: drawn.w + 2 * pad, h: drawn.h + 2 * pad };
  const overlapsY = (c: Rect) => c.y < r.y + r.h + gap && c.y + c.h > r.y - gap;
  const overlapsX = (c: Rect) => c.x < r.x + r.w + gap && c.x + c.w > r.x - gap;

  // grow each axis to `size`: evenly, and when a neighbour blocks one side, the rest goes to the other
  const grow = (lo: number, hi: number, want: number, min: number, max: number): [number, number] => {
    const need = Math.max(0, want - (hi - lo));
    const roomLo = Math.max(0, lo - min);
    const roomHi = Math.max(0, max - hi);
    let takeLo = Math.min(need / 2, roomLo);
    const takeHi = Math.min(need - takeLo, roomHi);
    takeLo = Math.min(need - takeHi, roomLo);
    return [lo - takeLo, hi + takeHi];
  };
  let minX = -Infinity;
  let maxX = Infinity;
  for (const c of canvases.filter(overlapsY)) {
    if (c.x + c.w <= r.x) minX = Math.max(minX, c.x + c.w + gap);
    if (c.x >= r.x + r.w) maxX = Math.min(maxX, c.x - gap);
  }
  const [x0, x1] = grow(r.x, r.x + r.w, size.w, minX, maxX);
  r = { ...r, x: x0, w: x1 - x0 };
  let minY = -Infinity;
  let maxY = Infinity;
  for (const c of canvases.filter(overlapsX)) {
    if (c.y + c.h <= r.y) minY = Math.max(minY, c.y + c.h + gap);
    if (c.y >= r.y + r.h) maxY = Math.min(maxY, c.y - gap);
  }
  const [y0, y1] = grow(r.y, r.y + r.h, size.h, minY, maxY);
  r = { ...r, y: y0, h: y1 - y0 };
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
}

/* ─────────────────────────── shapes ─────────────────────────── */

export type ShapeInput =
  | { shape: "line"; from: Point; to: Point; style: SketchStyle }
  | { shape: Exclude<SketchShape, "line">; rect: Rect; style: SketchStyle; text?: string; rotation?: number };

/** One drawn shape as SVG. Used for vision items and board sketches alike. */
export function renderShapeSvg(s: ShapeInput): string {
  const st = s.style;
  if (s.shape === "line") {
    return `<path d="M ${n(s.from[0])} ${n(s.from[1])} L ${n(s.to[0])} ${n(s.to[1])}" fill="none" stroke="${esc(st.color)}" stroke-width="${n(st.width)}" stroke-linecap="round"/>`;
  }
  const r = s.rect;
  const rot = s.rotation ? ` transform="rotate(${n(s.rotation)} ${n(r.x + r.w / 2)} ${n(r.y + r.h / 2)})"` : "";
  const fill = st.fill ? esc(st.fill) : "none";
  switch (s.shape) {
    case "box":
      return `<rect x="${n(r.x)}" y="${n(r.y)}" width="${n(r.w)}" height="${n(r.h)}" fill="${fill}" stroke="${esc(st.color)}" stroke-width="${n(st.width)}" stroke-linejoin="round"${rot}/>`;
    case "ellipse":
      return `<ellipse cx="${n(r.x + r.w / 2)}" cy="${n(r.y + r.h / 2)}" rx="${n(r.w / 2)}" ry="${n(r.h / 2)}" fill="${fill}" stroke="${esc(st.color)}" stroke-width="${n(st.width)}"${rot}/>`;
    case "text": {
      const size = st.size ?? 24;
      const lines = (s.text ?? "").split("\n");
      const spans = lines
        .map((l, i) => `<tspan x="${n(r.x)}" ${i === 0 ? `y="${n(r.y + size)}"` : `dy="${n(size * TEXT_LINE)}"`}>${esc(l) || " "}</tspan>`)
        .join("");
      return `<text font-family="${VISION_FONT}" font-size="${n(size)}" font-weight="500" fill="${esc(st.color)}" xml:space="preserve"${rot}>${spans}</text>`;
    }
  }
}

/** Size of text in a font size, for when it can't be measured (export, tests). */
export function estimateTextBox(text: string, size: number): { w: number; h: number } {
  const lines = text.split("\n");
  const longest = Math.max(1, ...lines.map((l) => l.length));
  return { w: Math.ceil(longest * size * 0.56), h: Math.ceil(lines.length * size * TEXT_LINE) };
}

/** One vision item as SVG; `href` maps an image's `src` to a URL or data URI. */
export function renderVisionItemSvg(item: VisionItem, href: (src: string) => string): string {
  switch (item.type) {
    case "stroke": {
      const d = strokeOutlinePath(item.points, item.style.width);
      return d ? `<path d="${d}" fill="${esc(item.style.color)}"/>` : "";
    }
    case "line":
      return renderShapeSvg({ shape: "line", from: item.from, to: item.to, style: item.style });
    case "box":
    case "ellipse":
      return renderShapeSvg({ shape: item.type, rect: item, style: item.style, rotation: item.rotation });
    case "text":
      return renderShapeSvg({ shape: "text", rect: item, style: item.style, text: item.text, rotation: item.rotation });
    case "image": {
      const rot = item.rotation ? ` transform="rotate(${n(item.rotation)} ${n(item.x + item.w / 2)} ${n(item.y + item.h / 2)})"` : "";
      const h = esc(href(item.src));
      return `<image href="${h}" xlink:href="${h}" x="${n(item.x)}" y="${n(item.y)}" width="${n(item.w)}" height="${n(item.h)}" preserveAspectRatio="none"${rot}/>`;
    }
  }
}

/** A canvas as a standalone SVG document: white page, its items, clipped to the page. */
export function renderVisionCanvasSvg(canvas: VisionCanvas, items: VisionItem[], href: (src: string) => string): string {
  const { x, y, w, h } = canvas;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${Math.round(w)}" height="${Math.round(h)}" viewBox="${n(x)} ${n(y)} ${n(w)} ${n(h)}">` +
    `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" fill="#FFFFFF"/>` +
    items.map((i) => renderVisionItemSvg(i, href)).join("") +
    `</svg>`
  );
}

/** Canvases that have something on them, in reading order, each with its items. */
export function visionPages(file: { canvases: VisionCanvas[]; items: VisionItem[] }): { canvas: VisionCanvas; items: VisionItem[] }[] {
  const order = [...file.canvases].sort((a, b) => (Math.abs(a.y - b.y) > Math.min(a.h, b.h) / 2 ? a.y - b.y : a.x - b.x));
  return order
    .map((canvas) => ({ canvas, items: file.items.filter((i) => canvasOf(i, file.canvases)?.id === canvas.id) }))
    .filter((p) => p.items.length > 0);
}

/* ─────────────────────────── markdown ─────────────────────────── */

/** vision.md: the canvases as images, plus the words written on them. */
export function renderVisionMarkdown(pages: { file: string; items: VisionItem[] }[], round: number): string {
  const L: string[] = [];
  L.push(`# Visual direction, round ${round}`, "");
  L.push(
    "The user sketched how the app should look and feel. Use these canvases as a design reference for layout, hierarchy, content and mood, both for the changes in review.md and for any UI you add. They are rough sketches, not pixel specs: keep the app's existing components and design tokens where they fit. When a canvas and an instruction in review.md disagree, follow review.md.",
    "",
  );
  pages.forEach((p, i) => {
    L.push(`## Canvas ${i + 1}`, "", `![Canvas ${i + 1}](${p.file})`, "");
    const texts = p.items.filter((x): x is Extract<VisionItem, { type: "text" }> => x.type === "text").map((x) => x.text.trim()).filter(Boolean);
    if (texts.length) {
      L.push("Text written on it:");
      for (const t of texts) L.push(`- "${t.replace(/\s*\n\s*/g, " / ")}"`);
      L.push("");
    }
    const images = p.items.filter((x) => x.type === "image").length;
    if (images) L.push(`${images} reference image${images === 1 ? "" : "s"} placed on it (shown in the canvas).`, "");
  });
  return L.join("\n");
}
