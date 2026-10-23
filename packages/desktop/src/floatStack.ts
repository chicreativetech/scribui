import { WebContentsView, type BrowserWindow } from "electron";
import type { Rect } from "./liveLayout.js";

/**
 * The dock at the bottom centre of the Capture Screens tab (Select, Comment
 * and Add screen, then Capture view; the canvas's FloatStack.tsx). The app's own
 * view covers the canvas there, so it's a small transparent view
 * of their own, stacked above the app's and the intro card's. The canvas sends
 * them as data (labels, icon paths, states), which the page puts in as text
 * and SVG paths; it has no preload, and a press shows up as a title change,
 * which LiveView passes to the canvas. Captures read the app's view only, so
 * the buttons are never in a screenshot.
 *
 * The canvas's latest toast ("captured … into R001 · show in Review") comes
 * with the stack and shows in a second small view, just above the dock: the canvas's own toasts would sit under the app's view. Its page
 * reports its size in its title, and the view is cut to it, so it covers no
 * more of the app than the toast itself.
 */

export type StackIcon = { box: number; paths: string[] };
export type StackButton = { id: string; label: string; icon: StackIcon; title: string; on: boolean; disabled: boolean; busy: boolean };
export type StackToast = { id: number; text: string; tone: "ok" | "warn" | "err" | "info"; action: string | null };
export type Stack = { toggles: StackButton[]; main: StackButton | null; toast: StackToast | null; theme: "light" | "dark" };

/** The sizes, in canvas CSS pixels (styles.css's .dock): a tool, the main button, the dock's height and its frame, the gap between them. */
const TOGGLE_W = 74;
const MAIN_W = 159;
const DOCK_H = 55;
const FRAME = 5;
const DOCK_GAP = 22;
/** The dock's bottom edge above the tab's, and the room around it in its view for its shadow. */
export const INSET = 30;
const PAD = 24;

