import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, parse, resolve } from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { detectTools, installEnv, playwrightStatus, type ToolStatus } from "@scribui/capture";
import { HANDOFF_DIR, NEW_PROJECT_MAX, newProjectPrompt, PRODUCT, validAck, type Platform } from "@scribui/core";
import { reachable } from "@scribui/project";
import { ReviewStore } from "@scribui/server";
import { cancelInstall, installTool, isInstallable } from "./installs.js";
import { openProject, openProjects, type OpenResult } from "./projectWindow.js";
import { refreshMenu } from "./menu.js";
import { RecentProjects } from "./recent.js";
import { checkNow, installNow, onUpdateState, updateState } from "./updates.js";
import { checkAnswers, createProject, devServers, normalizeUrl, setupInfo } from "./setup.js";

/**
 * The projects window: recent projects, "Open app folder…", the capture tools
 * found on this machine (installed from here when the app can), the
 * setup of a folder that isn't a ScribUI project yet, and new projects: a
 * folder and a description become a prompt for the user's agent.
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
  // a setup or new project asked for before the page loaded starts once it has
  win.webContents.once("did-finish-load", () => {
    for (const [channel, dir] of pendingStarts.splice(0)) win?.webContents.send(channel, dir);
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.on("closed", () => {
    win = null;
    setupDirs.clear();
    newDirs.clear();
    pendingStarts.length = 0;
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
    // keep the window while it's setting up another folder or starting a new project
    setupDirs.delete(r.project.store.root);
    if (!setupDirs.size && !newDirs.size) closeLauncher();
  }
  return r;
}

/** "Open App Folder…": pick a folder and open it; null when canceled. */
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
/** Messages for the window that wait until its page has loaded. */
const pendingStarts: [channel: string, dir: string][] = [];

function sendToLauncher(channel: string, dir: string) {
  const w = showLauncher();
  if (w.webContents.isLoading()) pendingStarts.push([channel, dir]);
  else w.webContents.send(channel, dir);
}

/** Walk through setting up `dir` in the projects window. */
export function startSetup(dir: string) {
  setupDirs.add(dir);
  sendToLauncher("scribui:launcher:setup", dir);
}

/* ─────────────────────────── new projects ─────────────────────────── */

/** Folders the user chose for a new project (picked, or from `scribui new`); the window can't name others. */
const newDirs = new Set<string>();

/** Open the new-project dialog with `dir` filled in; `ack` tells the CLI that sent the link that the app took it. */
export function startNewProject(dir: string, ack?: string) {
  newDirs.add(dir);
  sendToLauncher("scribui:launcher:new", dir);
  if (!validAck(ack)) return;
  try {
    const at = join(homedir(), PRODUCT.folder, HANDOFF_DIR);
    mkdirSync(at, { recursive: true });
    writeFileSync(join(at, ack), "");
  } catch {
    /* the CLI falls back to asking in the terminal */
  }
}

function newDir(dir: unknown): string {
  if (typeof dir !== "string" || !newDirs.has(dir)) throw new Error("not a folder chosen for a new project");
  return dir;
}

/**
 * What the dialog says about a folder: it doesn't exist yet (it's created),
 * it holds files, or it's a project already. `blocked`: no app goes there.
 */
function newDirInfo(dir: string) {
  const info = { dir, display: display(dir), name: basename(dir) || dir, exists: false, files: 0, project: false, blocked: false, warning: null as string | null };
  const root = resolve(dir);
  const block = (warning: string) => ({ ...info, blocked: true, warning });
  if (root === resolve(homedir())) return block("This is your home folder. Choose or create a folder for the new app.");
  if (root === parse(root).root) return block("This is the root of a drive. Choose or create a folder for the new app.");
  try {
    if (!statSync(dir).isDirectory()) return block(`${info.display} is a file, not a folder.`);
    info.exists = true;
    // dotfiles (.git, .DS_Store) don't make a folder taken
    info.files = readdirSync(dir).filter((f) => !f.startsWith(".")).length;
    info.project = existsSync(join(dir, PRODUCT.folder));
  } catch {
    /* doesn't exist yet: created on send */
  }
  if (!info.warning && info.project) info.warning = "This folder is a ScribUI project already. Your agent will add to the app that's there.";
  else if (!info.warning && info.files) info.warning = `This folder isn't empty (${info.files} ${info.files === 1 ? "item" : "items"}). Your agent may change or replace what's there.`;
  return info;
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
      const created = await createProject(store, setupInfo(d).name, checked.answers);
      // open it right away: screens are captured by hand there (App or Device tab)
      const r = await openAndRemember(d);
      if (r.ok) setupDirs.delete(d);
      return { ...result(r, d), created };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
  // new projects
  handle("newPick", async (current) => {
    const opts = {
      title: "Choose a folder for the new app",
      buttonLabel: "Choose",
      ...(typeof current === "string" && isAbsolute(current) ? { defaultPath: current } : {}),
      properties: ["openDirectory" as const, "createDirectory" as const, "promptToCreate" as const],
    };
    const pick = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    const dir = pick.filePaths[0];
    if (pick.canceled || !dir) return null;
    newDirs.add(dir);
    return newDirInfo(dir);
  });
  handle("newInfo", (dir) => newDirInfo(newDir(dir)));
  handle("newSend", async (dir, description) => {
    const d = newDir(dir);
    const text = typeof description === "string" ? description.trim() : "";
    if (!text) return { ok: false, error: "Describe your project first." };
    if (text.length > NEW_PROJECT_MAX) return { ok: false, error: `The description is too long (at most ${NEW_PROJECT_MAX.toLocaleString("en")} characters).` };
    const info = newDirInfo(d);
    if (info.blocked) return { ok: false, error: info.warning };
    try {
      // the agent builds in it; the list shows it until it's set up
      await mkdir(d, { recursive: true });
    } catch (e) {
      return { ok: false, error: `Can't create ${info.display}: ${(e as Error).message}` };
    }
    if (!info.project) {
      recent.add({ dir: d, name: info.name, platform: null });
      refreshMenu();
    }
    const prompt = newProjectPrompt(d, text);
    clipboard.writeText(prompt);
    return { ok: true, prompt };
  });
  handle("newClose", (dir) => {
    if (typeof dir === "string") newDirs.delete(dir);
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
