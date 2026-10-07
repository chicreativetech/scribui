import { contextBridge, ipcRenderer } from "electron";

/** The projects window's only way into the main process; it checks the sender is that window. */
const call = (name: string, ...args: unknown[]) => ipcRenderer.invoke(`scribui:launcher:${name}`, ...args);
const info = ipcRenderer.sendSync("scribui:launcher:info") as { version: string };

contextBridge.exposeInMainWorld("scribuiLauncher", {
  version: info.version,
  os: process.platform,
  list: () => call("list"),
  open: (dir: string) => call("open", String(dir)),
  pick: () => call("pick"),
  remove: (dir: string) => call("remove", String(dir)),
  tools: () => call("tools"),
  copy: (text: string) => call("copy", String(text)),
  openLink: (url: string) => call("openLink", String(url)),
  onChange: (cb: () => void) => void ipcRenderer.on("scribui:launcher:changed", () => cb()),
});