/** The view's size for a stack (CSS px): the dock and room for its shadow. */
export function stackSize(s: Stack): { width: number; height: number } {
  // their borders overlap
  const toggles = s.toggles.length ? s.toggles.length * (TOGGLE_W - 1) + 1 : 0;
  return { width: 2 * PAD + 2 * FRAME + toggles + (s.main ? DOCK_GAP + MAIN_W : 0), height: 2 * PAD + DOCK_H };
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

function readToast(v: unknown): StackToast | null {
  if (!v || typeof v !== "object") return null;
  const t = v as Record<string, unknown>;
  if (typeof t.id !== "number" || typeof t.text !== "string" || !t.text) return null;
  const tone = t.tone === "ok" || t.tone === "warn" || t.tone === "err" ? t.tone : "info";
  const action = typeof t.action === "string" && t.action ? t.action.slice(0, 40) : null;
  return { id: t.id, text: t.text.slice(0, 300), tone, action };
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
  return { toggles: toggles as StackButton[], main, toast: readToast(s.toast), theme: s.theme === "light" ? "light" : "dark" };
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
:root { --surface: #232327; --surface-2: #2a2a2f; --surface-3: #323238; --panel-line: #313136; --line: #34343a; --fg: #f3f3f3; --faint: #6d6d76; --ink: #000; --shadow: rgba(0, 0, 0, 0.45); }
:root.light { --surface: #ffffff; --surface-2: #f6f6f6; --surface-3: #ededed; --panel-line: #e7e7e7; --line: #e7e7e7; --fg: #262626; --faint: #9a9a9a; --ink: #262626; --shadow: rgba(0, 0, 0, 0.14); }
html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; user-select: none; }
body { padding: ${PAD}px; box-sizing: border-box; font: 600 10.5px/1 "Inter", -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
.dock {
  height: ${DOCK_H}px; box-sizing: border-box; display: flex; align-items: center; gap: ${DOCK_GAP}px; padding: ${FRAME - 1}px; width: max-content;
  background: var(--surface); border: 1px solid var(--panel-line); border-radius: 33px; box-shadow: 2px 4px 16px 3px var(--shadow);
}
.toggles { display: flex; height: 45px; filter: drop-shadow(0 3px 5px rgba(0, 0, 0, 0.3)); }
button { cursor: pointer; font: inherit; display: flex; align-items: center; justify-content: center; }
.toggle { flex: 1 1 0; min-width: 0; height: 100%; padding: 0 4px; box-sizing: border-box; transition: flex-grow 160ms ease-out; background: var(--surface); color: var(--fg); border: 1px solid var(--line); }
.toggle + .toggle { margin-left: -1px; }
.toggle:first-child { border-radius: 31px 0 0 31px; }
.toggle:last-child { border-radius: 0 31px 31px 0; }
.toggle.on { position: relative; background: #fc9803; color: var(--ink); border-color: #fc9803; }
.toggle:hover:not(.on) { background: var(--surface-2); }
.toggle svg { flex: none; width: 18px; height: 18px; transition: width 160ms ease-out, height 160ms ease-out; }
.label { max-width: 0; margin-left: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; opacity: 0; transition: max-width 160ms ease-out, margin-left 160ms ease-out, opacity 120ms ease-out; }
.toggle:hover svg, .toggle:focus-visible svg { width: 11px; height: 11px; }
.toggle:hover, .toggle:focus-visible { flex-grow: 1.9; }
.toggle:hover .label, .toggle:focus-visible .label { max-width: 80px; margin-left: 4px; opacity: 1; }
.main {
  width: ${MAIN_W}px; height: 45px; box-sizing: border-box; padding: 0 12px; gap: 11px; white-space: nowrap; background: #fc9803; color: var(--ink);
  border: 1px solid var(--line); border-radius: 31px; font-size: 12px; filter: drop-shadow(0 3px 5px rgba(0, 0, 0, 0.3)); transition: transform 80ms;
}
.main svg { flex: none; }
.main:hover:not(:disabled) { filter: drop-shadow(0 3px 5px rgba(0, 0, 0, 0.3)) brightness(1.06); }
.main:active:not(:disabled), .toggle:active { transform: scale(0.96); }
.main:disabled { background: var(--surface-3); color: var(--faint); cursor: default; }
button:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
.spin { width: 14px; height: 14px; box-sizing: border-box; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: s 0.8s linear infinite; }
@keyframes s { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .toggle, .toggle svg, .label { transition: none; } }
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
/** A button's state and contents, on a new button or one already there. */
const fill = (el, b, main) => {
  el.className = (main ? "main" : "toggle") + (b.on ? " on" : "");
  el.disabled = b.disabled;
  el.title = b.title;
  if (!main) {
    el.setAttribute("aria-pressed", String(b.on));
    el.setAttribute("aria-label", b.label);
  }
  const mark = b.busy ? Object.assign(document.createElement("span"), { className: "spin" }) : icon(b.icon, main ? 14 : 18);
  el.replaceChildren(mark, Object.assign(document.createElement("span"), { className: main ? "" : "label", textContent: b.label }));
  return el;
};
const button = (b, main) => {
  const el = document.createElement("button");
  el.dataset.id = b.id;
  el.addEventListener("click", () => { if (!el.disabled) document.title = "press " + b.id + " " + ++presses; });
  return fill(el, b, main);
};
const ids = (s) => s.toggles.map((b) => b.id).concat(s.main ? [s.main.id] : []).join(" ");
let shown = "";
window.setStack = (s) => {
  document.documentElement.classList.toggle("light", s.theme === "light");
  if (ids(s) === shown) {
    s.toggles.forEach((b) => fill(document.querySelector('[data-id="' + b.id + '"]'), b, false));
    if (s.main) fill(document.querySelector('[data-id="' + s.main.id + '"]'), s.main, true);
    return;
  }
  shown = ids(s);
  const toggles = Object.assign(document.createElement("div"), { className: "toggles" });
  toggles.append(...s.toggles.map((b) => button(b, false)));
  const dock = Object.assign(document.createElement("div"), { className: "dock" });
  toggles.style.width = s.toggles.length * ${TOGGLE_W - 1} + 1 + "px";
  dock.append(...(s.toggles.length ? [toggles] : []), ...(s.main ? [button(s.main, true)] : []));
  document.body.replaceChildren(dock);
};
</script></body></html>`;

/** The toast's page: as wide as its words need (to a cap), reporting its size; its buttons press "toast-action" and "toast-close". */
const TOAST_MAX = 460;
/** Room around the toast in its view, for its shadow. */
const TOAST_PAD = 14;
const TOAST_PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
:root { --surface: #232327; --fg: #f3f3f3; --line: #45454c; --faint: #8a8a93; --ok: #9ece6a; --warn: #e0af68; --err: #f7768e; --info: #7aa2f7; }
:root.light { --surface: #ffffff; --fg: #262626; --line: #d4d4d8; --faint: #9a9a9a; --ok: #3e7a1e; --warn: #9a6a00; --err: #c02648; --info: #2c5bd6; }
html, body { margin: 0; background: transparent; overflow: hidden; user-select: none; }
body { padding: ${TOAST_PAD}px; width: max-content; }
.toast {
  border-radius: 5px; display: flex; align-items: center; gap: 14px; max-width: ${TOAST_MAX - 2 * TOAST_PAD}px; box-sizing: border-box; padding: 11px 12px 11px 14px;
  background: var(--surface); color: var(--fg); border: 1px solid var(--line); border-left: 4px solid var(--info);
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.3); font: 500 13px/1.3 "Inter", -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
  animation: in 180ms cubic-bezier(0.22, 1, 0.36, 1);
}
.toast.ok { border-left-color: var(--ok); } .toast.warn { border-left-color: var(--warn); } .toast.err { border-left-color: var(--err); }
.text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
button { flex: none; background: none; border: 0; padding: 0; cursor: pointer; font: inherit; font-weight: 700; line-height: 1; color: #fc9803; white-space: nowrap; }
button.x { color: var(--faint); font-weight: 400; font-size: 15px; }
button:hover { filter: brightness(1.15); }
@keyframes in { from { opacity: 0; transform: translateY(6px); } }
@media (prefers-reduced-motion: reduce) { .toast { animation: none; } }
</style></head><body>
<script>
let presses = 0;
const press = (id) => { document.title = "press " + id + " " + ++presses; };
window.setToast = (t, theme) => {
  document.documentElement.classList.toggle("light", theme === "light");
  const el = document.createElement("div");
  el.className = "toast " + t.tone;
  el.append(Object.assign(document.createElement("span"), { className: "text", textContent: t.text, title: t.text }));
  if (t.action) {
    const a = Object.assign(document.createElement("button"), { textContent: t.action });
    a.addEventListener("click", () => press("toast-action"));
    const x = Object.assign(document.createElement("button"), { className: "x", textContent: "\u2715", title: "dismiss" });
    x.addEventListener("click", () => press("toast-close"));
    el.append(a, x);
  }
  document.body.replaceChildren(el);
  const r = document.body.getBoundingClientRect();
  document.title = "size " + Math.ceil(r.width) + " " + Math.ceil(r.height) + " " + t.id;
};
</script></body></html>`;

export class FloatStack {
  readonly view: WebContentsView;
  readonly toastView: WebContentsView;
  private stack: Stack | null = null;
  private ready = false;
  private toastReady = false;
  /** The shown toast's size (CSS px), once its page has measured it. */
  private toastSize: { id: number; width: number; height: number } | null = null;
  private placed: { area: Rect | null; factor: number } = { area: null, factor: 1 };

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

    this.toastView = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, spellcheck: false } });
    this.toastView.setBackgroundColor("#00000000");
    this.toastView.setVisible(false);
    const tc = this.toastView.webContents;
    tc.on("will-navigate", (e) => e.preventDefault());
    tc.setWindowOpenHandler(() => ({ action: "deny" }));
    tc.on("page-title-updated", (e, title) => {
      e.preventDefault();
      const press = /^press (toast-action|toast-close) \d+$/.exec(title);
      if (press) return onPress(press[1]!);
      const size = /^size (\d+) (\d+) (\d+)$/.exec(title);
      if (size) {
        this.toastSize = { width: Number(size[1]), height: Number(size[2]), id: Number(size[3]) };
        this.place(this.placed.area, this.placed.factor);
      }
    });
    tc.on("did-finish-load", () => {
      this.toastReady = true;
      this.pushToast();
    });
    void tc.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(TOAST_PAGE)}`);
    win.contentView.addChildView(this.toastView);
  }

  get shown(): Stack | null {
    return this.stack;
  }

  set(stack: Stack | null) {
    const before = this.stack;
    this.stack = stack;
    this.push();
    // a new toast, or the same one in the other theme, is measured again before it shows
    if (stack?.toast && (stack.toast.id !== before?.toast?.id || stack.theme !== before?.theme)) {
      this.toastSize = null;
      this.pushToast();
    }
  }

  /** At the bottom centre of the tab's area (window pixels), at the canvas's zoom; null hides it. */
  place(area: Rect | null, factor: number) {
    this.placed = { area, factor };
    const toastAt = this.toastBounds(area, factor);
    if (toastAt) {
      this.toastView.setBounds(toastAt);
      this.toastView.webContents.setZoomFactor(factor);
    }
    this.toastView.setVisible(!!toastAt);
    const at = area && this.stackBounds(area, factor);
    if (!at) return void this.view.setVisible(false);
    this.view.setBounds(at);
    this.view.webContents.setZoomFactor(factor);
    this.view.setVisible(true);
  }

  /** The dock's view (window pixels), its bottom edge INSET above the area's; null when it doesn't fit. */
  private stackBounds(area: Rect, factor: number): Rect | null {
    if (!this.stack) return null;
    const size = stackSize(this.stack);
    const w = Math.round(size.width * factor);
    const h = Math.round(size.height * factor);
    const inset = Math.round((INSET - PAD) * factor);
    if (area.width < w || area.height < h + 2 * inset) return null;
    return { x: Math.round(area.x + (area.width - w) / 2), y: area.y + area.height - h - inset, width: w, height: h };
  }

  /** The toast's: centred just above the dock, once measured and while there's room. */
  private toastBounds(area: Rect | null, factor: number): Rect | null {
    const t = this.stack?.toast;
    const ts = this.toastSize;
    const at = area && this.stackBounds(area, factor);
    if (!area || !at || !t || !ts || ts.id !== t.id) return null;
    const width = Math.round(Math.min(ts.width, TOAST_MAX) * factor);
    const height = Math.round(ts.height * factor);
    const x = Math.round(at.x + at.width / 2 - width / 2);
    // its bottom edge 12px above the dock's top
    const y = at.y + Math.round((PAD - 12 + TOAST_PAD) * factor) - height;
    return x < area.x || y < area.y ? null : { x, y, width, height };
  }

  dispose(win: BrowserWindow) {
    if (!win.isDestroyed()) {
      win.contentView.removeChildView(this.view);
      win.contentView.removeChildView(this.toastView);
    }
    this.view.webContents.close();
    this.toastView.webContents.close();
  }

  private push() {
    if (this.ready && this.stack) void this.view.webContents.executeJavaScript(`setStack(${JSON.stringify(this.stack)})`).catch(() => {});
  }

  private pushToast() {
    const t = this.stack?.toast;
    if (this.toastReady && t) void this.toastView.webContents.executeJavaScript(`setToast(${JSON.stringify(t)}, ${JSON.stringify(this.stack!.theme)})`).catch(() => {});
  }
}
