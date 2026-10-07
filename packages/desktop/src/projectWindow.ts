import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain, session, shell, webFrameMain, type WebContents } from "electron";
import { detectTools } from "@scribui/capture";
import { PRODUCT, type Platform } from "@scribui/core";
import { ReviewStore } from "@scribui/server";
import { hostProject, makeRunner, saveCapturedView } from "@scribui/project";
import { liveInput } from "./deviceInput.js";
import { DeviceView } from "./deviceView.js";
import type { Rect, Size } from "./liveLayout.js";
import { LiveView } from "./liveView.js";
import { captureFromCanvas, LIVE_FRAME, saveViaServer, type SaveView } from "./webCapture.js";

/**
 * One window per project: the project's server runs inside the app (or the
 * CLI's server is used when it already owns the project), the window shows
 * the canvas from it, and the reviewed web app gets its own view on top of
 * the canvas's app tab.
 */

export type Project = {
  store: ReviewStore;
  name: string;
  platform: Platform;
  canvasOrigin: string;
  win: BrowserWindow;
  /** Views go through the project's owner: this app's server, or the one already running. */
  save: SaveView;
  /** Another process (the CLI) owns the project; this window shows its canvas. */
  guest: boolean;
  /** "view": the app in its own view (the product); "iframe": inside the canvas (spike W's harness). */
  surface: "view" | "iframe";
  live: LiveView;
  /** Mobile projects: the device tab's live session. */
  device: DeviceView | null;
  close(): Promise<void>;
};

export type OpenResult = { ok: true; project: Project } | { ok: false; error: string; hint?: string };

const byWindow = new Map<number, Project>();
const byDir = new Map<string, Project>();
const opening = new Map<string, Promise<OpenResult>>();

/** The built canvas: next to the app when packaged, packages/canvas/dist from the repo. */
const CANVAS_DIR = app.isPackaged ? join(process.resourcesPath, "canvas") : resolve(__dirname, "../../canvas/dist");

export const openProjects = () => [...byDir.values()];

/** Open a project's window, or bring it forward when it's open already. */
export function openProject(dir: string, opts: { surface?: Project["surface"]; onOpened?: (p: Project) => void } = {}): Promise<OpenResult> {
  const root = resolve(dir);
  const open = byDir.get(root);
  if (open && !open.win.isDestroyed()) {
    if (open.win.isMinimized()) open.win.restore();
    open.win.focus();
    return Promise.resolve({ ok: true, project: open });
  }
  // a second request while the first is still starting the server
  const pending = opening.get(root);
  if (pending) return pending;
  const p = createProject(root, opts).finally(() => opening.delete(root));
  opening.set(root, p);
  return p;
}

