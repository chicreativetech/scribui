import { resolve } from "node:path";
import { app, BrowserWindow } from "electron";
import { closeLauncher, explainFailure, launcherOpen, openAndRemember, registerLauncherApi, showLauncher } from "./launcherWindow.js";
import { cancelAllInstalls } from "./installs.js";
import { buildMenu } from "./menu.js";
import { findOpenUrl, parseOpenUrl, PROTOCOL } from "./openUrl.js";
import { openProjects, registerCanvasApi } from "./projectWindow.js";
import { loadShellPath } from "./shellPath.js";

/**
 * ScribUI desktop: a projects window, one window per project with the
 * project's server inside the app, the reviewed web app in its own view.
 * The CLI opens projects here with `scribui://open?dir=…`.
 */

/**
 * Render in sRGB, as Playwright does. Otherwise screenshots carry the display's
 * colour profile (Display P3 on most Macs) and their raw pixel values shift:
 * #00ff00 is stored as #75fb4c, which resvg and the agent read as is.
 * Chromium reads this switch before the app's code runs, so `appendSwitch` is
 * too late: relaunch once with it on the real command line.
 */
const SRGB = "--force-color-profile=srgb";

/** A spike or fidelity harness runs instead of the app (no projects window, quits when done). */
const harness = !!(process.env.SCRIBUI_SPIKE || process.env.SCRIBUI_FIDELITY);

if (!process.argv.includes(SRGB)) relaunchInSrgb();
else run();

/**
 * The first process only hands over: to an instance that already runs (which
 * gets our arguments), or to its sRGB relaunch. macOS delivers a link that
 * started the app as an `open-url` event, so links are collected until the
 * app is ready and passed on the relaunch's command line.
 */
function relaunchInSrgb() {
  if (!app.requestSingleInstanceLock()) return app.exit(0);
  const links: string[] = [];
  app.on("open-url", (e, url) => {
    e.preventDefault();
    links.push(url);
  });
  void app.whenReady().then(() => {
    app.releaseSingleInstanceLock();
    app.relaunch({ args: [...process.argv.slice(1), SRGB, ...links] });
    app.exit(0);
  });
}

function projectFromArgs(argv: string[]): string | null {
  const flag = argv.find((a) => a.startsWith("--project="));
  if (flag) return resolve(flag.slice("--project=".length));
  return findOpenUrl(argv);
}

let quitting = false;

function run() {
  if (!app.requestSingleInstanceLock()) return app.exit(0);

  const open = (dir: string) => {
    if (app.isReady()) void openAndRemember(dir).then(explainFailure);
    else pending.push(dir);
  };
  const pending: string[] = [];

  // a second launch (the CLI's link on Windows and Linux, or the app started again)
  app.on("second-instance", (_e, argv) => {
    const dir = projectFromArgs(argv);
    if (dir) open(dir);
    else if (!openProjects().length) showLauncher();
    else openProjects()[0]!.win.focus();
  });
  // links on macOS
  app.on("open-url", (e, url) => {
    e.preventDefault();
    const dir = parseOpenUrl(url);
    if (dir) open(dir);
  });

  app.on("web-contents-created", (_e, contents) => {
    // no <webview>, ever
    contents.on("will-attach-webview", (ev) => ev.preventDefault());
  });

  // the last project window closed: back to the projects window
  app.on("browser-window-created", (_e, win) => {
    win.on("closed", () => {
      setTimeout(() => {
        if (quitting || launcherOpen() || BrowserWindow.getAllWindows().length) return;
        if (harness) return;
        showLauncher();
      }, 0);
    });
  });
  app.on("before-quit", () => {
    quitting = true;
    cancelAllInstalls();
  });
  // only reached when the projects window itself was closed with no project open
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin" || harness) app.quit();
  });
  app.on("activate", () => {
    if (!BrowserWindow.getAllWindows().length) showLauncher();
  });

  void app.whenReady().then(async () => {
    if (process.env.SCRIBUI_SPIKE === "android") {
      const { runAndroidSpike } = await import("./spikeAndroid.js");
      return runAndroidSpike();
    }
    await loadShellPath();
    registerCanvasApi();
    if (process.env.SCRIBUI_FIDELITY === "web") {
      const { runWebFidelity } = await import("./fidelity/web.js");
      return runWebFidelity();
    }
    if (process.env.SCRIBUI_SPIKE) {
      const { runSpike } = await import("./spike.js");
      return runSpike(projectFromArgs(process.argv) ?? (process.env.SCRIBUI_PROJECT ? resolve(process.env.SCRIBUI_PROJECT) : null));
    }
    registerLauncherApi();
    buildMenu();
    // packaged builds declare the scheme at install time; this also covers a moved app
    if (app.isPackaged || process.env.SCRIBUI_REGISTER_PROTOCOL === "1") {
      if (app.isPackaged) app.setAsDefaultProtocolClient(PROTOCOL);
      else app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [resolve(process.argv[1] ?? ".")]);
    }

    const first = projectFromArgs(process.argv) ?? (process.env.SCRIBUI_PROJECT ? resolve(process.env.SCRIBUI_PROJECT) : null);
    const dirs = [...(first ? [first] : []), ...pending.splice(0)];
    if (!dirs.length) return void showLauncher();
    const results = await Promise.all(dirs.map((d) => openAndRemember(d)));
    for (const r of results) explainFailure(r);
    if (!results.some((r) => r.ok)) showLauncher();
    else if (!results.some((r) => !r.ok && "setup" in r)) closeLauncher();
  });
}
