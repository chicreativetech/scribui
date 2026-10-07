import { execFile } from "node:child_process";
import { app, BrowserWindow, dialog, Notification, shell } from "electron";
import { autoUpdater, type UpdateInfo } from "electron-updater";

/**
 * Updates from GitHub Releases (published drafts of release.yml). Where the
 * app can replace itself (Windows, a Linux AppImage, a Developer-ID-signed
 * Mac build) it downloads in the background and installs on restart or quit.
 * Elsewhere (an unsigned Mac build, a .deb, a development run) it only says
 * a new version is out, with a link to its release page.
 */

export const RELEASES = "https://github.com/chicreativetech/scribui/releases";

export type UpdateMode = { auto: true } | { auto: false; reason: string };

/** Whether this copy of the app can update itself, and why not. */
export function updateMode(o: { packaged: boolean; platform: NodeJS.Platform; appImage: boolean; macDeveloperId: boolean }): UpdateMode | null {
  if (!o.packaged) return null;
  if (o.platform === "win32") return { auto: true };
  if (o.platform === "linux")
    return o.appImage ? { auto: true } : { auto: false, reason: "Installed from a package: install the new one from the release page." };
  if (o.platform === "darwin")
    return o.macDeveloperId ? { auto: true } : { auto: false, reason: "This build isn't signed, so macOS can't update it in place: download the new one from the release page." };
  return null;
}

export type UpdateState =
  | { status: "off" }
  | { status: "idle" | "checking" | "none"; current: string }
  | { status: "available"; current: string; version: string; notes: string | null; url: string; auto: boolean; reason?: string }
  | { status: "downloading"; current: string; version: string; percent: number }
  | { status: "ready"; current: string; version: string; notes: string | null }
  | { status: "error"; current: string; message: string };

let state: UpdateState = { status: "off" };
let mode: UpdateMode | null = null;
const listeners = new Set<(s: UpdateState) => void>();

export const updateState = () => state;
export function onUpdateState(fn: (s: UpdateState) => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
function set(s: UpdateState) {
  state = s;
  for (const fn of listeners) fn(s);
}

const notesOf = (info: UpdateInfo): string | null => {
  const n = info.releaseNotes;
  if (!n) return null;
  return typeof n === "string" ? n : n.map((x) => x.note ?? "").join("\n\n");
};

/** Signed with a Developer ID (not ad hoc): what Squirrel.Mac needs to install an update. */
function macDeveloperId(): Promise<boolean> {
  const bundle = /^(.*?\.app)\//.exec(app.getAppPath() + "/")?.[1];
  if (!bundle) return Promise.resolve(false);
  return new Promise((done) =>
    execFile("codesign", ["-dv", "--verbose=2", bundle], { timeout: 10_000 }, (_err, _out, stderr) => done(/Authority=Developer ID Application/.test(String(stderr)))),
  );
}

const SIX_HOURS = 6 * 60 * 60 * 1000;

/** Start checking (packaged builds only): shortly after launch, then every six hours. */
export async function startUpdates() {
  mode = updateMode({
    packaged: app.isPackaged,
    platform: process.platform,
    appImage: !!process.env.APPIMAGE,
    macDeveloperId: process.platform === "darwin" && app.isPackaged ? await macDeveloperId() : false,
  });
  if (!mode) return;
  const current = app.getVersion();
  set({ status: "idle", current });
  autoUpdater.autoDownload = mode.auto;
  autoUpdater.autoInstallOnAppQuit = mode.auto;
  // its own console output would only repeat what the state says
  autoUpdater.logger = null;

  autoUpdater.on("checking-for-update", () => set({ status: "checking", current }));
  autoUpdater.on("update-not-available", () => set({ status: "none", current }));
  autoUpdater.on("update-available", (info) =>
    set({
      status: "available",
      current,
      version: info.version,
      notes: notesOf(info),
      url: `${RELEASES}/tag/v${info.version}`,
      auto: mode!.auto,
      ...(mode!.auto ? {} : { reason: (mode as { reason: string }).reason }),
    }),
  );
  autoUpdater.on("download-progress", (p) => {
    if (state.status === "available" || state.status === "downloading") set({ status: "downloading", current, version: state.version, percent: Math.round(p.percent) });
  });
  autoUpdater.on("update-downloaded", (info) => {
    set({ status: "ready", current, version: info.version, notes: notesOf(info) });
    if (Notification.isSupported())
      new Notification({ title: `ScribUI ${info.version} is ready`, body: "It installs when you quit ScribUI, or restart now from the menu." }).show();
  });
  autoUpdater.on("error", (e) => set({ status: "error", current, message: e.message.split("\n")[0]! }));

  const check = () => void autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 10_000);
  setInterval(check, SIX_HOURS).unref();
}

/** "Check for Updates…": check now and say what came of it. */
export async function checkNow(parent?: BrowserWindow | null) {
  const show = (o: Electron.MessageBoxOptions) => (parent ? dialog.showMessageBox(parent, o) : dialog.showMessageBox(o));
  if (!mode) {
    await show({ type: "info", message: "Updates are off in development builds.", detail: `Releases: ${RELEASES}` });
    return;
  }
  if (state.status === "ready") return offerRestart(parent);
  try {
    const r = await autoUpdater.checkForUpdates();
    const latest = r?.updateInfo.version;
    if (!r || !latest || !r.isUpdateAvailable) {
      await show({ type: "info", message: "ScribUI is up to date.", detail: `You have ${app.getVersion()}, the newest version.` });
      return;
    }
    if (mode.auto) {
      await show({ type: "info", message: `ScribUI ${latest} is downloading.`, detail: "It installs when you quit ScribUI; the menu offers a restart once it's ready." });
      return;
    }
    const { response } = await show({
      type: "info",
      message: `ScribUI ${latest} is out (you have ${app.getVersion()}).`,
      detail: `${mode.reason}${notesOf(r.updateInfo) ? `\n\n${notesOf(r.updateInfo)}` : ""}`,
      buttons: ["Open the Release Page", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) void shell.openExternal(`${RELEASES}/tag/v${latest}`);
  } catch (e) {
    const msg = (e as Error).message.split("\n")[0]!;
    // no published release yet: GitHub answers 404 for latest*.yml
    const none = /404|Cannot find latest|No published versions/i.test(msg);
    await show({ type: none ? "info" : "warning", message: none ? "ScribUI is up to date." : "Couldn't check for updates.", detail: none ? `No newer release at ${RELEASES}.` : msg });
  }
}

/** A downloaded update: restart into it now, or let it install at quit. */
export async function offerRestart(parent?: BrowserWindow | null) {
  if (state.status !== "ready") return;
  const o: Electron.MessageBoxOptions = {
    type: "info",
    message: `Restart to update to ScribUI ${state.version}?`,
    detail: `${state.notes ? `${state.notes}\n\n` : ""}Open projects reopen from the projects window. Otherwise it installs when you quit.`,
    buttons: ["Restart Now", "Later"],
    defaultId: 0,
    cancelId: 1,
  };
  const { response } = parent ? await dialog.showMessageBox(parent, o) : await dialog.showMessageBox(o);
  if (response === 0) installNow();
}

export function installNow() {
  if (state.status === "ready") autoUpdater.quitAndInstall();
}
