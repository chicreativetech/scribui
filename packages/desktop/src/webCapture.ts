import type { WebContents, WebFrameMain } from "electron";
import { LIVE_ISOLATE, LIVE_RESTORE, readLiveFrame } from "@scribui/capture";
import type { ViewSaveRequest, ViewSaveResult } from "@scribui/server";

export type LiveCaptureRequest = { title?: string; replace?: string };
/** Saves a view through the project's owner: this app's own server, or another process's over HTTP. */
export type SaveView = (req: ViewSaveRequest) => Promise<ViewSaveResult>;

/**
 * Web capture inside the desktop app, over DevTools from the main process.
 * The app normally has its own view (`captureFromView`); the spike's iframe
 * path (`captureFromCanvas`) reads the canvas's `scribui-live` frame directly
 * (cross-origin frames are open to the main process).
 * Same preparation as the Playwright path: ScribUI's own UI hidden, the frame
 * pinned to the window's corner, animations finished, the caret hidden.
 */

export const LIVE_FRAME = "scribui-live";

export const liveFrame = (wc: WebContents): WebFrameMain | undefined => wc.mainFrame.frames.find((f) => f.name === LIVE_FRAME);

/**
 * What Playwright's `animations: "disabled"` does: finite animations and
 * transitions jump to their end, infinite ones are cancelled; then two frames
 * so the result is painted. The caret is hidden for the moment of the shot.
 */
const FREEZE = String.raw`(() => {
  const st = document.createElement("style");
  st.id = "scribui-freeze";
  st.textContent = "*, *::before, *::after { caret-color: transparent !important; }";
  (document.head || document.documentElement).appendChild(st);
  for (const a of document.getAnimations ? document.getAnimations() : []) {
    try {
      const t = a.effect && a.effect.getComputedTiming();
      if (t && Number.isFinite(t.endTime)) a.finish();
      else a.cancel();
    } catch {}
  }
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))));
})()`;
const UNFREEZE = `document.getElementById("scribui-freeze")?.remove()`;

const FRAME_RECT = `(() => {
  const b = document.querySelector('iframe[name="${LIVE_FRAME}"]').getBoundingClientRect();
  return { x: b.left, y: b.top, width: b.width, height: b.height };
})()`;

async function cdp<T>(wc: WebContents, method: string, params: object = {}): Promise<T> {
  if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
  return (await wc.debugger.sendCommand(method, params)) as T;
}

/** Screenshot of the live frame's box, beyond the window when the frame is larger. */
export async function screenshotLiveFrame(wc: WebContents, frame: WebFrameMain): Promise<Uint8Array> {
  await frame.executeJavaScript(FREEZE);
  try {
    const clip = (await wc.mainFrame.executeJavaScript(FRAME_RECT)) as { x: number; y: number; width: number; height: number };
    const shot = await cdp<{ data: string }>(wc, "Page.captureScreenshot", {
      format: "png",
      clip: { ...clip, scale: 1 },
      captureBeyondViewport: true,
      fromSurface: true,
    });
    return Buffer.from(shot.data, "base64");
  } finally {
    await frame.executeJavaScript(UNFREEZE).catch(() => {});
  }
}

/** Screenshot of a whole page shown in its own view (the app view), as it is painted. */
export async function screenshotPage(wc: WebContents): Promise<Uint8Array> {
  await wc.mainFrame.executeJavaScript(FREEZE);
  try {
    const shot = await cdp<{ data: string }>(wc, "Page.captureScreenshot", { format: "png", fromSurface: true });
    return Buffer.from(shot.data, "base64");
  } finally {
    await wc.mainFrame.executeJavaScript(UNFREEZE).catch(() => {});
  }
}

/** Two painted frames: what a layout or zoom change needs before a screenshot. */
export const nextPaint = (wc: WebContents) =>
  wc.mainFrame.executeJavaScript("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))") as Promise<boolean>;

/**
 * The capture behind "Capture view" when the app has its own view: the page
 * is the app, so nothing of ScribUI needs hiding. `full` puts a scaled-down
 * view at its real size for the moment of the shot.
 */
export async function captureFromView(wc: WebContents, req: LiveCaptureRequest, save: SaveView, full?: { enter(): Promise<void>; leave(): void }): Promise<ViewSaveResult> {
  const url = wc.getURL();
  if (!/^https?:/.test(url)) throw new Error("the app hasn't loaded yet");
  const pageTitle = wc.getTitle().trim();
  let shot: Awaited<ReturnType<typeof readLiveFrame>>;
  await full?.enter();
  try {
    shot = await readLiveFrame({
      frame: { evaluate: <T>(fn: string) => wc.mainFrame.executeJavaScript(fn) as Promise<T> },
      element: { screenshot: () => screenshotPage(wc) },
    });
  } finally {
    full?.leave();
  }
  return save({
    platform: "web",
    url,
    title: req.title?.trim() || (pageTitle && pageTitle !== url ? pageTitle : "") || new URL(url).pathname,
    ...(req.replace ? { replace: req.replace } : {}),
    device: shot.device,
    png: shot.png,
    raw: shot.raw,
  });
}

/** The capture behind the canvas's "Capture view" button, with the app in the canvas's iframe (spike W). */
export async function captureFromCanvas(wc: WebContents, req: LiveCaptureRequest, save: SaveView): Promise<ViewSaveResult> {
  const frame = liveFrame(wc);
  if (!frame) throw new Error("the app tab isn't showing an app");
  const url = frame.url;
  if (!/^https?:/.test(url)) throw new Error("the app hasn't loaded yet");
  const pageTitle = String(await frame.executeJavaScript("document.title").catch(() => "")).trim();
  await wc.mainFrame.executeJavaScript(LIVE_ISOLATE);
  let shot: Awaited<ReturnType<typeof readLiveFrame>>;
  try {
    shot = await readLiveFrame({
      frame: { evaluate: <T>(fn: string) => frame.executeJavaScript(fn) as Promise<T> },
      element: { screenshot: () => screenshotLiveFrame(wc, frame) },
    });
  } finally {
    await wc.mainFrame.executeJavaScript(LIVE_RESTORE).catch(() => {});
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

/** Save through another process's server (it owns the project). */
export function saveViaServer(url: string): SaveView {
  return async (req) => {
    const { png, raw, ...rest } = req;
    const r = await fetch(new URL("/api/views", url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...rest, png: Buffer.from(png).toString("base64"), tree: raw, trigger: "desktop" }),
    });
    const body = (await r.json()) as ViewSaveResult & { error?: string };
    if (!r.ok) throw new Error(body.error ?? `the project's server refused the view (${r.status})`);
    return body;
  };
}
