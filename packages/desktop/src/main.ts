import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, session, shell, webFrameMain, type WebContents } from "electron";
import { PRODUCT } from "@scribui/core";
import { ReviewStore } from "@scribui/server";
import { hostProject, makeRunner, saveCapturedView } from "@scribui/project";
import { captureFromCanvas, LIVE_FRAME, saveViaServer, type SaveView } from "./webCapture.js";

/**
 * ScribUI desktop, spike W: one window per project, the project's server
 * running inside the app, the canvas loaded from it, and web capture done by
 * the main process instead of a Playwright-controlled Chrome.
 */

/**
 * Render in sRGB, as Playwright does. Otherwise screenshots carry the display's
 * colour profile (Display P3 on most Macs) and their raw pixel values shift:
 * #00ff00 is stored as #75fb4c, which resvg and the agent read as is.
 * Chromium reads this switch before the app's code runs, so `appendSwitch` is
 * too late: relaunch once with it on the real command line.
 */
const SRGB = "--force-color-profile=srgb";
if (!process.argv.includes(SRGB)) {
  app.relaunch({ args: [...process.argv.slice(1), SRGB] });
  app.exit(0);
}

type Project = {
  store: ReviewStore;
  canvasOrigin: string;
  win: BrowserWindow;
  /** Views go through the project's owner: this app's server, or the one already running. */
  save: SaveView;
  /** Another process (the CLI) owns the project; this window shows its canvas. */
  guest: boolean;
  close(): Promise<void>;
};
const projects = new Map<number, Project>();

/** The built canvas (packages/canvas/dist) while running from the repo. */
const CANVAS_DIR = resolve(__dirname, "../../canvas/dist");

function projectDirFromArgs(argv = process.argv): string | null {
  const flag = argv.find((a) => a.startsWith("--project="));
  if (flag) return resolve(flag.slice("--project=".length));
  return process.env.SCRIBUI_PROJECT ? resolve(process.env.SCRIBUI_PROJECT) : null;
}

export async function openProject(dir: string): Promise<Project | null> {
  const store = new ReviewStore(dir);
  if (!store.exists()) {
    dialog.showErrorBox("Not a ScribUI project", `${dir} has no ${PRODUCT.folder} folder yet. Run "npx scribui" there once to set it up.`);
    return null;
  }
  const manifest = await store.readManifest();
  const hosted = await hostProject(store, {
    app: "desktop",
    server: {
      canvasDir: CANVAS_DIR,
      runner: makeRunner(store, { platform: manifest.app.platform }),
      saveView: (req) => saveCapturedView(store, req),
    },
  });
  if (hosted.kind === "no-port") {
    dialog.showErrorBox("No free port", "Every port ScribUI tries is in use.");
    return null;
  }
  // the CLI already runs this project: show its canvas, and save through it
  const guest = hosted.kind === "running";
  const ownerUrl = guest ? hosted.owner.url : null;
  if (guest && !ownerUrl) {
    dialog.showErrorBox("Project busy", "Another ScribUI process owns this project and isn't reachable.");
    return null;
  }
  const srv = hosted.kind === "owner" ? hosted.server : null;
  const port = srv ? srv.port : Number(new URL(ownerUrl!).port);
  // an app on localhost is shown from a localhost canvas: same-site, so its cookies work
  const base = manifest.app.baseUrl;
  const host = base && new URL(base).hostname === "localhost" ? "localhost" : "127.0.0.1";
  const canvasUrl = `http://${host}:${port}/`;
  const canvasOrigin = new URL(canvasUrl).origin;

  // one browser session per project: logins persist, projects stay apart
  const partition = `persist:project-${createHash("sha1").update(store.root).digest("hex").slice(0, 12)}`;
  hardenSession(partition);

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: `ScribUI · ${manifest.app.name}`,
    backgroundColor: "#d9d9d9",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      partition,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      spellcheck: false,
    },
  });
  const wc = win.webContents;

  // the canvas window only ever shows the canvas; links that open windows go to the system browser
  wc.on("will-navigate", (e, url) => {
    if (new URL(url).origin !== canvasOrigin) e.preventDefault();
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  reportLiveNavigation(wc);

  const project: Project = {
    store,
    canvasOrigin,
    win,
    guest,
    save: srv ? (req) => srv.saveView(req, "desktop") : saveViaServer(canvasUrl),
    close: async () => {
      projects.delete(wc.id);
      await srv?.close();
    },
  };
  projects.set(wc.id, project);
  win.on("closed", () => void project.close());
  await win.loadURL(canvasUrl);
  return project;
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

/** The canvas can't read a cross-origin frame's url; tell it where the embedded app went. */
function reportLiveNavigation(wc: WebContents) {
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

/** Only the canvas's own top frame may call into the main process. */
function senderProject(e: Electron.IpcMainInvokeEvent): Project {
  const p = projects.get(e.sender.id);
  const frame = e.senderFrame;
  if (!p || !frame || frame !== e.sender.mainFrame || new URL(frame.url).origin !== p.canvasOrigin) throw new Error("not allowed");
  return p;
}

ipcMain.handle("scribui:capture", async (e, req: { title?: string; replace?: string }) => {
  const p = senderProject(e);
  return captureFromCanvas(e.sender, { ...(req?.title ? { title: String(req.title) } : {}), ...(req?.replace ? { replace: String(req.replace) } : {}) }, p.save);
});

app.on("web-contents-created", (_e, contents) => {
  // no <webview>, ever
  contents.on("will-attach-webview", (ev) => ev.preventDefault());
});

app.whenReady().then(async () => {
  const dir = projectDirFromArgs();
  if (process.env.SCRIBUI_SPIKE === "android") {
    const { runAndroidSpike } = await import("./spikeAndroid.js");
    await runAndroidSpike();
    return;
  }
  if (process.env.SCRIBUI_SPIKE) {
    const { runSpike } = await import("./spike.js");
    await runSpike(dir);
    return;
  }
  if (dir) {
    await openProject(dir);
    return;
  }
  const pick = await dialog.showOpenDialog({ title: "Open a ScribUI project", properties: ["openDirectory"] });
  if (pick.canceled || !pick.filePaths[0]) return app.quit();
  await openProject(pick.filePaths[0]);
});

app.on("window-all-closed", () => app.quit());
