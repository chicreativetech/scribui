import { dilate, floodFill, growInto, strokeOutlinePath, traceLoops, type Rect, type SketchPart, type VisionItem } from "@scribui/core";

/**
 * The fill tool, for board sketches and vision canvases alike: a click on a line recolours
 * it, inside a box or an ellipse fills that shape, and inside any other closed area (lines,
 * strokes and shapes together) flood-fills it.
 */

type Pt = [number, number];
/** A sketch part or a vision item: the same shapes. */
export type Paintable = SketchPart | VisionItem;

export type Bucket =
  /** Recolour shape `index` (a line, stroke, text, a shape's outline or a fill). */
  | { kind: "recolor"; index: number }
  /** Fill box or ellipse `index`. */
  | { kind: "shape"; index: number }
  /** A new fill. */
  | { kind: "area"; loops: Pt[][] }
  /** open: the area isn't closed; image: images can't be filled. */
  | { kind: "none"; why: "open" | "image" };

export type BucketOptions = {
  /** The area to fill in; a fill reaching its edge is `open` unless `closed`. */
  bounds: Rect;
  /** The bounds are a page: its edge closes an area. */
  closed: boolean;
  /** How near a line counts as on it, in the shapes' units. */
  tol: number;
  /** Gaps up to about twice this in hand-drawn lines still close an area, in the shapes' units. */
  gap: number;
};

/** Raster pixels on the longer side, at most. */
const MAX_RASTER = 1600;

let ctx2d: CanvasRenderingContext2D | null = null;
const testCtx = () => (ctx2d ??= document.createElement("canvas").getContext("2d")!);

type BoxShape = Extract<Paintable, { type: "box" | "ellipse" | "text" | "image" }>;

/** Rotate the context about a box's centre. */
function rotate(c: CanvasRenderingContext2D, s: BoxShape) {
  const deg = "rotation" in s ? (s.rotation ?? 0) : 0;
  if (!deg) return;
  const cx = s.x + s.w / 2;
  const cy = s.y + s.h / 2;
  c.translate(cx, cy);
  c.rotate((deg * Math.PI) / 180);
  c.translate(-cx, -cy);
}

function boxPath(s: BoxShape): Path2D {
  const p = new Path2D();
  if (s.type === "ellipse") p.ellipse(s.x + s.w / 2, s.y + s.h / 2, Math.max(0.5, s.w / 2), Math.max(0.5, s.h / 2), 0, 0, Math.PI * 2);
  else p.rect(s.x, s.y, s.w, s.h);
  return p;
}

function loopsPath(loops: Pt[][]): Path2D {
  const p = new Path2D();
  for (const l of loops) {
    l.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y)));
    p.closePath();
  }
  return p;
}

