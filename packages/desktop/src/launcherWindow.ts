import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { detectTools } from "@scribui/capture";
import { openProject, openProjects, type OpenResult } from "./projectWindow.js";
import { refreshMenu } from "./menu.js";
import { RecentProjects } from "./recent.js";

/** The projects window: recent projects, "Open folder…" and the device tools found on this machine. */

let win: BrowserWindow | null = null;
export const recent = new RecentProjects(join(app.getPath("userData"), "recent.json"));

export function showLauncher() {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.focus();
    return win;
  }
  win = new BrowserWindow({
    width: 760,
    height: 640,
    minWidth: 520,
    minHeight: 420,
    title: "ScribUI",
    show: false,
    backgroundColor: "#ededed",
    webPreferences: {
      preload: join(__dirname, "launcherPreload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
    },
  });
  win.once("ready-to-show", () => win?.show());
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.on("closed", () => (win = null));
  void win.loadFile(join(__dirname, "launcher.html"));
  return win;
}

export const launcherOpen = () => !!win && !win.isDestroyed();
export const closeLauncher = () => win?.close();

/** The project list changed (a project opened or closed): refresh the window. */
export function launcherChanged() {
  if (win && !win.isDestroyed()) win.webContents.send("scribui:launcher:changed");
}

/** Open a project from anywhere (the window, a link, the menu), remembering it. Closes the projects window once it's open. */
export async function openAndRemember(dir: string): Promise<OpenResult> {
  const r = await openProject(dir, {
    onOpened: (p) => {
      recent.add({ dir: p.store.root, name: p.name, platform: p.platform });
      app.addRecentDocument(p.store.root);
      refreshMenu();
      p.win.on("closed", launcherChanged);
    },
  });
  if (r.ok) {
    launcherChanged();
    closeLauncher();
  }
  return r;
}

/** "Open Folder…": pick a folder and open it; null when canceled. */
export async function pickAndOpen(parent: BrowserWindow | null): Promise<{ dir: string; result: OpenResult } | null> {
  const opts = { title: "Open a ScribUI project", buttonLabel: "Open", properties: ["openDirectory" as const] };
  const pick = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
  const dir = pick.filePaths[0];
  if (pick.canceled || !dir) return null;
  return { dir, result: await openAndRemember(dir) };
}

/** Opening failed somewhere the projects window can't show it. */
export function explainFailure(r: OpenResult) {
  if (!r.ok) dialog.showErrorBox("Can't open the project", `${r.error}${r.hint ? `\n\n${r.hint}` : ""}`);
}

const display = (dir: string) => {
  const home = homedir();
  return dir === home || dir.startsWith(home + "/") || dir.startsWith(home + "\\") ? `~${dir.slice(home.length)}` : dir;
};

function fromLauncher(e: IpcMainEvent | IpcMainInvokeEvent) {
  if (!win || e.sender !== win.webContents || e.senderFrame !== win.webContents.mainFrame) throw new Error("not allowed");
}

export function registerLauncherApi() {
  const handle = (name: string, fn: (...args: unknown[]) => unknown) =>
    ipcMain.handle(`scribui:launcher:${name}`, (e, ...args: unknown[]) => {
      fromLauncher(e);
      return fn(...args);
    });

  ipcMain.on("scribui:launcher:info", (e) => {
    e.returnValue = { version: app.getVersion() };
  });
  handle("list", () => {
    const open = new Set(openProjects().map((p) => p.store.root));
    return recent.list().map((p) => ({ ...p, exists: existsSync(p.dir), open: open.has(p.dir), display: display(p.dir) }));
  });
  handle("open", async (dir) => {
    // only folders the list already holds; others come through the folder picker
    if (typeof dir !== "string" || !recent.list().some((p) => p.dir === dir)) return { ok: false, error: "not in the list" };
    return result(await openAndRemember(dir), dir);
  });
  handle("pick", async () => {
    const picked = await pickAndOpen(win);
    return picked ? result(picked.result, picked.dir) : { ok: false, canceled: true };
  });
  handle("remove", (dir) => {
    if (typeof dir === "string") recent.remove(dir);
    return null;
  });
  handle("tools", () => detectTools());
  handle("copy", (text) => {
    if (typeof text === "string") clipboard.writeText(text);
  });
  handle("openLink", (url) => {
    if (typeof url === "string" && /^https:\/\//.test(url)) void shell.openExternal(url);
  });
}

/** What the window needs of an open result (the project itself stays in the main process). */
const result = (r: OpenResult, dir: string) => (r.ok ? { ok: true } : { ok: false, error: r.error, ...(r.hint ? { hint: r.hint } : {}), dir });
