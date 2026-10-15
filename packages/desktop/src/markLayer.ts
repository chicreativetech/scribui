import { ipcRenderer } from "electron";
import type { Annotation } from "@scribui/core";
import { MarkSurface, type ShownMark, type Styles, type SurfaceMark, type SurfaceTool } from "../../canvas/src/markSurface";

/**
 * Preload of the app tab's view (web projects): marking up the live page with
 * Review's tools.
 *
 * Runs in its own isolated world, so the reviewed app can't reach it, and adds
 * one element to the page, `<scribui-marks>`, with a closed shadow root holding
 * a MarkSurface (canvas markSurface.ts) over the window. While a tool is on, the
 * surface takes the pointer; the page keeps scrolling under it (the wheel is
 * passed on) except while a mark is drawn, a sketch is open or a note typed.
 *
 * Surface coordinates are page coordinates: CSS pixels from the page's top-left
 * corner. A finished mark goes to the canvas with the element it was made on
 * (`anchor`) and the page's signature; the canvas captures the page when needed
 * and makes it a note. The canvas sends back the notes on this page, drawn where
 * their element is now: they follow it as the page scrolls or shifts, and come
 * back when the page is opened again. Screenshots hide the element (webCapture.ts).
 * A shown note opens when clicked (or picked in the canvas's notes list), to
 * change its words or delete it: the canvas makes the change.
 */

type Anchor = { selector: string; x: number; y: number };
/** A note on this page, from the canvas, in page coordinates. */
type LayerMark = { annotation: Annotation; label?: string; anchor?: Anchor };
type Draft = { tempId: string; annotation: SurfaceMark["annotation"]; anchor?: Anchor; signature: string; url: string };

const TOOLS = new Set<SurfaceTool>(["comment", "circle", "arrow", "rectangle", "remove", "freehand", "line", "box", "ellipse", "text", "fill"]);
const INK = { color: "#262626", width: 3 };
let styles: Styles = { freehand: { ...INK, width: 4 }, line: INK, box: INK, ellipse: INK, text: { color: "#262626", width: 1, size: 32 }, fill: { color: "#3E63DD", width: 1 } };

let tool: SurfaceTool | null = null;
let marks: LayerMark[] = [];
/** Sent to the canvas, shown until they come back as notes. */
let pending: (Draft & { label: string })[] = [];
let host: HTMLElement | null = null;
let surface: MarkSurface | null = null;
let chip: HTMLButtonElement | null = null;
/** The note the canvas last said is selected: only a change opens or closes one here. */
let canvasSelected: string | null = null;

/* ─────────────────────────── page coordinates ─────────────────────────── */