async function createProject(root: string, opts: { surface?: Project["surface"]; onOpened?: (p: Project) => void }): Promise<OpenResult> {
  if (!existsSync(root)) return { ok: false, error: `${root} doesn't exist (moved or deleted?)` };
  const store = new ReviewStore(root);
  if (!store.exists())
    return { ok: false, error: `${root} isn't a ScribUI project yet.`, hint: `Set it up once from a terminal in that folder: npx scribui` };
  let manifest;
  try {
    manifest = await store.readManifest();
  } catch (e) {
    return { ok: false, error: `${PRODUCT.folder}/screens.json can't be read: ${(e as Error).message.split("\n")[0]}` };
  }
  const hosted = await hostProject(store, {
    app: "desktop",
    server: {
      canvasDir: CANVAS_DIR,
      runner: makeRunner(store, { platform: manifest.app.platform }),
      saveView: (req) => saveCapturedView(store, req),
    },
  });
  if (hosted.kind === "no-port") return { ok: false, error: "Every port ScribUI tries is in use." };
  // the CLI already runs this project: show its canvas, and save through it
  const guest = hosted.kind === "running";
  const ownerUrl = guest ? hosted.owner.url : null;
  if (guest && !ownerUrl) return { ok: false, error: "Another ScribUI process owns this project and isn't reachable." };
  const srv = hosted.kind === "owner" ? hosted.server : null;
  const port = srv ? srv.port : Number(new URL(ownerUrl!).port);
  const surface = opts.surface ?? "view";
  // with the app in the canvas's iframe, a localhost app needs a localhost canvas (same-site cookies)
  const base = manifest.app.baseUrl;
  const host = surface === "iframe" && base && new URL(base).hostname === "localhost" ? "localhost" : "127.0.0.1";
  const canvasUrl = `http://${host}:${port}/`;
  const canvasOrigin = new URL(canvasUrl).origin;

  // one browser session per project for the app: logins persist, projects stay apart
  const id = createHash("sha1").update(store.root).digest("hex").slice(0, 12);
  const appPartition = surface === "iframe" ? `persist:project-${id}` : `persist:app-${id}`;
  hardenSession(appPartition);

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    title: `${manifest.app.name} · ScribUI`,
    backgroundColor: "#d9d9d9",
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      // the iframe path shares the app's session; the canvas otherwise keeps its own
      partition: surface === "iframe" ? appPartition : "persist:scribui-canvas",
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      spellcheck: false,
    },
  });
  win.once("ready-to-show", () => win.show());
  // the window keeps the project's name, not the canvas page's title
  win.on("page-title-updated", (e) => e.preventDefault());
  const wc = win.webContents;

  // the canvas window only ever shows the canvas; links that open windows go to the system browser
  wc.on("will-navigate", (e, url) => {
    if (new URL(url).origin !== canvasOrigin) e.preventDefault();
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  if (surface === "iframe") reportFrameNavigation(wc);

  const live = new LiveView(win, appPartition, (state) => {
    if (!wc.isDestroyed()) wc.send("scribui:live-state", state);
  });
  const project: Project = {
    store,
    name: manifest.app.name,
    platform: manifest.app.platform,
    canvasOrigin,
    win,
    guest,
    surface,
    live,
    device: manifest.app.platform === "web" ? null : new DeviceView(wc, manifest.app.platform),
    save: srv ? (req) => srv.saveView(req, "desktop") : saveViaServer(canvasUrl),
    close: async () => {
      byWindow.delete(wc.id);
      if (byDir.get(store.root) === project) byDir.delete(store.root);
      live.dispose();
      project.device?.dispose();
      await srv?.close();
    },
  };
  byWindow.set(wc.id, project);
  byDir.set(store.root, project);
  win.on("closed", () => void project.close());
  // the canvas lost its server (the CLI that owned the project stopped): say so instead of a blank window
  wc.on("did-fail-load", (_e, code, desc, url, isMain) => {
    if (isMain && code !== -3) void dialog.showMessageBox(win, { type: "error", message: "The canvas couldn't load", detail: `${url}: ${desc}` });
  });
  await win.loadURL(canvasUrl);
  opts.onOpened?.(project);
  void warnMissingTools(project);
  return { ok: true, project };
}

/** Opening a mobile project without the tools its capture needs: say what's missing and how to get it. */
async function warnMissingTools(p: Project) {
  if (p.platform === "web") return;
  const missing = (await detectTools()).filter((t) => t.required && !t.ok && t.platforms.includes(p.platform));
  if (!missing.length || p.win.isDestroyed()) return;
  const commands = missing.map((t) => t.install?.command).filter((c): c is string => !!c);
  const { response } = await dialog.showMessageBox(p.win, {
    type: "warning",
    message: `${p.platform === "ios" ? "iOS" : "Android"} capture needs ${missing.map((t) => t.name).join(" and ")}`,
    detail: missing.map((t) => `${t.name}: ${t.detail}${t.install?.command ? `\nInstall: ${t.install.command}` : ""}`).join("\n\n"),
    buttons: commands.length ? ["Copy install command", "Later"] : ["OK"],
    defaultId: 0,
    cancelId: commands.length ? 1 : 0,
  });
  if (commands.length && response === 0) clipboard.writeText(commands.join("\n"));
}

/** The reviewed app gets no special powers: no permissions beyond the clipboard and fullscreen. */
const hardened = new Set<string>();
function hardenSession(partition: string) {
  if (hardened.has(partition)) return;
  hardened.add(partition);
  const s = session.fromPartition(partition);
  const allowed = new Set(["clipboard-sanitized-write", "clipboard-read", "fullscreen"]);
  s.setPermissionRequestHandler((_wc, permission, done) => done(allowed.has(permission)));
  s.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
}

/** Iframe path: the canvas can't read a cross-origin frame's url; tell it where the embedded app went. */
function reportFrameNavigation(wc: WebContents) {
  const tell = (url: string, pid: number, rid: number) => {
    const f = webFrameMain.fromId(pid, rid);
    if (!f || f.parent !== wc.mainFrame || f.name !== LIVE_FRAME) return;
    void wc.mainFrame.executeJavaScript(`window.dispatchEvent(new CustomEvent("scribui:live-url", { detail: ${JSON.stringify(url)} }))`).catch(() => {});
  };
  wc.on("did-frame-navigate", (_e, url, _code, _status, isMain, pid, rid) => {
    if (!isMain) tell(url, pid, rid);
  });
  wc.on("did-navigate-in-page", (_e, url, isMain, pid, rid) => {
    if (!isMain) tell(url, pid, rid);
  });
}

/* ─────────────────────────── canvas API ─────────────────────────── */

type Sender = { sender: WebContents; senderFrame: Electron.WebFrameMain | null };

/** Only the canvas's own top frame may call into the main process. */
function senderProject(e: Sender): Project {
  const p = byWindow.get(e.sender.id);
  const frame = e.senderFrame;
  if (!p || !frame || frame !== e.sender.mainFrame || new URL(frame.url).origin !== p.canvasOrigin) throw new Error("not allowed");
  return p;
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
function rect(v: unknown): Rect | null {
  const r = v as Record<string, unknown> | null;
  const x = num(r?.x), y = num(r?.y), width = num(r?.width), height = num(r?.height);
  return x === null || y === null || width === null || height === null || width <= 0 || height <= 0 ? null : { x, y, width, height };
}
function size(v: unknown): Size | null {
  const r = v as Record<string, unknown> | null;
  const width = num(r?.width), height = num(r?.height);
  return width && height && width > 0 && height > 0 && width <= 10_000 && height <= 10_000 ? { width, height } : null;
}

export function registerCanvasApi() {
  ipcMain.on("scribui:config", (e) => {
    try {
      const p = senderProject(e);
      e.returnValue = { surface: p.surface, device: p.device ? p.platform : null };
    } catch {
      e.returnValue = { surface: null, device: null };
    }
  });

  ipcMain.handle("scribui:capture", async (e, req: { title?: unknown; replace?: unknown }) => {
    const p = senderProject(e);
    const r = { ...(str(req?.title) ? { title: str(req?.title) } : {}), ...(str(req?.replace) ? { replace: str(req?.replace) } : {}) };
    return p.surface === "view" ? p.live.capture(r, p.save) : captureFromCanvas(e.sender, r, p.save);
  });

  ipcMain.on("scribui:live-place", (e, area: unknown, sz: unknown) => {
    try {
      senderProject(e).live.place(rect(area), size(sz));
    } catch {
      /* not the canvas */
    }
  });

  registerDeviceApi();

  ipcMain.handle("scribui:live-go", (e, action: unknown, url: unknown) => {
    const live = senderProject(e).live;
    if (action === "navigate" && typeof url === "string") live.navigate(url);
    else if (action === "reload") live.reload();
    else if (action === "back") live.back();
    else if (action === "forward") live.forward();
    else if (action === "devtools") live.openDevTools();
  });
}

/* ─────────────────────────── device tab ─────────────────────────── */

function senderDevice(e: Sender): { p: Project; device: DeviceView } {
  const p = senderProject(e);
  if (!p.device) throw new Error("this project has no device view");
  return { p, device: p.device };
}

function registerDeviceApi() {
  const quiet = (fn: () => void) => {
    try {
      fn();
    } catch {
      /* not the canvas, or no device view */
    }
  };
  ipcMain.handle("scribui:device-state", (e) => senderDevice(e).device.getState());
  ipcMain.handle("scribui:device-list", (e) => senderDevice(e).device.list());
  ipcMain.handle("scribui:device-connect", (e, id: unknown) => {
    if (typeof id !== "string" || !/^[\w.:\-]{1,128}$/.test(id)) throw new Error("bad device id");
    return senderDevice(e).device.connect(id);
  });
  ipcMain.handle("scribui:device-disconnect", (e) => senderDevice(e).device.disconnect());
  ipcMain.handle("scribui:device-emulator", (e, avd: unknown) => {
    if (typeof avd !== "string" || !/^[\w.\-]{1,128}$/.test(avd)) throw new Error("bad emulator name");
    return senderDevice(e).device.startEmulator(avd);
  });
  ipcMain.on("scribui:device-visible", (e, v: unknown) => quiet(() => senderDevice(e).device.setVisible(v === true)));
  ipcMain.on("scribui:device-reset", (e) => quiet(() => senderDevice(e).device.resetVideo()));
  ipcMain.on("scribui:device-input", (e, v: unknown) =>
    quiet(() => {
      const ev = liveInput(v);
      if (ev) void senderDevice(e).device.input(ev).catch(() => {});
    }),
  );
  ipcMain.handle("scribui:device-capture", (e, req: { title?: unknown; replace?: unknown }) => {
    const { p, device } = senderDevice(e);
    return device.capture({ ...(str(req?.title) ? { title: str(req?.title) } : {}), ...(str(req?.replace) ? { replace: str(req?.replace) } : {}) }, p.save);
  });
  ipcMain.handle("scribui:device-keep", (e) => {
    const { p, device } = senderDevice(e);
    return device.keep(p.save);
  });
  ipcMain.on("scribui:device-discard", (e) => quiet(() => senderDevice(e).device.discard()));
  ipcMain.on("scribui:device-cancel", (e) => quiet(() => senderDevice(e).device.cancelCapture()));
}
