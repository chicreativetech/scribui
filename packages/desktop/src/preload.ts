import { contextBridge, ipcRenderer } from "electron";

/**
 * Runs in the canvas only (never in the reviewed app's frame). Exposes the
 * same `window.__scribuiCapture` the Chrome live window provides, so the
 * canvas needs no desktop-specific code. The main process checks that every
 * call comes from the canvas's own top frame.
 */
type Req = { title?: string; replace?: string };

contextBridge.exposeInMainWorld("__scribuiCapture", (req?: Req) =>
  ipcRenderer.invoke("scribui:capture", { title: typeof req?.title === "string" ? req.title : undefined, replace: typeof req?.replace === "string" ? req.replace : undefined }),
);
contextBridge.exposeInMainWorld("scribuiDesktop", { version: 1, platform: process.platform });
