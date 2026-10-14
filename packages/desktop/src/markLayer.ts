import { ipcRenderer } from "electron";

/**
 * Preload of the app tab's view (web projects): marking up the live page.
 *
 * Runs in its own isolated world, so the reviewed app can't reach it, and adds
 * one element to the page, `<scribui-marks>`, with a closed shadow root: an SVG
 * of the marks over the page, and while a mark tool is on, a pad that takes the
 * pointer. The page keeps scrolling under the pad (the wheel is passed on) except
 * while a mark is being drawn or its note typed.
 *
 * A finished mark goes to the canvas in page coordinates (CSS pixels from the
 * page's top-left corner), with the element it was made on (`anchor`); the canvas
 * captures the page when needed and makes the mark a note. The canvas sends back
 * the notes on this page, which are drawn where their element is now: they follow
 * it as the page scrolls or shifts, and come back when the page is opened again.
 * Screenshots hide the element (webCapture.ts).
 */

type Pt = [number, number];
type Geometry =
  | { type: "point"; x: number; y: number }
  | { type: "path"; points: Pt[] }
  | { type: "rect"; x: number; y: number; w: number; h: number }
  | { type: "arrow"; from: Pt; to: Pt };
type Tool = "comment" | "circle" | "arrow" | "rectangle" | "remove" | "draw";
type Kind = "comment" | "circle" | "arrow" | "rectangle" | "remove" | "sketch";
type Anchor = { selector: string; x: number; y: number };
type Stroke = { points: Pt[]; color: string; width: number };
/** A note on this page, from the canvas, in page coordinates. */
type LayerMark = { id: string; n: number; kind: Kind; geometry: Geometry; text?: string; anchor?: Anchor; strokes?: Stroke[] };
type Draft = { tempId: string; kind: Kind; geometry: Geometry; text: string; anchor?: Anchor; strokes?: Stroke[]; signature: string; url: string };

const MARK = "#ff5a36";
const INK = "#262626";

let tool: Tool | null = null;
let drawStyle = { color: INK, width: 4 };
let marks: LayerMark[] = [];
/** Sent to the canvas, shown until it comes back as a note. */
let pending: (Draft & { n: number })[] = [];
/** The mark being drawn (pointer down), and the one waiting for its note. */
let cur: { tool: Tool; points: Pt[] } | null = null;
let held: { kind: Kind; geometry: Geometry; strokes?: Stroke[]; ref: Pt } | null = null;
/** Draw tool: strokes so far, until Done. */
let strokes: Stroke[] = [];

let host: HTMLElement | null = null;
let svg: SVGSVGElement | null = null;
let pad: HTMLDivElement | null = null;
let note: HTMLDivElement | null = null;
let chip: HTMLDivElement | null = null;
let done: HTMLButtonElement | null = null;

/* ─────────────────────────── page coordinates ─────────────────────────── */

const scroll = (): Pt => [window.scrollX, window.scrollY];
const toPage = (x: number, y: number): Pt => [x + window.scrollX, y + window.scrollY];

const anchors = new Map<string, Element | null>();
/** Where an anchored mark's element is now, relative to where it was: null when it isn't on the page. */
function shift(a: Anchor | undefined): Pt | null {
  if (!a) return [0, 0];
  let el = anchors.get(a.selector);
  if (el === undefined || (el && !el.isConnected)) {
    try {
      el = document.querySelector(a.selector);
    } catch {
      el = null;
    }
    anchors.set(a.selector, el);
  }
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height) return null;
  return [r.left + window.scrollX - a.x, r.top + window.scrollY - a.y];
}

