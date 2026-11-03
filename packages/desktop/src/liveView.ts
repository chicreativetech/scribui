import { shell, WebContentsView, type BrowserWindow, type WebContents } from "electron";
import type { ViewSaveResult } from "@scribui/server";
import { FloatStack, type Stack } from "./floatStack.js";
import { LiveCard, type Card } from "./liveCard.js";
import { layoutLiveView, scaleRect, type LiveLayout, type Rect, type Size } from "./liveLayout.js";
import { captureFromView, nextPaint, type LiveCaptureRequest, type SaveView } from "./webCapture.js";

/**
 * The reviewed web app, in its own view on top of the canvas's app tab. It is
 * a top-level page (pages that refuse embedding work, cookies behave as in a
 * tab) with no Node, in the project's own session. The canvas tells it where
 * to sit; ScribUI's UI never overlaps it, and it has no preload. The tab's intro card sits over it in a
 * view of its own (liveCard.ts), and the round buttons over both, Capture
 * view among them (floatStack.ts).
 */

export type LiveState = {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Below 1 when the chosen size is larger than the room and the app is shown scaled down. */
  zoom: number;
  /** The view's place in the canvas, in CSS pixels; null while hidden. */
  bounds: Rect | null;
  /** The last load failed (nothing answers at the address, for example). */
  error: string | null;
};

const isWeb = (url: string) => /^https?:\/\//i.test(url);

export class LiveView {
  private view: WebContentsView | null = null;
  private area: Rect | null = null;
  private size: Size | null = null;
  private layout: LiveLayout | null = null;
  private error: string | null = null;
  private capturing = false;
  private stack: FloatStack | null = null;
  private card: LiveCard | null = null;

  constructor(
    private win: BrowserWindow,
    private partition: string,
    private tell: (s: LiveState) => void,
    /** A dock button was pressed (capture, the hint's ×, or the toast's): the canvas acts on it (it holds the name and what to replace). */
    private onStackPress: (id: string) => void = () => {},
    /** The intro card's button (or Escape) was pressed. */
    private onCardClose: () => void = () => {},
  ) {}

  /** The intro card over the tab, from the canvas; null removes it. */
  setCard(card: Card | null) {
    if (!card) {
      this.card?.dispose();
      this.card = null;
    } else if (this.card) this.card.set(card);
    else this.card = new LiveCard(this.win, card, () => this.onCardClose());
    this.apply();
  }

  /** The round buttons, from the canvas; null removes them. */
  setStack(stack: Stack | null) {
    if (stack && !this.stack) this.stack = new FloatStack(this.win, (id) => this.onStackPress(id));
    this.stack?.set(stack);
    this.apply();
  }

  /** The canvas's free area for the app (CSS px) and the chosen size; null area hides the view. */
  place(area: Rect | null, size: Size | null) {
    this.area = area;
    this.size = size;
    this.apply();
  }

  navigate(url: string) {
    if (!isWeb(url)) throw new Error("only http and https addresses can be shown");
    const wc = this.ensure().webContents;
    this.error = null;
    void wc.loadURL(url).catch(() => {});
  }

  reload() {
    const wc = this.view?.webContents;
    if (!wc) return;
    this.error = null;
    wc.reload();
  }

  back() {
    const h = this.view?.webContents.navigationHistory;
    if (h?.canGoBack()) h.goBack();
  }

  forward() {
    const h = this.view?.webContents.navigationHistory;
    if (h?.canGoForward()) h.goForward();
  }

  openDevTools() {
    this.view?.webContents.openDevTools({ mode: "detach" });
  }

  get webContents(): WebContents | null {
    return this.view?.webContents ?? null;
  }

  async capture(req: LiveCaptureRequest, save: SaveView): Promise<ViewSaveResult> {
    const view = this.view;
    if (!view || !this.layout || !this.area) throw new Error("the app tab isn't showing an app");
    if (this.capturing) throw new Error("a capture is already running");
    this.capturing = true;
    const wc = view.webContents;
    const scaled = this.layout.zoom < 1 && this.size;
    let scroll: Scroll = null;
    try {
      return await captureFromView(
        wc,
        req,
        save,
        scaled
          ? {
              // the page at its real size and the screen's pixel ratio, for the moment of the shot.
              // On the way there and back the page is briefly laid out much taller than its chosen
              // size (the full-size view at the small zoom), which pulls its scroll position back,
              // so the scroll is put back before the shot and again after
              enter: async () => {
                scroll = await readScroll(wc);
                const b = this.layout!.bounds;
                view.setBounds({ x: b.x, y: b.y, width: this.size!.width, height: this.size!.height });
                wc.setZoomFactor(1);
                await nextPaint(wc);
                await restoreScroll(wc, scroll);
              },
              leave: async () => {
                this.capturing = false;
                this.apply();
                await nextPaint(wc).catch(() => {});
                await restoreScroll(wc, scroll);
              },
            }
          : undefined,
      );
    } finally {
      this.capturing = false;
    }
  }

