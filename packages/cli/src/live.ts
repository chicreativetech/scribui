import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { LIVE_ISOLATE, LIVE_RESTORE, loadChromium, readLiveFrame } from "@scribui/capture";
import type { ReviewStore, ViewSaveRequest, ViewSaveResult } from "@scribui/server";

/**
 * The live window: a Chrome window ScribUI controls, showing the canvas. Its
 * app tab embeds the running app; "Capture view" calls a function this module
 * exposes to the page, which screenshots the embedded app exactly as the user
 * left it (login, open menus, form input) and hands it to the project's owner
 * (`save`), which adds it to the open round in turn with every other capture.
 */

type SaveView = (req: ViewSaveRequest) => Promise<ViewSaveResult>;

export type LiveCaptureRequest = { title?: string; replace?: string };
export type LiveCaptureResult = { round: number; screenId: string; title: string };

type Frame = {
  url(): string;
  title(): Promise<string>;
  evaluate<T>(fn: string): Promise<T>;
  parentFrame(): Frame | null;
};
type ElementHandle = { contentFrame(): Promise<Frame | null>; screenshot(o?: object): Promise<Uint8Array> };
type Page = {
  goto(url: string): Promise<unknown>;
  bringToFront(): Promise<void>;
  isClosed(): boolean;
  $(selector: string): Promise<ElementHandle | null>;
  evaluate(fn: string): Promise<unknown>;
  mainFrame(): Frame;
  on(event: "framenavigated", cb: (f: Frame) => void): void;
};
type Context = {
  pages(): Page[];
  newPage(): Promise<Page>;
  exposeBinding(name: string, cb: (source: { page: Page }, arg: unknown) => unknown): Promise<void>;
  on(event: "close" | "page", cb: (p?: Page) => void): void;
  close(): Promise<void>;
};
type Chromium = { launchPersistentContext(dir: string, o: object): Promise<Context> };

export type LiveWindow = {
  /** Bring the canvas window to the front, reopening it if it was closed. */
  show(): Promise<void>;
  close(): Promise<void>;
};

/** Open the live window on the canvas. Returns null when Chrome can't be started. */
export async function openLiveWindow(store: ReviewStore, canvasUrl: string, save: SaveView, onError?: (msg: string) => void): Promise<LiveWindow | null> {
  let chromium: Chromium;
  try {
    chromium = (await loadChromium(store.root)) as Chromium;
  } catch (e) {
    onError?.((e as Error).message);
    return null;
  }
  // one profile per project: logins persist between sessions, and several projects can be open at once
  const profile = join(homedir(), ".scribui", "browser", createHash("sha1").update(store.root).digest("hex").slice(0, 12));
  await mkdir(profile, { recursive: true });

  let ctx: Context | null = null;

  const launch = async (): Promise<Context | null> => {
    const opts = { headless: false, viewport: null, args: ["--no-first-run", "--no-default-browser-check"] };
    let c: Context;
    try {
      c = await chromium.launchPersistentContext(profile, { ...opts, channel: "chrome" }); // your installed Chrome
    } catch {
      try {
        c = await chromium.launchPersistentContext(profile, opts); // Playwright's Chromium
      } catch (e) {
        onError?.((e as Error).message.split("\n")[0]!);
        return null;
      }
    }
    await attachLiveCapture(c, save);
    c.on("close", () => {
      if (ctx === c) ctx = null;
    });
    const page = c.pages()[0] ?? (await c.newPage());
    await page.goto(canvasUrl);
    return c;
  };

  ctx = await launch();
  if (!ctx) return null;

  return {
    async show() {
      if (!ctx) ctx = await launch();
      if (!ctx) return;
      const page = ctx.pages().find((p) => !p.isClosed());
      if (page) await page.bringToFront();
      else await (await ctx.newPage()).goto(canvasUrl);
    },
    async close() {
      await ctx?.close().catch(() => {});
      ctx = null;
    },
  };
}

/**
 * Give every canvas page in this browser context the capture function the
 * app tab calls, and report the embedded app's navigations to it.
 */
export async function attachLiveCapture(context: unknown, save: SaveView) {
  const c = context as Context;
  let busy = false;
  await c.exposeBinding("__scribuiCapture", async ({ page }, arg) => {
    if (busy) throw new Error("a capture is already running");
    busy = true;
    try {
      return await captureFromPage(page, (arg ?? {}) as LiveCaptureRequest, save);
    } finally {
      busy = false;
    }
  });
  const watch = (p: Page) =>
    // the canvas can't read a cross-origin frame's url; tell it where the embedded app went
    p.on("framenavigated", (f) => {
      if (f.parentFrame() !== p.mainFrame()) return;
      void p.evaluate(`window.dispatchEvent(new CustomEvent("scribui:live-url", { detail: ${JSON.stringify(f.url())} }))`).catch(() => {});
    });
  for (const p of c.pages()) watch(p);
  c.on("page", (p) => p && watch(p));
}

async function captureFromPage(page: Page, req: LiveCaptureRequest, save: SaveView): Promise<LiveCaptureResult> {
  const element = await page.$("iframe[data-scribui-live]");
  const frame = await element?.contentFrame();
  if (!element || !frame) throw new Error("the app tab isn't showing an app");
  const url = frame.url();
  if (!/^https?:/.test(url)) throw new Error("the app hasn't loaded yet");
  const pageTitle = (await frame.title().catch(() => "")).trim();
  await page.evaluate(LIVE_ISOLATE);
  let shot: Awaited<ReturnType<typeof readLiveFrame>>;
  try {
    shot = await readLiveFrame({ frame, element });
  } finally {
    await page.evaluate(LIVE_RESTORE).catch(() => {});
  }
  return save({
    platform: "web",
    url,
    title: req.title?.trim() || pageTitle || new URL(url).pathname,
    ...(req.replace ? { replace: req.replace } : {}),
    device: shot.device,
    png: shot.png,
    raw: shot.raw,
  });
}