function cssPath(el: Element): string {
  const parts: string[] = [];
  for (let e: Element | null = el; e && e !== document.documentElement; e = e.parentElement) {
    for (const attr of ["data-testid", "data-test-id", "data-test"]) {
      const v = e.getAttribute(attr);
      if (v) {
        parts.unshift(`[${attr}="${CSS.escape(v)}"]`);
        return parts.join(" > ");
      }
    }
    if (e.id && document.querySelectorAll(`#${CSS.escape(e.id)}`).length === 1) {
      parts.unshift(`#${CSS.escape(e.id)}`);
      return parts.join(" > ");
    }
    const tag = e.tagName.toLowerCase();
    const parent: Element | null = e.parentElement;
    const same = parent ? Array.from(parent.children).filter((c) => c.tagName === e!.tagName) : [];
    parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(e) + 1})` : tag);
  }
  return parts.join(" > ");
}

/** The page element under a point of the window (the layer itself let through). */
function anchorAt(x: number, y: number): Anchor | undefined {
  if (!host) return undefined;
  host.style.setProperty("pointer-events", "none", "important");
  if (pad) pad.style.pointerEvents = "none";
  const el = document.elementFromPoint(x, y);
  if (pad) pad.style.pointerEvents = "";
  host.style.removeProperty("pointer-events");
  if (!el || el === host || el === document.documentElement || el === document.body) return undefined;
  const r = el.getBoundingClientRect();
  return { selector: cssPath(el), x: r.left + window.scrollX, y: r.top + window.scrollY };
}

/** The page's size and content: unchanged, a new mark joins the screen already captured. */
function signature(): string {
  const d = document.documentElement;
  const n = document.getElementsByTagName("*").length - (host ? 1 : 0);
  const text = (document.body?.innerText ?? "").length;
  return `${d.scrollWidth}x${d.scrollHeight}:${n}:${text}`;
}

/* ─────────────────────────── drawing ─────────────────────────── */

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const move = (p: Pt, d: Pt): Pt => [p[0] + d[0], p[1] + d[1]];
const bbox = (pts: Pt[]) => {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
};
const poly = (pts: Pt[]) => pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");

function badge(p: Pt, n: number | string, faint = false): string {
  return `<g class="badge${faint ? " faint" : ""}" transform="translate(${p[0].toFixed(1)},${p[1].toFixed(1)})"><circle r="10"/><text dy="3.6">${esc(String(n))}</text></g>`;
}

function label(p: Pt, text: string | undefined): string {
  if (!text) return "";
  const t = text.length > 60 ? `${text.slice(0, 59)}…` : text;
  return `<foreignObject x="${(p[0] + 14).toFixed(1)}" y="${(p[1] - 11).toFixed(1)}" width="260" height="60"><div xmlns="http://www.w3.org/1999/xhtml" class="label">${esc(t)}</div></foreignObject>`;
}

/** One mark in window coordinates: `g` is its geometry moved by `d` (anchor shift minus scroll). */
function shape(kind: Kind, g: Geometry, d: Pt, n: number | string, text: string | undefined, sk: Stroke[] | undefined, faint = false): string {
  const cls = faint ? ' class="faint"' : "";
  switch (g.type) {
    case "point": {
      const p = move([g.x, g.y], d);
      if (kind === "remove") {
        const s = 9;
        return `<g${cls}><path class="strike" d="M${p[0] - s},${p[1] - s}L${p[0] + s},${p[1] + s}M${p[0] + s},${p[1] - s}L${p[0] - s},${p[1] + s}"/></g>${badge([p[0] + 16, p[1] - 14], n, faint)}${label([p[0] + 16, p[1] - 14], text)}`;
      }
      return `${badge(p, n, faint)}${label(p, text)}`;
    }
    case "path": {
      const pts = g.points.map((p) => move(p, d));
      if (kind === "sketch" && sk?.length) {
        const lines = sk.map((s) => `<polyline class="ink" stroke="${esc(s.color)}" stroke-width="${s.width}" points="${poly(s.points.map((p) => move(p, d)))}"/>`).join("");
        const b = bbox(sk.flatMap((s) => s.points).map((p) => move(p, d)));
        return `<g${cls}>${lines}</g>${badge([b.x, b.y], n, faint)}${label([b.x, b.y], text)}`;
      }
      const b = bbox(pts);
      return `<g${cls}><polyline class="loop" points="${poly(pts)}"/></g>${badge([b.x, b.y], n, faint)}${label([b.x, b.y], text)}`;
    }
    case "rect": {
      const [x, y] = move([g.x, g.y], d);
      if (kind === "sketch" && sk?.length) return shape(kind, { type: "path", points: [] }, d, n, text, sk, faint);
      return `<g${cls}><rect class="box" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${g.w.toFixed(1)}" height="${g.h.toFixed(1)}"/></g>${badge([x, y], n, faint)}${label([x, y], text)}`;
    }
    case "arrow": {
      const a = move(g.from, d), b = move(g.to, d);
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const h = (s: number) => `${(b[0] - 12 * Math.cos(ang + s)).toFixed(1)},${(b[1] - 12 * Math.sin(ang + s)).toFixed(1)}`;
      return `<g${cls}><line class="arrow" x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}"/><polyline class="arrow" points="${h(0.45)} ${b[0]},${b[1]} ${h(-0.45)}"/></g>${badge(a, n, faint)}${label(a, text)}`;
    }
  }
}

