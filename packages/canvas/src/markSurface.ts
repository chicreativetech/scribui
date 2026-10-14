import { estimateTextBox, renderAnnotationSvg, renderSketchPartsSvg, sketchPartsBounds, type Annotation, type SketchPart, type SketchStyle } from "@scribui/core";
import { paintBucket } from "./paint";

/**
 * Marking up a live app with Review's tools, without React: the App tab's page
 * layer (desktop markLayer.ts, inside the reviewed page) and the Device tab's
 * frozen screen (Marking.tsx) both run it. It draws with Review's own renderer,
 * so a mark looks the same here as in Review.
 *
 * Guide tools make one mark each (a comment or remove needs a click, the others
 * a drag), then ask for its note. Sketch tools add to one open sketch, whatever
 * the tool, until Ready (⏎) or a guide tool; then the sketch asks for its note.
 * Finished marks go to the host in surface coordinates (the host's own space:
 * page CSS pixels, or pixels of the shown screen), which turns them into notes.
 */

type Pt = [number, number];
export type SurfaceTool = "comment" | "circle" | "arrow" | "rectangle" | "remove" | "freehand" | "line" | "box" | "ellipse" | "text" | "fill";
export type SketchTool = "freehand" | "line" | "box" | "ellipse" | "text" | "fill";
export type Styles = Record<SketchTool, SketchStyle>;
/** A finished mark: an annotation without its id and screen, and the point it's about. */
export type SurfaceMark = { annotation: Omit<Annotation, "id" | "screenId">; ref: Pt };
/** A note to show: in surface coordinates, moved by `offset` (where its element is now). */
export type ShownMark = { annotation: Annotation; label?: string; offset?: Pt; faint?: boolean };

export type SurfaceHost = {
  /** Surface coordinates of a point in the viewport (clientX, clientY). */
  toSurface(x: number, y: number): Pt;
  /** Where surface (0, 0) is, relative to the surface element's top-left corner. */
  origin(): Pt;
  onMark(m: SurfaceMark): void;
  /** Wheel over the pad while nothing is being drawn (web: scroll the page). */
  onWheel?(e: WheelEvent): void;
  /** Escape with nothing in progress: stop marking. */
  onExit?(): void;
  /** Something to tell the user (fill found no closed area). */
  say?(text: string): void;
};

const SKETCH = new Set<SurfaceTool>(["freehand", "line", "box", "ellipse", "text", "fill"]);
const isSketch = (t: SurfaceTool | null): t is SketchTool => !!t && SKETCH.has(t);

const STYLE = (p: string) => `
.${p} { position: absolute; inset: 0; pointer-events: none; }
.${p} svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
.${p}-pad { position: absolute; inset: 0; pointer-events: auto; cursor: crosshair; touch-action: none; }
.${p}-pad[hidden], .${p}-note[hidden], .${p}-ready[hidden] { display: none; }
.${p}-faint { opacity: 0.6; }
.${p}-note { position: absolute; display: flex; gap: 6px; padding: 6px; background: #fff; border: 1px solid #262626;
  box-shadow: 0 6px 20px rgba(0,0,0,.18); pointer-events: auto; z-index: 2; }
.${p}-note input { width: 240px; border: 1px solid #d0d0d0; padding: 5px 7px; font: 400 12.5px -apple-system, "Helvetica Neue", Arial, sans-serif;
  color: #262626; outline: none; background: #fff; user-select: text; -webkit-user-select: text; }
.${p}-note input:focus { border-color: #262626; }
.${p}-note button, .${p}-ready { font: 600 12px/1 -apple-system, "Helvetica Neue", Arial, sans-serif; cursor: pointer; border: 1px solid #262626;
  background: #ff9f0a; color: #262626; padding: 0 10px; }
.${p}-ready { position: absolute; padding: 7px 10px; pointer-events: auto; z-index: 2; }
`;

export class MarkSurface {
  readonly el: HTMLDivElement;
  private svg: SVGSVGElement;
  private pad: HTMLDivElement;
  private note: HTMLDivElement;
  private input: HTMLInputElement;
  private ready: HTMLButtonElement;
  private tool: SurfaceTool | null = null;
  private styles: Styles;
  private shown: ShownMark[] = [];
  /** Pointer down: the tool and its points (surface). */
  private cur: { tool: SurfaceTool; pts: Pt[] } | null = null;
  /** The open sketch. */
  private parts: SketchPart[] = [];
  /** Waiting for words: a mark's note, or a text part's words. */
  private held: { mark: Omit<Annotation, "id" | "screenId">; ref: Pt; at: Pt; required: boolean } | null = null;
  private typing: Pt | null = null;
  private queued = false;

