import { getStroke } from "perfect-freehand";
import { bboxOf, type Point } from "./geometry.js";
import type { Annotation, InkData, Rect } from "./schemas.js";
import { renderShapeSvg } from "./vision.js";

/**
 * SVG rendering of annotations, shared by the canvas (live) and the compiler
 * (annotated PNGs), so both look the same.
 */

export const ACCENT = "#FF4F00";
export const ACCENT_INK = "#FFFFFF";
const HALO = "rgba(0,0,0,0.38)";
const FONT = "'Helvetica Neue', Helvetica, Arial, sans-serif";

export type RenderOptions = {
  /** Screenshot pixels per nominal pixel; strokes are 2 × unit wide. */
  unit: number;
  /** Marker number (or "U1" for rules). Omitted: no badge. */
  label?: string;
  accent?: string;
  /** Element bounds on this screen, for remove strike-outs and rule outlines. */
  boundsFor?: (elementId: string) => Rect | undefined;
  /** Screen size, for arrows that leave the tile. */
  screen?: { width: number; height: number };
  /** Title of the screen a cross-tile arrow points to. */
  toScreenTitle?: string;
  /** Warning style for unresolved annotations. */
  warn?: boolean;
};

const n = (v: number) => Math.round(v * 10) / 10;
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* ─────────────────────────── ink ─────────────────────────── */

export function strokeOutlinePath(points: readonly (readonly number[])[], size: number): string {
  const outline = getStroke(points as number[][], {
    size,
    thinning: 0.6,
    smoothing: 0.5,
    streamline: 0.4,
    simulatePressure: points.every((p) => p[2] === undefined || p[2] === 0.5 || p[2] === 0),
  });
  if (outline.length < 2) return "";
  const d = outline.reduce<(string | number)[]>(
    (acc, [x0, y0], i, arr) => {
      const [x1, y1] = arr[(i + 1) % arr.length]!;
      acc.push(n(x0!), n(y0!), n((x0! + x1!) / 2), n((y0! + y1!) / 2));
      return acc;
    },
    ["M", ...outline[0]!.map(n), "Q"],
  );
  d.push("Z");
  return d.join(" ");
}

function inkPaths(ink: InkData, unit: number, color: string): string {
  return ink.strokes
    .map((s) => {
      const d = strokeOutlinePath(s.points, 3.2 * unit);
      return d ? `<path d="${d}" fill="${color}"/>` : "";
    })
    .join("");
}

/** Standalone SVG of handwritten ink, cropped with padding, transparent background. */
export function renderInkSvg(ink: InkData, padding: number, unit = 1): { svg: string; bounds: Rect } {
  const pts = ink.strokes.flatMap((s) => s.points.map((p) => [p[0], p[1]] as Point));
  const bb = bboxOf(pts);
  const bounds = { x: bb.x - padding, y: bb.y - padding, w: bb.w + 2 * padding, h: bb.h + 2 * padding };
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(bounds.w)}" height="${Math.ceil(bounds.h)}" ` +
    `viewBox="${n(bounds.x)} ${n(bounds.y)} ${n(bounds.w)} ${n(bounds.h)}">` +
    inkPaths(ink, unit, "#111111") +
    `</svg>`;
  return { svg, bounds };
}

/* ─────────────────────────── badge ─────────────────────────── */

let clampBox: { width: number; height: number } | null = null;

function badge(x: number, y: number, label: string, unit: number, accent: string, warn = false): string {
  const r = 11 * unit;
  const w = Math.max(2 * r, (label.length * 7.4 + 10) * unit);
  if (clampBox) {
    x = Math.min(Math.max(x, unit), clampBox.width - w - unit);
    y = Math.min(Math.max(y, unit), clampBox.height - 2 * r - unit);
  }
  const fill = warn ? "#FFD400" : accent;
  const ink = warn ? "#111111" : ACCENT_INK;
  return (
    `<g class="ic-badge">` +
    `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(2 * r)}" rx="${n(r)}" fill="${fill}" stroke="${HALO}" stroke-width="${n(unit)}"/>` +
    `<text x="${n(x + w / 2)}" y="${n(y + r)}" dy="${n(4.3 * unit)}" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="${n(12.5 * unit)}" fill="${ink}">${esc(label)}</text>` +
    `</g>`
  );
}