  dispose() {
    const view = this.view;
    this.view = null;
    this.stack?.dispose(this.win);
    this.stack = null;
    this.card?.dispose();
    this.card = null;
    if (!view) return;
    if (!this.win.isDestroyed()) this.win.contentView.removeChildView(view);
    view.webContents.close();
  }

  private apply() {
    const view = this.view;
    if (this.capturing || this.win.isDestroyed()) return this.report();
    const factor = this.win.webContents.getZoomFactor();
    // the card and the buttons cover the whole area, app or not (no address yet, or it didn't load)
    const area = this.area && scaleRect(this.area, factor);
    this.card?.place(area, factor);
    this.stack?.place(area, factor);
    this.restack();
    if (!view) return this.report();
    if (!this.area || this.error) {
      view.setVisible(false);
      this.layout = this.area ? layoutLiveView(this.area, this.size) : null;
      return this.report();
    }
    this.layout = layoutLiveView(this.area, this.size);
    view.setBounds(scaleRect(this.layout.bounds, factor));
    view.webContents.setZoomFactor(this.layout.zoom);
    view.setVisible(true);
    this.report();
  }

  /** The app's view, then the card, then the dock and its toast on top; views added later go on top, so put these back. */
  private restack() {
    const want = [this.card?.view, this.stack?.view, this.stack?.toastView].filter((v): v is WebContentsView => !!v);
    const kids = this.win.contentView.children;
    if (want.every((v, i) => kids.at(i - want.length) === v)) return;
    for (const v of want) this.win.contentView.addChildView(v);
  }

  private report() {
    const wc = this.view?.webContents;
    if (this.win.isDestroyed()) return;
    this.tell({
      url: wc?.getURL() ?? "",
      title: wc?.getTitle() ?? "",
      loading: wc?.isLoading() ?? false,
      canGoBack: wc?.navigationHistory.canGoBack() ?? false,
      canGoForward: wc?.navigationHistory.canGoForward() ?? false,
      zoom: this.layout?.zoom ?? 1,
      bounds: this.view?.getVisible() && this.layout ? this.layout.bounds : null,
      error: this.error,
    });
  }

  private ensure(): WebContentsView {
    if (this.view) return this.view;
    const view = new WebContentsView({
      webPreferences: {
        partition: this.partition,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
        spellcheck: false,
      },
    });
    view.setBackgroundColor("#ffffff");
    view.setVisible(false);
    this.win.contentView.addChildView(view);
    this.view = view;
    this.restack();
    const wc = view.webContents;

    // http(s) only; links that open windows go to the system browser
    const guard = (e: { preventDefault(): void }, url: string) => {
      if (!isWeb(url) && url !== "about:blank") e.preventDefault();
    };
    wc.on("will-navigate", guard);
    wc.on("will-redirect", guard);
    wc.setWindowOpenHandler(({ url }) => {
      if (isWeb(url)) void shell.openExternal(url);
      return { action: "deny" };
    });

    const update = () => this.report();
    wc.on("did-start-loading", update);
    wc.on("did-stop-loading", update);
    wc.on("did-navigate", () => {
      this.error = null;
      this.apply();
    });
    wc.on("did-navigate-in-page", update);
    wc.on("page-title-updated", update);
    wc.on("did-fail-load", (_e, code, desc, url, isMain) => {
      // -3: aborted by a newer navigation
      if (!isMain || code === -3) return;
      this.error = `${url}: ${desc}`;
      this.apply();
    });
    wc.on("render-process-gone", (_e, d) => {
      this.error = `the app's page stopped (${d.reason}); reload to start it again`;
      this.apply();
    });
    return view;
  }
}

type Scroll = { x: number; y: number } | null;

/** The page's scroll position (CSS px); null when it can't be read. */
const readScroll = (wc: WebContents): Promise<Scroll> =>
  (wc.mainFrame.executeJavaScript("({ x: scrollX, y: scrollY })") as Promise<{ x: number; y: number }>).catch(() => null);

/** Back to a scroll position read before, then a painted frame. */
async function restoreScroll(wc: WebContents, at: Scroll) {
  if (!at) return;
  await wc.mainFrame.executeJavaScript(`scrollTo({ left: ${Number(at.x) || 0}, top: ${Number(at.y) || 0}, behavior: "instant" })`).catch(() => {});
  await nextPaint(wc);
}
