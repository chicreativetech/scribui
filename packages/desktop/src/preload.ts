import { contextBridge, ipcRenderer } from "electron";

/**
 * Runs in the canvas only (never in the reviewed app). Exposes the same
 * `window.__scribuiCapture` the Chrome live window provides, plus
 * `scribuiDesktop.live`: the app tab's own view, which the canvas places and
 * drives. The main process checks that every call comes from the canvas's
 * own top frame.
 */
type Req = { title?: string; replace?: string };
type Box = { x: number; y: number; width: number; height: number };

const config = ipcRenderer.sendSync("scribui:config") as { surface: "view" | "iframe" | null };

contextBridge.exposeInMainWorld("__scribuiCapture", (req?: Req) =>
  ipcRenderer.invoke("scribui:capture", { title: typeof req?.title === "string" ? req.title : undefined, replace: typeof req?.replace === "string" ? req.replace : undefined }),
);

const box = (b: Box | null) => (b ? { x: +b.x, y: +b.y, width: +b.width, height: +b.height } : null);

contextBridge.exposeInMainWorld("scribuiDesktop", {
  version: 2,
  platform: process.platform,
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
          onState: (cb: (s: unknown) => void) => {
            const fn = (_e: unknown, s: unknown) => cb(s);
            ipcRenderer.on("scribui:live-state", fn);
            return () => void ipcRenderer.removeListener("scribui:live-state", fn);
          },
        },
      }
    : {}),
});