/** Comment pin: a bubble with its sharp corner on the point. */
function pin(x: number, y: number, label: string, unit: number, accent: string, warn = false): string {
  const r = 12 * unit;
  const s = Math.max(2 * r, (label.length * 7.4 + 12) * unit);
  const top = y - 2 * r;
  const d =
    `M ${n(x)} ${n(y)} L ${n(x)} ${n(top + r)} A ${n(r)} ${n(r)} 0 0 1 ${n(x + r)} ${n(top)} ` +
    `L ${n(x + s - r)} ${n(top)} A ${n(r)} ${n(r)} 0 0 1 ${n(x + s)} ${n(top + r)} ` +
    `A ${n(r)} ${n(r)} 0 0 1 ${n(x + s - r)} ${n(y)} Z`;
  const fill = warn ? "#FFD400" : accent;
  const ink = warn ? "#111111" : ACCENT_INK;
  return (
    `<path d="${d}" fill="${fill}" stroke="${HALO}" stroke-width="${n(unit)}"/>` +
    `<text x="${n(x + s / 2)}" y="${n(top + r)}" dy="${n(4.3 * unit)}" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="${n(12.5 * unit)}" fill="${ink}">${esc(label)}</text>`
  );
}

/* ─────────────────────────── strokes ─────────────────────────── */

function stroked(d: string, unit: number, accent: string, extra = ""): string {
  const sw = 2 * unit;
  return (
    `<path d="${d}" fill="none" stroke="${HALO}" stroke-width="${n(sw + 2 * unit)}" stroke-linecap="round" stroke-linejoin="round" ${extra}/>` +
    `<path d="${d}" fill="none" stroke="${accent}" stroke-width="${n(sw)}" stroke-linecap="round" stroke-linejoin="round" ${extra}/>`
  );
}

const polyD = (pts: readonly (readonly number[])[], close = false) =>
  pts.length === 0
    ? ""
    : `M ${pts.map((p) => `${n(p[0]!)} ${n(p[1]!)}`).join(" L ")}${close ? " Z" : ""}`;

function arrowHead(from: Point, to: Point, unit: number): string {
  const ang = Math.atan2(to[1] - from[1], to[0] - from[0]);
  const len = 12 * unit;
  const spread = Math.PI / 7;
  const a: Point = [to[0] - len * Math.cos(ang - spread), to[1] - len * Math.sin(ang - spread)];
  const b: Point = [to[0] - len * Math.cos(ang + spread), to[1] - len * Math.sin(ang + spread)];
  return `M ${n(a[0])} ${n(a[1])} L ${n(to[0])} ${n(to[1])} L ${n(b[0])} ${n(b[1])}`;
}

/* ─────────────────────────── annotation ─────────────────────────── */

