import { WebContentsView, type BrowserWindow } from "electron";
import type { Rect } from "./liveLayout.js";

/**
 * The round buttons in the Capture Screens tab's bottom-right corner (Tablet,
 * Panel and Pen mode above Capture view; the canvas's FloatStack.tsx). The
 * app's own view covers the canvas there, so they're a small transparent view
 * of their own, stacked above the app's and the intro card's. The canvas sends
 * them as data (labels, icon paths, states), which the page puts in as text
 * and SVG paths; it has no preload, and a press shows up as a title change,
 * which LiveView passes to the canvas. Captures read the app's view only, so
 * the buttons are never in a screenshot.
 */

export type StackIcon = { box: number; paths: string[] };
export type StackButton = { id: string; label: string; icon: StackIcon; title: string; on: boolean; disabled: boolean; busy: boolean };
export type Stack = { toggles: StackButton[]; main: StackButton | null; theme: "light" | "dark" };

/** The sizes, in canvas CSS pixels: the main button, the smaller ones, the gap between them and to the corner. */
export const MAIN = 84;
export const SMALL = 68;
export const GAP = 10;
export const INSET = 14;
const PAD = 6;

/** The view's size for a stack (CSS px): room for the buttons and their shadows. */
export function stackSize(s: Stack): { width: number; height: number } {
  return { width: MAIN + 2 * PAD, height: 2 * PAD + s.toggles.length * (SMALL + GAP) + (s.main ? MAIN : -GAP) };
}

const ID = /^[a-z][a-z0-9-]{0,30}$/;
const PATH = /^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]{1,4000}$/;

function readButton(v: unknown): StackButton | null {
  if (!v || typeof v !== "object") return null;
  const b = v as Record<string, unknown>;
  const icon = b.icon as Record<string, unknown> | undefined;
  if (typeof b.id !== "string" || !ID.test(b.id) || typeof b.label !== "string" || b.label.length > 40) return null;
  if (!icon || typeof icon.box !== "number" || !(icon.box > 0 && icon.box <= 64) || !Array.isArray(icon.paths) || icon.paths.length > 8) return null;
  if (!icon.paths.every((d) => typeof d === "string" && PATH.test(d))) return null;
  return {
    id: b.id,
    label: b.label,
    icon: { box: icon.box, paths: icon.paths as string[] },
    title: typeof b.title === "string" ? b.title.slice(0, 200) : "",
    on: b.on === true,
    disabled: b.disabled === true,
    busy: b.busy === true,
  };
}

/** A stack from the canvas, checked; null when it isn't one. */
export function readStack(v: unknown): Stack | null {
  if (!v || typeof v !== "object") return null;
  const s = v as Record<string, unknown>;
  if (!Array.isArray(s.toggles) || s.toggles.length > 6) return null;
  const toggles = s.toggles.map(readButton);
  if (toggles.some((t) => !t)) return null;
  const main = s.main == null ? null : readButton(s.main);
  if (s.main != null && !main) return null;
  return { toggles: toggles as StackButton[], main, theme: s.theme === "light" ? "light" : "dark" };
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
:root { --surface: #232327; --fg: #f3f3f3; --line: #34343a; --off-bg: #3a3a40; --off-fg: #8a8a93; }
:root.light { --surface: #ffffff; --fg: #262626; --line: #e7e7e7; --off-bg: #e4e4e7; --off-fg: #9a9a9a; }
html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; user-select: none; }
body { display: flex; flex-direction: column; align-items: center; justify-content: flex-end; gap: ${GAP}px; padding: ${PAD}px 0; box-sizing: border-box; font: 700 11px/1.15 "Inter", -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
button {
  flex: none; border-radius: 50%; padding: 0 6px; cursor: pointer; font: inherit; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; text-align: center;
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.3); transition: transform 0.08s, filter 0.08s;
}
.small { width: ${SMALL}px; height: ${SMALL}px; background: var(--surface); color: var(--fg); border: 1px solid var(--line); font-weight: 600; font-size: 10.5px; }
.small.on { background: #fc9803; color: #262626; border-color: #fc9803; }
.main { width: ${MAIN}px; height: ${MAIN}px; background: #fc9803; color: #1c1c1c; border: 0; font-size: 12px; }
button:hover:not(:disabled) { filter: brightness(1.06); }
button:active:not(:disabled) { transform: scale(0.95); }
.main:disabled { background: var(--off-bg); color: var(--off-fg); cursor: default; }
button:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
.spin { width: 18px; height: 18px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: s 0.8s linear infinite; }
@keyframes s { to { transform: rotate(360deg); } }
</style></head><body>
<script>
const NS = "http://www.w3.org/2000/svg";
let presses = 0;
const icon = (i, size) => {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 " + i.box + " " + i.box);
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("fill", "currentColor");
  for (const d of i.paths) {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
};
const button = (b, main) => {
  const el = document.createElement("button");
  el.className = (main ? "main" : "small") + (b.on ? " on" : "");
  el.disabled = b.disabled;
  if (b.title) el.title = b.title;
  if (!main) el.setAttribute("aria-pressed", String(b.on));
  el.append(b.busy ? Object.assign(document.createElement("span"), { className: "spin" }) : icon(b.icon, main ? 24 : 18));
  el.append(Object.assign(document.createElement("span"), { textContent: b.label }));
  el.addEventListener("click", () => { if (!el.disabled) document.title = "press " + b.id + " " + ++presses; });
  return el;
};
window.setStack = (s) => {
  document.documentElement.classList.toggle("light", s.theme === "light");
  document.body.replaceChildren(...s.toggles.map((b) => button(b, false)), ...(s.main ? [button(s.main, true)] : []));
};
</script></body></html>`;

export class FloatStack {
  readonly view: WebContentsView;
  private stack: Stack | null = null;
  private ready = false;

  constructor(win: BrowserWindow, onPress: (id: string) => void) {
    this.view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, spellcheck: false } });
    this.view.setBackgroundColor("#00000000");
    this.view.setVisible(false);
    const wc = this.view.webContents;
    wc.on("will-navigate", (e) => e.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    wc.on("page-title-updated", (e, title) => {
      e.preventDefault();
      const m = /^press ([a-z][a-z0-9-]*) \d+$/.exec(title);
      if (m) onPress(m[1]!);
    });
    wc.on("did-finish-load", () => {
      this.ready = true;
      this.push();
    });
    void wc.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
    win.contentView.addChildView(this.view);
  }

  get shown(): Stack | null {
    return this.stack;
  }

  set(stack: Stack | null) {
    this.stack = stack;
    this.push();
  }

  /** In the bottom-right corner of the tab's area (window pixels), at the canvas's zoom; null hides it. */
  place(area: Rect | null, factor: number) {
    if (!area || !this.stack) return void this.view.setVisible(false);
    const size = stackSize(this.stack);
    const w = Math.round(size.width * factor);
    const h = Math.round(size.height * factor);
    const inset = Math.round((INSET - PAD) * factor);
    if (area.width < w + 2 * inset || area.height < h + 2 * inset) return void this.view.setVisible(false);
    this.view.setBounds({ x: area.x + area.width - w - inset, y: area.y + area.height - h - inset, width: w, height: h });
    this.view.webContents.setZoomFactor(factor);
    this.view.setVisible(true);
  }

  dispose(win: BrowserWindow) {
    if (!win.isDestroyed()) win.contentView.removeChildView(this.view);
    this.view.webContents.close();
  }

  private push() {
    if (this.ready && this.stack) void this.view.webContents.executeJavaScript(`setStack(${JSON.stringify(this.stack)})`).catch(() => {});
  }
}