function render() {
  if (!svg) return;
  const s = scroll();
  let out = "";
  let missing = 0;
  for (const m of marks) {
    const sh = shift(m.anchor);
    if (!sh) {
      missing++;
      continue;
    }
    out += shape(m.kind, m.geometry, [sh[0] - s[0], sh[1] - s[1]], m.n, m.text, m.strokes);
  }
  for (const p of pending) out += shape(p.kind, p.geometry, [-s[0], -s[1]], p.n, p.text, p.strokes, true);
  // in progress, in window coordinates already
  const next = marks.length + pending.length + 1;
  if (held) out += shape(held.kind, held.geometry, [-s[0], -s[1]], next, undefined, held.strokes, true);
  if (strokes.length) out += strokes.map((k) => `<polyline class="ink" stroke="${esc(k.color)}" stroke-width="${k.width}" points="${poly(k.points.map((p) => move(p, [-s[0], -s[1]])))}"/>`).join("");
  if (cur) {
    const pts = cur.points.map((p) => move(p, [-s[0], -s[1]]));
    const a = pts[0]!, b = pts[pts.length - 1]!;
    if (cur.tool === "circle") out += `<polyline class="loop" points="${poly(pts)}"/>`;
    else if (cur.tool === "draw") out += `<polyline class="ink" stroke="${esc(drawStyle.color)}" stroke-width="${drawStyle.width}" points="${poly(pts)}"/>`;
    else if (cur.tool === "rectangle") {
      const r = bbox([a, b]);
      out += `<rect class="box" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}"/>`;
    } else if (cur.tool === "arrow") out += `<line class="arrow" x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}"/>`;
  }
  svg.innerHTML = out;
  if (chip) {
    chip.hidden = missing === 0;
    chip.textContent = `${missing} note${missing === 1 ? "" : "s"} not found on this page now · open Review`;
  }
}

let queued = false;
function schedule() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    render();
  });
}

/* ─────────────────────────── marking ─────────────────────────── */

let seq = 0;

function openNote(ref: Pt, required: boolean) {
  if (!note) return;
  const input = note.querySelector("input")!;
  input.value = "";
  input.placeholder = required ? "Type your note, then ⏎" : "Add a note (optional), then ⏎";
  const s = scroll();
  const x = Math.min(window.innerWidth - 300, Math.max(8, ref[0] - s[0] + 16));
  const y = Math.min(window.innerHeight - 50, Math.max(8, ref[1] - s[1] + 14));
  note.style.left = `${x}px`;
  note.style.top = `${y}px`;
  note.hidden = false;
  note.dataset.required = required ? "1" : "";
  setTimeout(() => input.focus(), 0);
}

function closeNote() {
  if (note) note.hidden = true;
  held = null;
  schedule();
}

function commit() {
  if (!held || !note) return;
  const text = note.querySelector("input")!.value.trim();
  if (held.kind === "comment" && !text) return closeNote();
  const s = scroll();
  const draft: Draft = {
    tempId: `t${Date.now().toString(36)}${seq++}`,
    kind: held.kind,
    geometry: held.geometry,
    text,
    ...(held.strokes ? { strokes: held.strokes } : {}),
    signature: signature(),
    url: location.href,
  };
  const anchor = anchorAt(held.ref[0] - s[0], held.ref[1] - s[1]);
  if (anchor) draft.anchor = anchor;
  pending.push({ ...draft, n: marks.length + pending.length + 1 });
  ipcRenderer.send("scribui-mark:add", draft);
  closeNote();
}

/** Finish what the pointer drew (page coordinates). */
function finish(t: Tool, pts: Pt[]) {
  const a = pts[0]!, b = pts[pts.length - 1]!;
  const b0 = bbox(pts);
  const big = Math.max(b0.w, b0.h) > 6;
  if (t === "comment" || t === "remove") {
    held = { kind: t, geometry: { type: "point", x: Math.round(b[0]), y: Math.round(b[1]) }, ref: b };
    return openNote(b, t === "comment");
  }
  if (!big) return;
  if (t === "circle") {
    held = { kind: "circle", geometry: { type: "path", points: pts.map((p) => [Math.round(p[0]), Math.round(p[1])]) }, ref: [b0.x + b0.w / 2, b0.y + b0.h / 2] };
    return openNote(held.ref, false);
  }
  if (t === "arrow") {
    held = { kind: "arrow", geometry: { type: "arrow", from: a, to: b }, ref: a };
    return openNote(b, false);
  }
  if (t === "rectangle") {
    const r = bbox([a, b]);
    held = { kind: "rectangle", geometry: { type: "rect", ...r }, ref: [r.x + r.w / 2, r.y + r.h / 2] };
    return openNote([r.x + r.w, r.y + r.h], false);
  }
  if (t === "draw") {
    strokes.push({ points: pts, color: drawStyle.color, width: drawStyle.width });
    if (done) {
      const s = scroll();
      done.style.left = `${Math.min(window.innerWidth - 120, b[0] - s[0] + 12)}px`;
      done.style.top = `${Math.min(window.innerHeight - 40, b[1] - s[1] + 12)}px`;
      done.hidden = false;
    }
  }
}