/** SVG fragment (a `<g>`) for one annotation, in screenshot pixel space. */
export function renderAnnotationSvg(a: Annotation, o: RenderOptions): string {
  const u = o.unit;
  const accent = o.accent ?? ACCENT;
  const g = a.geometry;
  const label = o.label;
  const parts: string[] = [];
  const penInk = a.ink && !a.ink.handwriting && a.ink.strokes.length > 0;
  clampBox = o.screen ?? null;

  switch (a.kind) {
    case "comment": {
      if (a.ink?.handwriting) {
        parts.push(inkPaths(a.ink, u, accent));
        if (label && !a.attachedTo) {
          const bb = bboxOf(a.ink.strokes.flatMap((s) => s.points));
          parts.push(badge(bb.x - 24 * u, bb.y - 24 * u, label, u, accent, o.warn));
        }
        break;
      }
      const p = g.type === "point" ? ([g.x, g.y] as Point) : pointOf(g);
      if (a.attachedTo) {
        // attached note: small dot, the parent carries the number
        parts.push(`<circle cx="${n(p[0])}" cy="${n(p[1])}" r="${n(5 * u)}" fill="${accent}" stroke="${HALO}" stroke-width="${n(u)}"/>`);
      } else {
        parts.push(pin(p[0], p[1], label ?? "•", u, accent, o.warn));
      }
      break;
    }

    case "circle":
    case "freehand": {
      if (penInk) parts.push(inkPaths(a.ink!, u, accent));
      else if (g.type === "path") parts.push(stroked(polyD(g.points, a.kind === "circle"), u, accent));
      if (label) {
        const bb = g.type === "path" ? bboxOf(g.points) : bboxOfGeom(g);
        const at = a.kind === "freehand" && g.type === "path" && g.points[0] ? g.points[0] : [bb.x, bb.y];
        parts.push(badge(at[0]! - 12 * u, at[1]! - 24 * u, label, u, accent, o.warn));
      }
      break;
    }

    case "rectangle": {
      const r = g.type === "rect" ? g : bboxOfGeom(g);
      parts.push(
        `<rect x="${n(r.x)}" y="${n(r.y)}" width="${n(r.w)}" height="${n(r.h)}" fill="${accent}" fill-opacity="0.08"/>`,
      );
      parts.push(
        stroked(
          `M ${n(r.x)} ${n(r.y)} H ${n(r.x + r.w)} V ${n(r.y + r.h)} H ${n(r.x)} Z`,
          u,
          accent,
          `stroke-dasharray="${n(7 * u)} ${n(5 * u)}"`,
        ),
      );
      if (label) parts.push(badge(r.x - 12 * u, r.y - 24 * u, label, u, accent, o.warn));
      break;
    }

    case "arrow": {
      if (g.type !== "arrow") break;
      let to: Point = g.to;
      const leaves = !!g.toScreenId && g.toScreenId !== a.screenId;
      if (leaves) {
        const w = o.screen?.width ?? g.from[0] + 200 * u;
        to = [w - 6 * u, g.from[1]];
      }
      if (penInk) parts.push(inkPaths(a.ink!, u, accent));
      else parts.push(stroked(`M ${n(g.from[0])} ${n(g.from[1])} L ${n(to[0])} ${n(to[1])} ${arrowHead(g.from, to, u)}`, u, accent));
      parts.push(`<circle cx="${n(g.from[0])}" cy="${n(g.from[1])}" r="${n(3.5 * u)}" fill="${accent}"/>`);
      if (leaves && o.toScreenTitle) {
        const t = `→ ${o.toScreenTitle}`;
        const w = (t.length * 6.6 + 14) * u;
        parts.push(
          `<rect x="${n(to[0] - w)}" y="${n(to[1] + 8 * u)}" width="${n(w)}" height="${n(20 * u)}" rx="${n(3 * u)}" fill="#111111" fill-opacity="0.85"/>` +
            `<text x="${n(to[0] - w / 2)}" y="${n(to[1] + 18 * u)}" dy="${n(4 * u)}" text-anchor="middle" font-family="${FONT}" font-weight="600" font-size="${n(11 * u)}" fill="#FFFFFF">${esc(t)}</text>`,
        );
      }
      if (label) parts.push(badge(g.from[0] - 26 * u, g.from[1] - 26 * u, label, u, accent, o.warn));
      break;
    }

    case "remove": {
      const el = a.resolution?.elements[0] ? o.boundsFor?.(a.resolution.elements[0]) : undefined;
      if (penInk) parts.push(inkPaths(a.ink!, u, accent));
      if (el) {
        parts.push(
          `<rect x="${n(el.x)}" y="${n(el.y)}" width="${n(el.w)}" height="${n(el.h)}" fill="${accent}" fill-opacity="0.12"/>`,
        );
        parts.push(stroked(`M ${n(el.x)} ${n(el.y)} H ${n(el.x + el.w)} V ${n(el.y + el.h)} H ${n(el.x)} Z`, u, accent));
        if (!penInk)
          parts.push(
            stroked(
              `M ${n(el.x)} ${n(el.y)} L ${n(el.x + el.w)} ${n(el.y + el.h)} M ${n(el.x + el.w)} ${n(el.y)} L ${n(el.x)} ${n(el.y + el.h)}`,
              u,
              accent,
            ),
          );
        if (label) parts.push(badge(el.x - 12 * u, el.y - 24 * u, label, u, accent, o.warn));
      } else {
        const p = pointOf(g);
        const s = 12 * u;
        if (!penInk)
          parts.push(
            stroked(
              `M ${n(p[0] - s)} ${n(p[1] - s)} L ${n(p[0] + s)} ${n(p[1] + s)} M ${n(p[0] + s)} ${n(p[1] - s)} L ${n(p[0] - s)} ${n(p[1] + s)}`,
              u,
              accent,
            ),
          );
        if (label) parts.push(badge(p[0] - s - 12 * u, p[1] - s - 24 * u, label, u, accent, o.warn));
      }
      break;
    }

    case "sketch": {
      if (!a.sketch) break;
      const { shape, style } = a.sketch;
      if (shape === "line") {
        const pts = g.type === "path" ? g.points : [];
        if (pts.length < 2) break;
        parts.push(renderShapeSvg({ shape, from: pts[0]!, to: pts[pts.length - 1]!, style }));
      } else {
        parts.push(renderShapeSvg({ shape, rect: bboxOfGeom(g), style, text: a.text }));
      }
      if (label) {
        const bb = bboxOfGeom(g);
        parts.push(badge(bb.x - 12 * u, bb.y - 24 * u, label, u, accent, o.warn));
      }
      break;
    }

    case "rule": {
      const ids = a.resolution?.elements ?? a.targets ?? [];
      let first: Rect | undefined;
      for (const t of ids) {
        const local = t.includes("#") ? (t.startsWith(`${a.screenId}#`) ? t.slice(a.screenId.length + 1) : null) : t;
        if (!local) continue;
        const b = o.boundsFor?.(local);
        if (!b) continue;
        first ??= b;
        parts.push(
          stroked(
            `M ${n(b.x - 3 * u)} ${n(b.y - 3 * u)} H ${n(b.x + b.w + 3 * u)} V ${n(b.y + b.h + 3 * u)} H ${n(b.x - 3 * u)} Z`,
            u,
            accent,
            `stroke-dasharray="${n(2 * u)} ${n(4 * u)}"`,
          ),
        );
      }
      if (label && first) parts.push(badge(first.x - 12 * u, first.y - 26 * u, label, u, accent));
      break;
    }
  }

  clampBox = null;
  return `<g data-annotation="${esc(a.id)}">${parts.join("")}</g>`;
}