const anchors = new Map<string, Element | null>();
/** Where an anchored note's element is now, relative to where it was: null when it isn't on the page. */
function shift(a: Anchor | undefined): [number, number] | null {
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

/** What's under a point of the window, the layer let through. */
function under(x: number, y: number): Element | null {
  if (!host) return null;
  host.style.setProperty("visibility", "hidden", "important");
  const el = document.elementFromPoint(x, y);
  host.style.removeProperty("visibility");
  return el;
}

/** The page element under a page point. */
function anchorAt(p: [number, number]): Anchor | undefined {
  const el = under(p[0] - window.scrollX, p[1] - window.scrollY);
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

/** Wheel over the surface: scroll what's under it, as if the surface weren't there. */
function passWheel(e: WheelEvent) {
  let el = under(e.clientX, e.clientY);
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

let seq = 0;

function show() {
  if (!surface) return;
  let missing = 0;
  const list: ShownMark[] = [];
  for (const m of marks) {
    const d = shift(m.anchor);
    if (!d) {
      missing++;
      continue;
    }
    list.push({ annotation: m.annotation, ...(m.label ? { label: m.label } : {}), offset: d, editable: true });
  }
  for (const p of pending) list.push({ annotation: { id: p.tempId, screenId: "", ...p.annotation }, label: p.label, faint: true });
  surface.setShown(list);
  if (chip) {
    chip.hidden = missing === 0;
    chip.textContent = `${missing} note${missing === 1 ? "" : "s"} not found on this page now · open Review`;
  }
}

function mount() {
  if (host?.isConnected) return;
  if (!host) {
    host = document.createElement("scribui-marks");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "position: fixed !important; inset: 0 !important; z-index: 2147483647 !important; pointer-events: none !important; display: block !important;";
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `:host { all: initial; }
.chip { position: fixed; left: 12px; bottom: 12px; border: 1px solid #262626; background: #fff; color: #262626; padding: 7px 10px;
  pointer-events: auto; font: 600 12px/1 -apple-system, "Helvetica Neue", Arial, sans-serif; cursor: pointer; }
.chip.dark { border-color: #47474f; background: #232327; color: #f3f3f3; }
.chip[hidden] { display: none; }`;
    root.append(style);
    surface = new MarkSurface(
      root,
      {
        toSurface: (x, y) => [x + window.scrollX, y + window.scrollY],
        origin: () => [-window.scrollX, -window.scrollY],
        onWheel: passWheel,
        onExit: () => ipcRenderer.send("scribui-mark:exit"),
        onSelect: (id) => {
          canvasSelected = id;
          ipcRenderer.send("scribui-mark:select", id);
        },
        onEdit: (id, text) => ipcRenderer.send("scribui-mark:edit", { id, text }),
        onDelete: (id) => ipcRenderer.send("scribui-mark:delete", id),
        reveal: ([x, y]) => {
          const top = y - window.scrollY, left = x - window.scrollX;
          if (top < 40 || top > window.innerHeight - 160 || left < 0 || left > window.innerWidth - 40)
            window.scrollTo({ left: Math.max(0, x - window.innerWidth / 3), top: Math.max(0, y - window.innerHeight / 3) });
        },
        onMark: (m) => {
          const draft: Draft = { tempId: `t${Date.now().toString(36)}${seq++}`, annotation: m.annotation, signature: signature(), url: location.href };
          const anchor = anchorAt(m.ref);
          if (anchor) draft.anchor = anchor;
          pending.push({ ...draft, label: String(marks.length + pending.length + 1) });
          ipcRenderer.send("scribui-mark:add", draft);
          show();
        },
      },
      styles,
      "sm",
    );
    chip = document.createElement("button");
    chip.className = "chip";
    chip.hidden = true;
    chip.addEventListener("click", () => ipcRenderer.send("scribui-mark:review"));
    root.append(chip);
  }
  document.documentElement.appendChild(host);
  show();
}

ipcRenderer.on("scribui-mark:mode", (_e, m: { tool?: unknown; styles?: unknown; theme?: unknown } | null) => {
  if (m?.styles && typeof m.styles === "object") styles = m.styles as Styles;
  tool = typeof m?.tool === "string" && TOOLS.has(m.tool as SurfaceTool) ? (m.tool as SurfaceTool) : null;
  mount();
  if (m?.theme === "dark" || m?.theme === "light") {
    surface?.setTheme(m.theme);
    chip?.classList.toggle("dark", m.theme === "dark");
  }
  surface?.setTool(tool, styles);
});

ipcRenderer.on("scribui-mark:marks", (_e, m: { url?: unknown; marks?: unknown; confirmed?: unknown; selected?: unknown } | null) => {
  // notes for another page (sent just before a navigation) are dropped
  if (typeof m?.url === "string" && m.url !== location.href.split("#")[0]) return;
  marks = Array.isArray(m?.marks) ? (m.marks as LayerMark[]) : [];
  const confirmed = new Set(Array.isArray(m?.confirmed) ? (m.confirmed as string[]) : []);
  pending = pending.filter((p) => !confirmed.has(p.tempId));
  anchors.clear();
  mount();
  show();
  const sel = typeof m?.selected === "string" ? m.selected : null;
  if (sel !== canvasSelected) {
    canvasSelected = sel;
    surface?.select(sel);
  }
});

window.addEventListener(
  "keydown",
  (e) => {
    if (surface?.key(e)) {
      e.preventDefault();
      e.stopPropagation();
    }
  },
  true,
);
window.addEventListener("scroll", () => surface?.schedule(), { capture: true, passive: true });
window.addEventListener("resize", () => surface?.schedule());
// content that loads or moves later: look for the notes' elements again now and then
setInterval(() => {
  // an app that rewrites the whole document takes the layer with it: put it back
  if (host && !host.isConnected && document.documentElement) mount();
  if (!marks.length) return;
  anchors.clear();
  show();
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
  surface?.cancel();
  marks = [];
  pending = [];
  show();
  ipcRenderer.send("scribui-mark:ready", location.href);
}, 300);