/** The draw tool's strokes become one sketch, then its note. */
function finishDrawing() {
  if (!strokes.length) return;
  const all = strokes.flatMap((s) => s.points);
  const b = bbox(all);
  held = { kind: "sketch", geometry: { type: "rect", ...b }, strokes, ref: [b.x + b.w / 2, b.y + b.h / 2] };
  strokes = [];
  if (done) done.hidden = true;
  openNote([b.x + b.w, b.y + b.h], false);
}

function cancelAll() {
  cur = null;
  strokes = [];
  if (done) done.hidden = true;
  closeNote();
}

/** Busy with a mark: the page holds still. */
const busy = () => !!cur || !!held || strokes.length > 0;

/** Wheel over the pad: scroll what's under it, as if the pad weren't there. */
function passWheel(e: WheelEvent) {
  e.preventDefault();
  if (busy()) return;
  if (!pad || !host) return;
  pad.style.pointerEvents = "none";
  host.style.setProperty("pointer-events", "none", "important");
  let el = document.elementFromPoint(e.clientX, e.clientY);
  pad.style.pointerEvents = "";
  host.style.removeProperty("pointer-events");
  const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1;
  const dx = e.deltaX * k, dy = e.deltaY * k;
  for (; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
    const cs = getComputedStyle(el);
    const canY = /(auto|scroll|overlay)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1;
    const canX = /(auto|scroll|overlay)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1;
    if ((dy && canY) || (dx && canX)) {
      el.scrollBy({ left: dx, top: dy });
      return;
    }
  }
  window.scrollBy({ left: dx, top: dy });
}

/* ─────────────────────────── the layer ─────────────────────────── */

const CSS_TEXT = `
:host { all: initial; }
svg { position: fixed; inset: 0; width: 100vw; height: 100vh; overflow: visible; pointer-events: none; }
.loop, .box, .arrow, .strike { fill: none; stroke: ${MARK}; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; }
.box { stroke-dasharray: 7 5; }
.ink { fill: none; stroke-linecap: round; stroke-linejoin: round; }
.badge circle { fill: ${MARK}; stroke: #fff; stroke-width: 2; }
.badge text { fill: #fff; font: 700 11px/1 -apple-system, "Helvetica Neue", Arial, sans-serif; text-anchor: middle; }
.faint { opacity: 0.6; }
.label { display: inline-block; max-width: 240px; padding: 3px 7px; background: #fff; color: #262626; border: 1px solid #d0d0d0;
  font: 500 11.5px/1.35 -apple-system, "Helvetica Neue", Arial, sans-serif; box-shadow: 0 2px 8px rgba(0,0,0,.12); white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; }
.pad { position: fixed; inset: 0; cursor: crosshair; pointer-events: auto; touch-action: none; }
.pad[hidden] { display: none; }
.note { position: fixed; display: flex; gap: 6px; padding: 6px; background: #fff; border: 1px solid #262626; box-shadow: 0 6px 20px rgba(0,0,0,.18); pointer-events: auto; }
.note[hidden], .done[hidden], .chip[hidden] { display: none; }
.note input { width: 240px; border: 1px solid #d0d0d0; padding: 5px 7px; font: 400 12.5px -apple-system, "Helvetica Neue", Arial, sans-serif; color: #262626; outline: none; background: #fff; }
.note input:focus { border-color: #262626; }
.note button, .done, .chip { font: 600 12px/1 -apple-system, "Helvetica Neue", Arial, sans-serif; cursor: pointer; }
.note button { border: 1px solid #262626; background: #ff9f0a; color: #262626; padding: 0 10px; }
.done { position: fixed; border: 1px solid #262626; background: #ff9f0a; color: #262626; padding: 7px 10px; pointer-events: auto; }
.chip { position: fixed; left: 12px; bottom: 12px; border: 1px solid #262626; background: #fff; color: #262626; padding: 7px 10px; pointer-events: auto; }
`;