function pointOf(g: Annotation["geometry"]): Point {
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

function bboxOfGeom(g: Annotation["geometry"]): Rect {
  switch (g.type) {
    case "point":
      return { x: g.x, y: g.y, w: 0, h: 0 };
    case "rect":
      return g;
    case "arrow":
      return bboxOf([g.from, g.to]);
    case "path":
      return bboxOf(g.points);
  }
}

/* ─────────────────────────── full screen ─────────────────────────── */

export type AnnotatedScreenInput = {
  width: number;
  height: number;
  /** Image href, usually a data: URI of the screenshot PNG. */
  href: string;
  annotations: Annotation[];
  labels: Map<string, string>;
  unit: number;
  boundsFor: (elementId: string) => Rect | undefined;
  screenTitle?: (screenId: string) => string | undefined;
};

/** Full SVG document: screenshot plus every annotation on it, numbered. */
export function renderAnnotatedScreenSvg(i: AnnotatedScreenInput): string {
  const body = i.annotations
    .map((a) =>
      renderAnnotationSvg(a, {
        unit: i.unit,
        label: i.labels.get(a.id),
        boundsFor: i.boundsFor,
        screen: { width: i.width, height: i.height },
        toScreenTitle:
          a.geometry.type === "arrow" && a.geometry.toScreenId
            ? (i.screenTitle?.(a.geometry.toScreenId) ?? a.geometry.toScreenId)
            : undefined,
        warn: a.resolution?.status === "unresolved",
      }),
    )
    .join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${i.width}" height="${i.height}" viewBox="0 0 ${i.width} ${i.height}">` +
    `<image href="${i.href}" xlink:href="${i.href}" x="0" y="0" width="${i.width}" height="${i.height}"/>` +
    body +
    `</svg>`
  );
}
