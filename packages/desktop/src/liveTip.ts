import { WebContentsView, type BrowserWindow } from "electron";

/**
 * A tool rail tooltip in the Capture Screens tab. The rail's tips open to its
 * right, over the app tab, where the app's own view covers the canvas, so
 * there the canvas sends the tip here instead: its words (plain text in a few
 * styles) and where it goes, and a small view of its own shows it, cut to the
 * tip's size (its page measures it and says so in its title). It never takes
 * the pointer: it shows only while the pointer is on the rail.
 */

export type TipPart = { text: string; style: "" | "b" | "kbd" | "dim" };
export type Tip = { id: number; parts: TipPart[]; x: number; y: number; theme: "light" | "dark" };

/** A tip from the canvas, checked: a few short text parts, a place in the canvas (CSS px). */
export function readTip(v: unknown): Tip | null {
  if (!v || typeof v !== "object") return null;
  const t = v as Record<string, unknown>;
  if (typeof t.id !== "number" || !Number.isFinite(t.x) || !Number.isFinite(t.y) || !Array.isArray(t.parts) || !t.parts.length || t.parts.length > 12) return null;
  const parts: TipPart[] = [];
  for (const p of t.parts as unknown[]) {
    const q = p as Record<string, unknown> | null;
    if (!q || typeof q.text !== "string" || q.text.length > 300) return null;
    parts.push({ text: q.text, style: q.style === "b" || q.style === "kbd" || q.style === "dim" ? q.style : "" });
  }
  return { id: t.id, parts, x: t.x as number, y: t.y as number, theme: t.theme === "light" ? "light" : "dark" };
}

/** Like the canvas's `.tool .tip` (styles.css). */
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
:root { --surface-3: #323238; --line-2: #47474f; --fg: #f3f3f3; --fg-dim: #a6a6ae; --surface-2: #2a2a2f; }
:root.light { --surface-3: #ededed; --line-2: #d7cfcf; --fg: #262626; --fg-dim: #5e5e5e; --surface-2: #f6f6f6; }
html, body { margin: 0; background: transparent; overflow: hidden; user-select: none; }
body { width: max-content; }
.tip {
  background: var(--surface-3); border: 1px solid var(--line-2); border-radius: 5px; padding: 5px 8px; white-space: nowrap;
  color: var(--fg); font: 400 11px/1.3 "Inter", -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
}
b { font-weight: 600; }
.dim { color: var(--fg-dim); }
kbd { font: 600 10.5px/1 "JetBrains Mono", ui-monospace, Menlo, monospace; padding: 2px 4px 3px; border: 1px solid var(--line-2); border-bottom-width: 2px; border-radius: 3px; color: var(--fg-dim); background: var(--surface-2); }
</style></head><body>
<script>
window.setTip = (t) => {
  document.documentElement.classList.toggle("light", t.theme === "light");
  const tip = Object.assign(document.createElement("div"), { className: "tip" });
  for (const p of t.parts) {
    const tag = p.style === "b" ? "b" : p.style === "kbd" ? "kbd" : "span";
    tip.append(Object.assign(document.createElement(tag), { textContent: p.text, className: p.style === "dim" ? "dim" : "" }));
  }
  document.body.replaceChildren(tip);
  const r = tip.getBoundingClientRect();
  document.title = "size " + Math.ceil(r.width) + " " + Math.ceil(r.height) + " " + t.id;
};
</script></body></html>`;

export class LiveTip {
  readonly view: WebContentsView;
  private tip: Tip | null = null;
  private ready = false;
  /** The shown tip's size (CSS px), once its page has measured it. */
  private size: { id: number; width: number; height: number } | null = null;
  private factor = 1;

  constructor(private win: BrowserWindow) {
    this.view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, spellcheck: false } });
    this.view.setBackgroundColor("#00000000");
    this.view.setVisible(false);
    const wc = this.view.webContents;
    wc.on("will-navigate", (e) => e.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    wc.on("page-title-updated", (e, title) => {
      e.preventDefault();
      const m = /^size (\d+) (\d+) (\d+)$/.exec(title);
      if (!m) return;
      this.size = { width: Number(m[1]), height: Number(m[2]), id: Number(m[3]) };
      this.place(this.factor);
    });
    wc.on("did-finish-load", () => {
      this.ready = true;
      this.push();
    });
    void wc.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
    win.contentView.addChildView(this.view);
  }

  /** The tip to show; null hides it. */
  set(tip: Tip | null) {
    const changed = tip?.id !== this.tip?.id || tip?.theme !== this.tip?.theme;
    this.tip = tip;
    if (!tip) return void this.view.setVisible(false);
    if (changed) {
      this.size = null;
      this.view.setVisible(false);
      this.push();
    } else this.place(this.factor);
  }

  /** At its place in the canvas (CSS px → window pixels at the canvas's zoom), once measured. */
  place(factor: number) {
    this.factor = factor;
    const t = this.tip;
    const s = this.size;
    if (!t || !s || s.id !== t.id) return void this.view.setVisible(false);
    this.view.setBounds({ x: Math.round(t.x * factor), y: Math.round(t.y * factor), width: Math.ceil(s.width * factor), height: Math.ceil(s.height * factor) });
    this.view.webContents.setZoomFactor(factor);
    this.view.setVisible(true);
  }

  dispose() {
    if (!this.win.isDestroyed()) this.win.contentView.removeChildView(this.view);
    this.view.webContents.close();
  }

  private push() {
    if (this.ready && this.tip) void this.view.webContents.executeJavaScript(`setTip(${JSON.stringify(this.tip)})`).catch(() => {});
  }
}
