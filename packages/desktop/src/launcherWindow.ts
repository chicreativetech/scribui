import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { detectTools, installEnv, playwrightStatus, type ToolStatus } from "@scribui/capture";
import type { Platform } from "@scribui/core";
import { reachable } from "@scribui/project";
import { ReviewStore } from "@scribui/server";
import { cancelInstall, installTool, isInstallable } from "./installs.js";
import { openProject, openProjects, type OpenOptions, type OpenResult } from "./projectWindow.js";
import { refreshMenu } from "./menu.js";
import { RecentProjects } from "./recent.js";
import { checkNow, installNow, onUpdateState, updateState } from "./updates.js";
import { checkAnswers, createProject, deviceReady, devServers, normalizeUrl, screensState, setupInfo } from "./setup.js";

/**
 * The projects window: recent projects, "Open folder…", the capture tools
 * found on this machine (installed from here when the app can), and the
 * setup of a folder that isn't a ScribUI project yet.
 */

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
  // a setup asked for before the page loaded starts once it has
  win.webContents.once("did-finish-load", () => {
    if (pendingSetup && win) win.webContents.send("scribui:launcher:setup", pendingSetup);
    pendingSetup = null;
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.on("closed", () => {
    win = null;
    setupDirs.clear();
  });
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
export async function openAndRemember(dir: string, extra: Pick<OpenOptions, "captureFirst"> = {}): Promise<OpenResult> {
  const r = await openProject(dir, {
    ...extra,
    onOpened: (p) => {
      recent.add({ dir: p.store.root, name: p.name, platform: p.platform });
      app.addRecentDocument(p.store.root);
      refreshMenu();
      p.win.on("closed", launcherChanged);
    },
  });
  if (r.ok) {
    launcherChanged();
    // keep the window while it's setting up another folder
    setupDirs.delete(r.project.store.root);
    if (!setupDirs.size) closeLauncher();
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

/** Opening failed somewhere the projects window can't show it; a folder that isn't set up goes to setup instead. */
export function explainFailure(r: OpenResult) {
  if (r.ok) return;
  if ("setup" in r) return startSetup(r.dir);
  dialog.showErrorBox("Can't open the project", `${r.error}${r.hint ? `\n\n${r.hint}` : ""}`);
}

/* ─────────────────────────── setup ─────────────────────────── */

/** Folders the user chose that the window may set up; the window can't name others. */
const setupDirs = new Set<string>();
let pendingSetup: string | null = null;

/** Walk through setting up `dir` in the projects window. */
export function startSetup(dir: string) {
  setupDirs.add(dir);
  const w = showLauncher();
  if (w.webContents.isLoading()) pendingSetup = dir;
  else w.webContents.send("scribui:launcher:setup", dir);
}

function setupDir(dir: unknown): string {
  if (typeof dir !== "string" || !setupDirs.has(dir)) throw new Error("not a folder being set up");
  return dir;
}

/** The tools a platform's capture uses, found or not (Playwright for the web, which only rounds use). */
async function toolsFor(platform: Platform, dir?: string): Promise<ToolStatus[]> {
  const env = await installEnv();
  if (platform === "web") return [await playwrightStatus(dir, env)];
  return (await detectTools(process.platform, env)).filter((t) => t.platforms.includes(platform));
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
    const r = await openAndRemember(dir);
    // its .scribui folder is gone: set it up again
    if (!r.ok && "setup" in r) setupDirs.add(r.dir);
    return result(r, dir);
  });
  handle("pick", async () => {
    const picked = await pickAndOpen(win);
    if (picked && !picked.result.ok && "setup" in picked.result) setupDirs.add(picked.result.dir);
    return picked ? result(picked.result, picked.dir) : { ok: false, canceled: true };
  });
  handle("remove", (dir) => {
    if (typeof dir === "string") recent.remove(dir);
    return null;
  });
  handle("update", () => updateState());
  handle("updateAction", (action) => {
    if (action === "install") installNow();
    else if (action === "check") void checkNow(win);
    else if (action === "open") {
      const st = updateState();
      if (st.status === "available") void shell.openExternal(st.url);
    }
  });
  onUpdateState((st) => {
    if (win && !win.isDestroyed()) win.webContents.send("scribui:launcher:update", st);
  });
  handle("tools", async () => {
    const env = await installEnv();
    return [...(await detectTools(process.platform, env)), await playwrightStatus(undefined, env)];
  });
  handle("install", (id) => {
    if (!isInstallable(id)) throw new Error("unknown tool");
    return installTool(id, (line) => {
      if (win && !win.isDestroyed()) win.webContents.send("scribui:launcher:install-log", { id, line });
    });
  });
  handle("cancelInstall", (id) => {
    if (isInstallable(id)) cancelInstall(id);
  });

  // setup of a folder that isn't a project yet
  handle("setupInfo", (dir) => {
    const d = setupDir(dir);
    return { ...setupInfo(d), display: display(d) };
  });
  handle("servers", (dir) => devServers(setupDir(dir)));
  handle("checkUrl", async (url) => {
    const u = normalizeUrl(url);
    return { url: u, running: u ? await reachable(u) : false };
  });
  handle("setupTools", (dir, platform) => {
    if (platform !== "web" && platform !== "android" && platform !== "ios") throw new Error("bad platform");
    return toolsFor(platform, setupDir(dir));
  });
  handle("create", async (dir, answers) => {
    const d = setupDir(dir);
    const checked = checkAnswers(answers);
    if (!checked.ok) return checked;
    const store = new ReviewStore(d);
    if (store.exists()) return { ok: false, error: `${d} has been set up meanwhile; open it from the list.` };
    try {
      const r = await createProject(store, setupInfo(d).name, checked.answers);
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
  handle("screens", (dir) => screensState(new ReviewStore(setupDir(dir))));
  handle("deviceReady", (platform) => (platform === "android" || platform === "ios" ? deviceReady(platform) : false));
  handle("finish", async (dir, capture) => {
    const d = setupDir(dir);
    // the first round needs a device to run on; without one the board waits for a capture
    let captureFirst = false;
    if (capture === true) {
      const platform = await new ReviewStore(d)
        .readManifest()
        .then((m) => m.app.platform)
        .catch(() => null);
      captureFirst = !!platform && platform !== "web" && (await deviceReady(platform));
    }
    const r = await openAndRemember(d, { captureFirst });
    if (r.ok) setupDirs.delete(d);
    return result(r, d);
  });
  handle("cancelSetup", (dir) => {
    if (typeof dir === "string") setupDirs.delete(dir);
  });
  handle("copy", (text) => {
    if (typeof text === "string") clipboard.writeText(text);
  });
  handle("openLink", (url) => {
    if (typeof url === "string" && /^https:\/\//.test(url)) void shell.openExternal(url);
  });
}

/** What the window needs of an open result (the project itself stays in the main process). */
const result = (r: OpenResult, dir: string) =>
  r.ok ? { ok: true } : "setup" in r ? { ok: false, setup: true, error: r.error, dir } : { ok: false, error: r.error, ...(r.hint ? { hint: r.hint } : {}), dir };
