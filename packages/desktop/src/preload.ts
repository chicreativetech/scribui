import { contextBridge, ipcRenderer } from "electron";

/**
 * Runs in the canvas only (never in the reviewed app). Exposes the same
 * `window.__scribuiCapture` the Chrome live window provides, plus
 * `scribuiDesktop.live`: the app tab's own view, which the canvas places and
 * drives (web projects), or `scribuiDesktop.device`: the device tab's live
 * emulator or phone (mobile projects). The main process checks that every
 * call comes from the canvas's own top frame, and checks every input again.
 */
type Req = { title?: string; replace?: string; fullPage?: boolean; signature?: string };
type Box = { x: number; y: number; width: number; height: number };

const config = ipcRenderer.sendSync("scribui:config") as { surface: "view" | "iframe" | null; device: "android" | "ios" | null };

/** A listener the canvas can remove again. */
const listen = (channel: string, cb: (v: unknown) => void) => {
  const fn = (_e: unknown, v: unknown) => cb(v);
  ipcRenderer.on(channel, fn);
  return () => void ipcRenderer.removeListener(channel, fn);
};

contextBridge.exposeInMainWorld("__scribuiCapture", (req?: Req) =>
  ipcRenderer.invoke("scribui:capture", {
    title: typeof req?.title === "string" ? req.title : undefined,
    replace: typeof req?.replace === "string" ? req.replace : undefined,
    fullPage: req?.fullPage === true,
    signature: typeof req?.signature === "string" ? req.signature : undefined,
  }),
);

const box = (b: Box | null) => (b ? { x: +b.x, y: +b.y, width: +b.width, height: +b.height } : null);

contextBridge.exposeInMainWorld("scribuiDesktop", {
  version: 6,
  platform: process.platform,
  /** One-time hints (the Capture Screens intro): seen in any project, so they show once. */
  hints: {
    seen: (id: string) => ipcRenderer.invoke("scribui:hint-seen", String(id)) as Promise<boolean>,
    mark: (id: string) => ipcRenderer.send("scribui:hint-mark", String(id)),
  },
  ...(config.surface === "view"
    ? {
        live: {
          /** The free area of the app tab (CSS px, window coordinates) and the chosen size (null: fill it); null area hides the app. */
          place: (area: Box | null, size: { width: number; height: number } | null) =>
            ipcRenderer.send("scribui:live-place", box(area), size ? { width: +size.width, height: +size.height } : null),
          navigate: (url: string) => ipcRenderer.invoke("scribui:live-go", "navigate", String(url)),
          reload: () => ipcRenderer.invoke("scribui:live-go", "reload"),
          back: () => ipcRenderer.invoke("scribui:live-go", "back"),
          forward: () => ipcRenderer.invoke("scribui:live-go", "forward"),
          devtools: () => ipcRenderer.invoke("scribui:live-go", "devtools"),
          onState: (cb: (s: unknown) => void) => listen("scribui:live-state", cb),
          /** Marking up the page: the tool (null: browse), the notes to draw on it, and what its mark layer sends (finished marks). */
          markMode: (tool: string | null, styles?: unknown, theme?: string) =>
            ipcRenderer.send("scribui:live-mark-mode", JSON.parse(JSON.stringify({ tool: tool ?? null, ...(styles ? { styles } : {}), ...(theme ? { theme } : {}) }))),
          setMarks: (list: unknown) => ipcRenderer.send("scribui:live-marks", JSON.parse(JSON.stringify(list ?? null))),
          onMark: (cb: (ev: unknown) => void) => listen("scribui:live-mark", cb),
          /** The round buttons over the app (Tablet, Panel, Pen mode, Capture view; null removes them), and their presses by id. */
          stack: (s: unknown) => ipcRenderer.send("scribui:live-stack", JSON.parse(JSON.stringify(s ?? null))),
          onStackPress: (cb: (id: string) => void) => listen("scribui:live-stack-press", (id) => cb(String(id))),
          /** The intro card over the app (words, button, theme; null removes it), and its button's presses. */
          card: (c: unknown) => ipcRenderer.send("scribui:live-card", JSON.parse(JSON.stringify(c ?? null))),
          onCardClose: (cb: () => void) => listen("scribui:live-card-close", () => cb()),
        },
      }
    : {}),
  ...(config.device
    ? {
        /** The device tab (mobile projects): a live emulator or phone. */
        device: {
          platform: config.device,
          state: () => ipcRenderer.invoke("scribui:device-state"),
          list: () => ipcRenderer.invoke("scribui:device-list"),
          connect: (id: string) => ipcRenderer.invoke("scribui:device-connect", String(id)),
          disconnect: () => ipcRenderer.invoke("scribui:device-disconnect"),
          /** Start an emulator (AVD name) or boot a simulator (UDID) from the list's `startable`, then show it. */
          start: (id: string) => ipcRenderer.invoke("scribui:device-start", String(id)),
          setVisible: (v: boolean) => ipcRenderer.send("scribui:device-visible", v === true),
          resetVideo: () => ipcRenderer.send("scribui:device-reset"),
          /** Pointer, scroll, keys, text, rotate; checked again in the main process. */
          input: (ev: unknown) => ipcRenderer.send("scribui:device-input", JSON.parse(JSON.stringify(ev ?? null))),
          capture: (req?: Req) =>
            ipcRenderer.invoke("scribui:device-capture", { title: typeof req?.title === "string" ? req.title : undefined, replace: typeof req?.replace === "string" ? req.replace : undefined }),
          keep: () => ipcRenderer.invoke("scribui:device-keep"),
          discard: () => ipcRenderer.send("scribui:device-discard"),
          cancel: () => ipcRenderer.send("scribui:device-cancel"),
          onState: (cb: (s: unknown) => void) => listen("scribui:device-state", cb),
          onFrame: (cb: (f: unknown) => void) => listen("scribui:device-frame", cb),
          onProgress: (cb: (p: unknown) => void) => listen("scribui:device-progress", cb),
          /** Install a tool the device list reported missing and installable (adb, AXe). */
          install: (id: string) => ipcRenderer.invoke("scribui:device-install", String(id)),
          onInstallLog: (cb: (line: unknown) => void) => listen("scribui:device-install-log", cb),
        },
      }
    : {}),
});
