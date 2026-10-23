import { shell, WebContentsView, type BrowserWindow } from "electron";
import type { Rect } from "./liveLayout.js";

/**
 * A card over the reviewed app (the Capture Screens intro): like the floating
 * Capture view button (captureButton.ts), a transparent view of its own,
 * because the app's view covers the canvas. It dims the app behind it. The
 * canvas sends the words; the page puts them in as text (only **bold** and
 * [links](https://…) are read), and a press of its button, or Escape, shows
 * up as a title change. Captures read the app's view only.
 */

export type Card = { title: string; paras: string[]; button: string; theme: "light" | "dark" };

/** A card from the canvas, checked: plain strings, of sane length. */
export function readCard(v: unknown): Card | null {
  if (!v || typeof v !== "object") return null;
  const c = v as Record<string, unknown>;
  const str = (x: unknown, max: number) => (typeof x === "string" && x.length <= max ? x : null);
  const title = str(c.title, 200);
  const button = str(c.button, 60);
  const paras = Array.isArray(c.paras) && c.paras.length <= 20 ? c.paras.map((p) => str(p, 2000)) : null;
  if (title === null || button === null || !paras || paras.some((p) => p === null)) return null;
  return { title, button, paras: paras as string[], theme: c.theme === "light" ? "light" : "dark" };
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
:root { --surface: #232327; --fg: #f3f3f3; --fg-dim: #a6a6ae; --line: #34343a; --code: #2a2a2f; }
:root.light { --surface: #ffffff; --fg: #262626; --fg-dim: #5e5e5e; --line: #e7e7e7; --code: #f6f6f6; }
html, body { margin: 0; height: 100%; overflow: hidden; }
body { background: rgba(0, 0, 0, 0.4); display: grid; place-items: center; font: 12.5px/1.7 "Inter", -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
.card { box-sizing: border-box; border-radius: 5px; max-width: 540px; max-height: calc(100% - 48px); overflow: auto; margin: 24px; padding: 34px 38px 30px; background: var(--surface); color: var(--fg-dim); border: 1px solid var(--line); box-shadow: 3px 4px 19px 5px rgba(0, 0, 0, 0.25); }
h1 { font-size: 46px; font-weight: 700; line-height: 0.95; letter-spacing: -0.045em; color: var(--fg); margin: 0 0 20px; }
h1 span { color: #fc9803; }
p { margin: 0 0 9px; }
b { color: var(--fg); font-weight: 600; }
a { color: #fc9803; }
button { margin-top: 12px; background: #fc9803; color: #262626; border: 0; padding: 9px 18px; font-family: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer; }
button:hover { filter: brightness(1.06); }
button:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
</style></head><body><div class="card" role="dialog" aria-modal="true"></div>
<script>
const card = document.querySelector(".card");
let closes = 0;
const close = () => { document.title = "close " + ++closes; };
// **bold** and [label](https://…), everything else as text
const rich = (el, s) => {
  for (const part of s.split(/(\\*\\*[^*]+\\*\\*|\\[[^\\]]+\\]\\(https:\\/\\/[^)\\s]+\\))/)) {
    if (!part) continue;
    const b = /^\\*\\*(.+)\\*\\*$/.exec(part);
    const a = /^\\[(.+)\\]\\((.+)\\)$/.exec(part);
    if (b) el.append(Object.assign(document.createElement("b"), { textContent: b[1] }));
    else if (a) el.append(Object.assign(document.createElement("a"), { textContent: a[1], href: a[2], target: "_blank" }));
    else el.append(part);
  }
  return el;
};
window.setCard = (c) => {
  document.documentElement.classList.toggle("light", c.theme === "light");
  card.replaceChildren();
  const h = rich(document.createElement("h1"), c.title);
  h.append(Object.assign(document.createElement("span"), { textContent: "." }));
  card.append(h, ...c.paras.map((p) => rich(document.createElement("p"), p)));
  const b = Object.assign(document.createElement("button"), { textContent: c.button });
  b.addEventListener("click", close);
  card.append(b);
  b.focus();
};
addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
</script></body></html>`;

export class LiveCard {
  readonly view: WebContentsView;
  private ready = false;

  constructor(
    private win: BrowserWindow,
    private card: Card,
    onClose: () => void,
  ) {
    this.view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, spellcheck: false } });
    this.view.setBackgroundColor("#00000000");
    this.view.setVisible(false);
    const wc = this.view.webContents;
    wc.on("will-navigate", (e) => e.preventDefault());
    // its links open in the system browser
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//i.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    wc.on("page-title-updated", (e, title) => {
      e.preventDefault();
      if (title.startsWith("close ")) onClose();
    });
    wc.on("did-finish-load", () => {
      this.ready = true;
      this.push();
    });
    void wc.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
    win.contentView.addChildView(this.view);
  }

  set(card: Card) {
    this.card = card;
    this.push();
  }

  /** Over the app tab's free area (window pixels), at the canvas's zoom; null hides it. */
  place(area: Rect | null, factor: number) {
    if (!area || area.width < 40 || area.height < 40) return void this.view.setVisible(false);
    this.view.setBounds(area);
    this.view.webContents.setZoomFactor(factor);
    if (!this.view.getVisible()) {
      this.view.setVisible(true);
      this.view.webContents.focus();
    }
  }

  dispose() {
    if (!this.win.isDestroyed()) this.win.contentView.removeChildView(this.view);
    this.view.webContents.close();
  }

  private push() {
    if (this.ready) void this.view.webContents.executeJavaScript(`setCard(${JSON.stringify(this.card)})`).catch(() => {});
  }
}
