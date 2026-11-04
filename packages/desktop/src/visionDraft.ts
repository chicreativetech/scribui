import { mkdir } from "node:fs/promises";
import { app, BrowserWindow, shell } from "electron";
import { visionPages } from "@scribui/core";
import { ReviewStore } from "@scribui/server";
import { hostProject } from "@scribui/project";
import { CANVAS_DIR } from "./projectWindow.js";

/**
 * The vision board of a new project, before its app exists: the canvas in
 * vision-only mode (`?mode=new`), in its own window, on a server for the
 * folder that has no screens.json yet. The board is saved in the folder's
 * `.scribui/vision/`, so the project opens with it once it's set up.
 */

type Draft = { win: BrowserWindow; close: () => Promise<void> };
const drafts = new Map<string, Draft>();

/** Open (or bring forward) the vision board for `dir`; `onClosed` runs when its window closes. */
export async function openVisionDraft(dir: string, name: string, onClosed: () => void): Promise<{ ok: true } | { ok: false; error: string }> {
  const open = drafts.get(dir);
  if (open && !open.win.isDestroyed()) {
    if (open.win.isMinimized()) open.win.restore();
    open.win.focus();
    return { ok: true };
  }
  const store = new ReviewStore(dir);
  await mkdir(store.dir, { recursive: true });
  const hosted = await hostProject(store, { app: "desktop", server: { canvasDir: CANVAS_DIR } });
  if (hosted.kind === "no-port") return { ok: false, error: "Every port ScribUI tries is in use." };
  const url = hosted.kind === "owner" ? `http://127.0.0.1:${hosted.server.port}/` : hosted.owner.url;
  if (!url) return { ok: false, error: "Another ScribUI process owns this folder and isn't reachable." };
  const srv = hosted.kind === "owner" ? hosted.server : null;
  const origin = new URL(url).origin;

  const win = new BrowserWindow({
    width: 1200,
    height: 860,
    minWidth: 640,
    minHeight: 480,
    title: `Vision · ${name} · ScribUI`,
    backgroundColor: "#d9d9d9",
    show: false,
    webPreferences: {
      // no preload: the board needs nothing from the main process
      partition: "persist:scribui-canvas",
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
    },
  });
  win.once("ready-to-show", () => win.show());
  win.on("page-title-updated", (e) => e.preventDefault());
  win.webContents.on("will-navigate", (e, to) => {
    if (new URL(to).origin !== origin) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url: to }) => {
    if (/^https?:\/\//.test(to)) void shell.openExternal(to);
    return { action: "deny" };
  });
  let closing: Promise<void> | null = null;
  const draft: Draft = {
    win,
    close: () =>
      (closing ??= (async () => {
        if (drafts.get(dir) === draft) drafts.delete(dir);
        await srv?.close();
      })()),
  };
  drafts.set(dir, draft);
  // closing it saves the last strokes first (autosave waits a moment)
  let flushed = false;
  win.on("close", (e) => {
    if (flushed) return;
    e.preventDefault();
    flushed = true;
    void flush(win).finally(() => {
      if (!win.isDestroyed()) win.close();
    });
  });
  win.on("closed", () => {
    void draft.close().finally(onClosed);
  });
  await win.loadURL(`${url}?mode=new`);
  return { ok: true };
}

/** Save what's drawn on an open board and close its window. */
export async function closeVisionDraft(dir: string) {
  const d = drafts.get(dir);
  if (!d || d.win.isDestroyed()) return;
  await flush(d.win);
  // destroy() skips the close handler's flush (done just now) but still fires "closed"
  if (!d.win.isDestroyed()) d.win.destroy();
  await d.close();
}

/** Save what's drawn on an open board (its autosave waits a moment). */
export async function flushVisionDraft(dir: string) {
  const d = drafts.get(dir);
  if (d && !d.win.isDestroyed()) await flush(d.win);
}

async function flush(win: BrowserWindow) {
  await win.webContents.executeJavaScript("window.__scribuiFlushVision?.()", true).catch(() => {});
}

/** Canvases with something drawn on them in `dir`'s board. */
export async function visionCanvasCount(dir: string): Promise<number> {
  try {
    return visionPages(await new ReviewStore(dir).readVision()).length;
  } catch {
    return 0;
  }
}

app.on("before-quit", () => {
  for (const d of drafts.values()) void d.close();
});