  constructor(
    private root: HTMLElement | ShadowRoot,
    private host: SurfaceHost,
    styles: Styles,
    private cls = "ms",
  ) {
    this.styles = styles;
    const style = document.createElement("style");
    style.textContent = STYLE(cls);
    this.el = document.createElement("div");
    this.el.className = cls;
    this.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.pad = document.createElement("div");
    this.pad.className = `${cls}-pad`;
    this.pad.hidden = true;
    this.note = document.createElement("div");
    this.note.className = `${cls}-note`;
    this.note.hidden = true;
    this.input = document.createElement("input");
    this.input.type = "text";
    this.input.spellcheck = true;
    const add = document.createElement("button");
    add.type = "button";
    add.textContent = "Add";
    this.note.append(this.input, add);
    this.ready = document.createElement("button");
    this.ready.className = `${cls}-ready`;
    this.ready.hidden = true;
    this.ready.textContent = "Ready ⏎";
    this.el.append(style, this.svg, this.pad, this.note, this.ready);
    root.append(this.el);

    this.pad.addEventListener("pointerdown", (e) => this.down(e));
    this.pad.addEventListener("pointermove", (e) => this.move(e));
    this.pad.addEventListener("pointerup", (e) => this.up(e));
    this.pad.addEventListener("pointercancel", () => {
      this.cur = null;
      this.render();
    });
    this.pad.addEventListener("wheel", (e) => {
      e.preventDefault();
      if (!this.busy()) this.host.onWheel?.(e);
    }, { passive: false });
    this.input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && !e.isComposing) this.submit();
      else if (e.key === "Escape") this.dropWords();
    });
    this.input.addEventListener("blur", () => setTimeout(() => !this.note.hidden && this.submit(), 0));
    add.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.submit();
    });
    this.ready.addEventListener("click", () => this.finishSketch());
  }

  /** The tool (null: use the app) and the sketch tools' looks. A guide tool finishes an open sketch. */
  setTool(tool: SurfaceTool | null, styles?: Styles) {
    if (styles) this.styles = styles;
    if (tool === this.tool) return;
    if (this.typing) this.submit();
    if (this.parts.length && !isSketch(tool)) this.finishSketch();
    if (!tool) this.cancel();
    this.tool = tool;
    this.pad.hidden = !tool;
    this.render();
  }

  setShown(list: ShownMark[]) {
    this.shown = list;
    this.schedule();
  }

  /** Drawing, typing or with an open sketch: the surface should hold still. */
  busy(): boolean {
    return !!this.cur || !!this.held || !!this.typing || this.parts.length > 0;
  }

  cancel() {
    this.cur = null;
    this.parts = [];
    this.held = null;
    this.typing = null;
    this.note.hidden = true;
    this.ready.hidden = true;
    this.render();
  }

  /** Keys the page or pad gets while marking: ⏎ finishes the sketch, Escape drops what's in progress or stops. True when handled. */
  key(e: KeyboardEvent): boolean {
    if (!this.tool) return false;
    if (e.key === "Enter" && this.parts.length && !this.held && !this.typing) {
      this.finishSketch();
      return true;
    }
    if (e.key === "Escape") {
      if (this.parts.length && !this.held && !this.typing) this.finishSketch();
      else if (this.busy()) this.cancel();
      else this.host.onExit?.();
      return true;
    }
    return false;
  }

  destroy() {
    this.el.remove();
  }

  schedule() {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      this.render();
    });
  }

  /* ───────── pointer ───────── */

  private down(e: PointerEvent) {
    if (e.button !== 0 || !this.tool || this.held || this.typing) return;
    e.preventDefault();
    const p = this.host.toSurface(e.clientX, e.clientY);
    if (this.tool === "text") return this.askWords(p);
    if (this.tool === "fill") return this.fillAt(p);
    this.pad.setPointerCapture(e.pointerId);
    this.cur = { tool: this.tool, pts: [p] };
    this.render();
  }

  private move(e: PointerEvent) {
    if (!this.cur) return;
    const p = this.host.toSurface(e.clientX, e.clientY);
    if (this.cur.tool === "circle" || this.cur.tool === "freehand") this.cur.pts.push(p);
    else this.cur.pts = [this.cur.pts[0]!, p];
    this.schedule();
  }

  private up(e: PointerEvent) {
    if (!this.cur) return;
    const c = this.cur;
    this.cur = null;
    if (c.tool !== "circle" && c.tool !== "freehand") c.pts = [c.pts[0]!, this.host.toSurface(e.clientX, e.clientY)];
    this.finish(c.tool, c.pts);
    this.render();
  }

  /* ───────── marks ───────── */

  private finish(t: SurfaceTool, pts: Pt[]) {
    const a = pts[0]!, b = pts[pts.length - 1]!;
    const bb = bounds(pts);
    const big = Math.max(bb.w, bb.h) > 5;
    const r = (p: Pt): Pt => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10];
    if (t === "comment" || t === "remove") return this.askNote({ kind: t, geometry: { type: "point", x: r(b)[0], y: r(b)[1] } }, b, b, t === "comment");
    if (!big) return;
    switch (t) {
      case "circle":
        return this.askNote({ kind: "circle", geometry: { type: "path", points: pts.map(r) } }, [bb.x + bb.w / 2, bb.y + bb.h / 2], [bb.x + bb.w, bb.y + bb.h], false);
      case "arrow":
        return this.askNote({ kind: "arrow", geometry: { type: "arrow", from: r(a), to: r(b) } }, a, b, false);
      case "rectangle": {
        const box = bounds([a, b]);
        return this.askNote({ kind: "rectangle", geometry: { type: "rect", ...box } }, [box.x + box.w / 2, box.y + box.h / 2], [box.x + box.w, box.y + box.h], false);
      }
      case "freehand":
        return this.addPart({ type: "stroke", points: pts.map((p) => [r(p)[0], r(p)[1], 0.5] as [number, number, number]), style: this.styles.freehand });
      case "line":
        return this.addPart({ type: "line", from: r(a), to: r(b), style: this.styles.line });
      case "box":
      case "ellipse":
        return this.addPart({ type: t, ...bounds([a, b]), style: this.styles[t] });
    }
  }

  private addPart(p: SketchPart) {
    this.parts.push(p);
    this.placeReady();
  }

  private fillAt(p: Pt) {
    if (!this.parts.length) return this.host.say?.("sketch a closed shape first, then fill it");
    const b = sketchPartsBounds(this.parts);
    const pad = 16;
    const color = this.styles.fill.color;
    const res = paintBucket(this.parts, p, { bounds: { x: b.x - pad, y: b.y - pad, w: b.w + 2 * pad, h: b.h + 2 * pad }, closed: false, tol: 4, gap: 3 });
    if (res.kind === "none") return this.host.say?.("that area isn't closed: fill works inside a closed shape");
    if (res.kind === "recolor" || res.kind === "shape") {
      const q = this.parts[res.index]!;
      this.parts[res.index] = { ...q, style: res.kind === "shape" ? { ...q.style, fill: color } : { ...q.style, color } } as SketchPart;
    } else this.parts.push({ type: "fill", loops: res.loops, style: { color, width: 1 } });
    this.render();
  }

  /** The open sketch becomes one mark; then its note. */
  private finishSketch() {
    if (!this.parts.length) return;
    const parts = this.parts;
    this.parts = [];
    this.ready.hidden = true;
    const b = sketchPartsBounds(parts);
    this.askNote({ kind: "sketch", geometry: { type: "rect", ...b }, sketch: { shape: "drawing", style: parts[0]!.style, parts } }, [b.x + b.w / 2, b.y + b.h / 2], [b.x + b.w, b.y + b.h], false);
  }

  private askNote(mark: Omit<Annotation, "id" | "screenId">, ref: Pt, at: Pt, required: boolean) {
    this.held = { mark, ref, at, required };
    this.openInput(at, required ? "Type your note, then ⏎" : "Add a note (optional), then ⏎");
  }

  private askWords(at: Pt) {
    this.typing = at;
    this.openInput(at, "Type the text, then ⏎");
  }

  private openInput(at: Pt, placeholder: string) {
    this.input.value = "";
    this.input.placeholder = placeholder;
    const [x, y] = this.client(at);
    const w = this.el.clientWidth || 800, h = this.el.clientHeight || 600;
    this.note.style.left = `${Math.max(8, Math.min(w - 310, x + 14))}px`;
    this.note.style.top = `${Math.max(8, Math.min(h - 50, y + 12))}px`;
    this.note.hidden = false;
    this.render();
    // focused now, so a quick ⏎ isn't lost, and again once the click that opened it is over
    this.input.focus();
    setTimeout(() => this.input.focus(), 0);
  }

  private submit() {
    const words = this.input.value.trim();
    this.note.hidden = true;
    if (this.typing) {
      const at = this.typing;
      this.typing = null;
      if (words) {
        const style = this.styles.text;
        const box = estimateTextBox(words, style.size ?? 24);
        this.addPart({ type: "text", x: at[0], y: at[1], ...box, text: words, style });
      }
      return this.render();
    }
    const h = this.held;
    this.held = null;
    if (!h || (h.required && !words)) return this.render();
    this.host.onMark({ annotation: { ...h.mark, ...(words ? { text: words } : {}) }, ref: h.ref });
    this.render();
  }

  private dropWords() {
    this.note.hidden = true;
    this.held = null;
    this.typing = null;
    this.render();
  }

  private placeReady() {
    if (!this.parts.length) return void (this.ready.hidden = true);
    const b = sketchPartsBounds(this.parts);
    const [x, y] = this.client([b.x + b.w, b.y + b.h]);
    const w = this.el.clientWidth || 800, h = this.el.clientHeight || 600;
    this.ready.style.left = `${Math.max(8, Math.min(w - 100, x + 8))}px`;
    this.ready.style.top = `${Math.max(8, Math.min(h - 40, y + 8))}px`;
    this.ready.hidden = false;
  }

  /* ───────── drawing ───────── */

  private client(p: Pt): Pt {
    const o = this.host.origin();
    return [p[0] + o[0], p[1] + o[1]];
  }

  render() {
    const [ox, oy] = this.host.origin();
    const at = (d: Pt | undefined) => `translate(${(ox + (d?.[0] ?? 0)).toFixed(1)} ${(oy + (d?.[1] ?? 0)).toFixed(1)})`;
    let out = "";
    for (const s of this.shown)
      out += `<g transform="${at(s.offset)}"${s.faint ? ` class="${this.cls}-faint"` : ""}>${renderAnnotationSvg(s.annotation, { unit: 1, ...(s.label ? { label: s.label } : {}) })}</g>`;
    const next = String(this.shown.length + 1);
    const g = (svg: string, faint = false) => `<g transform="${at(undefined)}"${faint ? ` class="${this.cls}-faint"` : ""}>${svg}</g>`;
    if (this.parts.length) out += g(renderSketchPartsSvg(this.parts));
    if (this.held) out += g(renderAnnotationSvg({ id: "held", screenId: "", ...this.held.mark }, { unit: 1, label: next }), true);
    const c = this.cur;
    if (c) {
      const a = c.pts[0]!, b = c.pts[c.pts.length - 1]!;
      const temp = (m: Omit<Annotation, "id" | "screenId">) => g(renderAnnotationSvg({ id: "cur", screenId: "", ...m }, { unit: 1 }), true);
      switch (c.tool) {
        case "circle":
          out += temp({ kind: "circle", geometry: { type: "path", points: c.pts } });
          break;
        case "arrow":
          out += temp({ kind: "arrow", geometry: { type: "arrow", from: a, to: b } });
          break;
        case "rectangle":
          out += temp({ kind: "rectangle", geometry: { type: "rect", ...bounds([a, b]) } });
          break;
        case "freehand":
          out += g(renderSketchPartsSvg([{ type: "stroke", points: c.pts.map((p) => [p[0], p[1], 0.5]), style: this.styles.freehand }]));
          break;
        case "line":
          out += g(renderSketchPartsSvg([{ type: "line", from: a, to: b, style: this.styles.line }]));
          break;
        case "box":
        case "ellipse":
          out += g(renderSketchPartsSvg([{ type: c.tool, ...bounds([a, b]), style: this.styles[c.tool] }]));
          break;
      }
    }
    this.svg.innerHTML = out;
    if (this.parts.length) this.placeReady();
  }
}

function bounds(pts: Pt[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return { x: Math.round(x0 * 10) / 10, y: Math.round(y0 * 10) / 10, w: Math.round((x1 - x0) * 10) / 10, h: Math.round((y1 - y0) * 10) / 10 };
}