function mount() {
  if (host?.isConnected) return;
  if (!host) {
    host = document.createElement("scribui-marks");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "position: fixed !important; inset: 0 !important; z-index: 2147483647 !important; pointer-events: none !important; display: block !important;";
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = CSS_TEXT;
    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    pad = document.createElement("div");
    pad.className = "pad";
    pad.hidden = true;
    note = document.createElement("div");
    note.className = "note";
    note.hidden = true;
    note.innerHTML = `<input type="text" spellcheck="true"><button type="button">Add</button>`;
    done = document.createElement("button");
    done.className = "done";
    done.hidden = true;
    done.textContent = "Done ⏎";
    chip = document.createElement("div");
    chip.className = "chip";
    chip.hidden = true;
    root.append(style, svg, pad, note, done, chip);

    pad.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !tool || held) return;
      e.preventDefault();
      pad!.setPointerCapture(e.pointerId);
      cur = { tool, points: [toPage(e.clientX, e.clientY)] };
      schedule();
    });
    pad.addEventListener("pointermove", (e) => {
      if (!cur) return;
      const p = toPage(e.clientX, e.clientY);
      if (cur.tool === "circle" || cur.tool === "draw") cur.points.push(p);
      else cur.points = [cur.points[0]!, p];
      schedule();
    });
    const up = (e: PointerEvent) => {
      if (!cur) return;
      const c = cur;
      cur = null;
      if (c.tool !== "circle" && c.tool !== "draw") c.points = [c.points[0]!, toPage(e.clientX, e.clientY)];
      finish(c.tool, c.points);
      schedule();
    };
    pad.addEventListener("pointerup", up);
    pad.addEventListener("pointercancel", () => {
      cur = null;
      schedule();
    });
    pad.addEventListener("wheel", passWheel, { passive: false });
    const input = note.querySelector("input")!;
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && !e.isComposing) commit();
      else if (e.key === "Escape") closeNote();
    });
    input.addEventListener("blur", () => setTimeout(() => !note!.hidden && commit(), 0));
    note.querySelector("button")!.addEventListener("mousedown", (e) => {
      e.preventDefault();
      commit();
    });
    done.addEventListener("click", finishDrawing);
    chip.addEventListener("click", () => ipcRenderer.send("scribui-mark:review"));
  }
  document.documentElement.appendChild(host);
  schedule();
}

function setTool(t: Tool | null, style?: { color: string; width: number }) {
  if (t !== tool) cancelAll();
  tool = t;
  if (style) drawStyle = style;
  mount();
  if (pad) pad.hidden = !tool;
}

const TOOLS = new Set<Tool>(["comment", "circle", "arrow", "rectangle", "remove", "draw"]);

ipcRenderer.on("scribui-mark:mode", (_e, m: { tool?: unknown; style?: { color?: unknown; width?: unknown } } | null) => {
  const t = typeof m?.tool === "string" && TOOLS.has(m.tool as Tool) ? (m.tool as Tool) : null;
  const c = m?.style?.color, w = m?.style?.width;
  setTool(t, typeof c === "string" && typeof w === "number" ? { color: c, width: w } : undefined);
});

ipcRenderer.on("scribui-mark:marks", (_e, m: { url?: unknown; marks?: unknown; confirmed?: unknown } | null) => {
  // notes for another page (sent just before a navigation) are dropped
  if (typeof m?.url === "string" && m.url !== location.href.split("#")[0]) return;
  marks = Array.isArray(m?.marks) ? (m.marks as LayerMark[]) : [];
  const confirmed = new Set(Array.isArray(m?.confirmed) ? (m.confirmed as string[]) : []);
  pending = pending.filter((p) => !confirmed.has(p.tempId));
  anchors.clear();
  mount();
  schedule();
});

window.addEventListener(
  "keydown",
  (e) => {
    if (!tool) return;
    if (e.key === "Escape") {
      if (busy()) cancelAll();
      else ipcRenderer.send("scribui-mark:exit");
      e.preventDefault();
    } else if (e.key === "Enter" && strokes.length && !held) {
      e.preventDefault();
      finishDrawing();
    }
  },
  true,
);
window.addEventListener("scroll", schedule, { capture: true, passive: true });
window.addEventListener("resize", schedule);
// content that loads or moves later: look for the marks' elements again now and then
setInterval(() => {
  // an app that rewrites the whole document takes the layer with it: put it back
  if (host && !host.isConnected && document.documentElement) mount();
  if (!marks.length) return;
  anchors.clear();
  schedule();
}, 800);

const start = () => {
  mount();
  ipcRenderer.send("scribui-mark:ready", location.href);
};
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
else start();
// single-page apps change the address without a load
let lastUrl = location.href;
setInterval(() => {
  if (location.href === lastUrl) return;
  lastUrl = location.href;
  cancelAll();
  marks = [];
  pending = [];
  ipcRenderer.send("scribui-mark:ready", location.href);
  schedule();
}, 300);