/** What a click with the fill tool at `p` does. */
export function paintBucket(shapes: Paintable[], p: Pt, o: BucketOptions): Bucket {
  const c = testCtx();
  // on top first; fills lie under everything and are matched by area further down
  const order = shapes.map((_, i) => i).reverse();
  // the topmost unfilled box or ellipse around the click: what's below it only shows through
  let inside: number | null = null;
  for (const i of order) {
    if (inside !== null) break;
    const s = shapes[i]!;
    c.setTransform(1, 0, 0, 1, 0, 0);
    switch (s.type) {
      case "stroke": {
        const path = new Path2D(strokeOutlinePath(s.points, s.style.width));
        c.lineWidth = o.tol * 2;
        if (c.isPointInPath(path, p[0], p[1]) || c.isPointInStroke(path, p[0], p[1])) return { kind: "recolor", index: i };
        break;
      }
      case "line": {
        const path = new Path2D();
        path.moveTo(...s.from);
        path.lineTo(...s.to);
        c.lineWidth = s.style.width + o.tol * 2;
        if (c.isPointInStroke(path, p[0], p[1])) return { kind: "recolor", index: i };
        break;
      }
      case "box":
      case "ellipse": {
        rotate(c, s);
        const path = boxPath(s);
        c.lineWidth = s.style.width + o.tol * 2;
        if (c.isPointInStroke(path, p[0], p[1])) return { kind: "recolor", index: i };
        if (c.isPointInPath(path, p[0], p[1])) {
          if (s.style.fill) return { kind: "shape", index: i };
          inside = i;
        }
        break;
      }
      case "text":
      case "image": {
        rotate(c, s);
        if (c.isPointInPath(boxPath(s), p[0], p[1])) return s.type === "text" ? { kind: "recolor", index: i } : { kind: "none", why: "image" };
        break;
      }
      case "fill":
        break;
    }
  }
  c.setTransform(1, 0, 0, 1, 0, 0);
  const fillsHere = order.filter((i) => {
    const s = shapes[i]!;
    return s.type === "fill" && c.isPointInPath(loopsPath(s.loops), p[0], p[1], "evenodd");
  });

  // flood fill a raster of the lines: like a paint program, a colour inside an area doesn't wall it off
  const { bounds: b } = o;
  const scale = Math.min(2, MAX_RASTER / Math.max(b.w, b.h, 1));
  const w = Math.max(1, Math.ceil(b.w * scale));
  const h = Math.max(1, Math.ceil(b.h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const r = canvas.getContext("2d", { willReadFrequently: true })!;
  r.fillStyle = r.strokeStyle = "#000";
  r.lineCap = r.lineJoin = "round";
  for (const s of shapes) {
    r.setTransform(scale, 0, 0, scale, -b.x * scale, -b.y * scale);
    switch (s.type) {
      case "stroke":
        r.fill(new Path2D(strokeOutlinePath(s.points, s.style.width)));
        break;
      case "line":
        r.lineWidth = s.style.width;
        r.beginPath();
        r.moveTo(...s.from);
        r.lineTo(...s.to);
        r.stroke();
        break;
      case "box":
      case "ellipse": {
        rotate(r, s);
        r.lineWidth = s.style.width;
        r.stroke(boxPath(s));
        break;
      }
      case "text":
      case "image":
        rotate(r, s);
        r.fill(boxPath(s));
        break;
      case "fill":
        break;
    }
  }
  const px = r.getImageData(0, 0, w, h).data;
  const wall = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) wall[i] = px[i * 4 + 3]! > 100 ? 1 : 0;
  const drawn = { w, h, data: wall };
  const sx = (p[0] - b.x) * scale;
  const sy = (p[1] - b.y) * scale;
  const g = Math.min(10, Math.max(1, Math.round(o.gap * scale)));
  // close small gaps; a click right next to a line falls back to the lines as drawn
  const closedUp = dilate(drawn, g);
  const flood = floodFill(closedUp, sx, sy) ?? floodFill(drawn, sx, sy);
  if (!flood || flood.count < 9 || (flood.touchesEdge && !o.closed)) {
    // an area that has since been opened up can still be recoloured
    return fillsHere.length ? { kind: "recolor", index: fillsHere[0]! } : { kind: "none", why: "open" };
  }

  /** The flood is the whole of what `draw` paints, as far as the lines leave room: nothing more, nothing crossing it. */
  const isAll = (draw: () => void) => {
    r.setTransform(1, 0, 0, 1, 0, 0);
    r.clearRect(0, 0, w, h);
    r.setTransform(scale, 0, 0, scale, -b.x * scale, -b.y * scale);
    draw();
    const area = r.getImageData(0, 0, w, h).data;
    let room = 0;
    let shared = 0;
    for (let i = 0; i < w * h; i++) {
      if (area[i * 4 + 3]! <= 100) continue;
      if (!closedUp.data[i]) room++;
      if (flood.mask.data[i]) shared++;
    }
    return shared >= 0.95 * flood.count && flood.count >= 0.85 * room;
  };
  // the inside of the box or ellipse: fill the shape itself
  if (inside !== null) {
    const s = shapes[inside] as Extract<Paintable, { type: "box" | "ellipse" }>;
    if (
      isAll(() => {
        rotate(r, s);
        r.fill(boxPath(s));
      })
    )
      return { kind: "shape", index: inside };
  }
  // the same area as a fill already there: recolour it
  for (const i of fillsHere) {
    const s = shapes[i] as Extract<Paintable, { type: "fill" }>;
    if (isAll(() => r.fill(loopsPath(s.loops), "evenodd"))) return { kind: "recolor", index: i };
  }
  // grow back into the band along the lines that closing the gaps took (corners included),
  // then just under the lines, so no gap shows
  const free = { w, h, data: closedUp.data.map((d, i) => (d && !wall[i] ? 1 : 0)) };
  const grown = dilate(growInto(flood.mask, free, 4 * g), 1);
  return {
    kind: "area",
    loops: traceLoops(grown).map((l) => l.map(([x, y]) => [Math.round((x / scale + b.x) * 10) / 10, Math.round((y / scale + b.y) * 10) / 10] as Pt)),
  };
}
