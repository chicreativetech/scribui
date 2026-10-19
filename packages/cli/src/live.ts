import { LIVE_ISOLATE, LIVE_RESTORE, readLiveFrame } from "@scribui/capture";
import type { ViewSaveRequest, ViewSaveResult } from "@scribui/server";

/**
 * Capturing the app embedded in a canvas's app tab, in a browser ScribUI controls
 * (the desktop app's test harnesses): "Capture view" calls a function this module
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
