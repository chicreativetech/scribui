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
  /** Install a tool the app can install (its plan is made in the main process); output comes through onInstallLog. */
  install: (id: string) => call("install", String(id)),
  cancelInstall: (id: string) => call("cancelInstall", String(id)),
  copy: (text: string) => call("copy", String(text)),
  openLink: (url: string) => call("openLink", String(url)),
  onChange: (cb: () => void) => void ipcRenderer.on("scribui:launcher:changed", () => cb()),
  /** Updates: the state, and install (a downloaded one), check, or open (the release page of one to download by hand). */
  update: () => call("update"),
  updateAction: (action: string) => call("updateAction", String(action)),
  onUpdate: (cb: (s: unknown) => void) => void ipcRenderer.on("scribui:launcher:update", (_e, v) => cb(v)),
  onInstallLog: (cb: (e: { id: string; line: string }) => void) => void ipcRenderer.on("scribui:launcher:install-log", (_e, v) => cb(v)),
  /** Setting up a folder that isn't a project yet (only folders the user chose). */
  setup: {
    info: (dir: string) => call("setupInfo", String(dir)),
    servers: (dir: string) => call("servers", String(dir)),
    checkUrl: (url: string) => call("checkUrl", String(url)),
    tools: (dir: string, platform: string) => call("setupTools", String(dir), String(platform)),
    /** Set the folder up and open it. */
    create: (dir: string, answers: unknown) => call("create", String(dir), JSON.parse(JSON.stringify(answers ?? null))),
    cancel: (dir: string) => call("cancelSetup", String(dir)),
    onStart: (cb: (dir: string) => void) => void ipcRenderer.on("scribui:launcher:setup", (_e, dir) => cb(String(dir))),
  },
});
