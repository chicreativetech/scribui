import { spawn } from "node:child_process";
import { emitKeypressEvents } from "node:readline";
import { Platform, PRODUCT, ScreenManifest, screensPrompt } from "@scribui/core";
import type { ReviewStore } from "@scribui/server";
import { captureProject, hostProject, makeRunner, portRange, saveCapturedView, type CaptureEvent } from "@scribui/project";
import { input, interactive, select, waitFor } from "./prompts.js";
import { openLiveWindow, type LiveWindow } from "./live.js";
import {
  BETA,
  copyToClipboard,
  DEV_PORTS,
  detectDevServers,
  detectProject,
  ensureAndroid,
  ensureIos,
  ensureWebTools,
  type ProjectInfo,
} from "./setup.js";
import { banner, c, errLine, line, okLine, out, warnLine } from "./ui.js";

export type StartFlags = {
  platform?: Platform;
  device?: string;
  port?: number;
  open?: boolean;
  lan?: boolean;
  canvasDir?: string;
  printEvent: (e: CaptureEvent) => void;
};

const pad = (n: number) => String(n).padStart(3, "0");

/**
 * `scribui` with no command: set up on first run (asking only what it can't
 * detect), make sure the capture tools work, wait for the agent to list the
 * screens, capture, and open the canvas. Later runs open the canvas directly.
 */
export async function start(store: ReviewStore, flags: StartFlags) {
  banner();
  out();
  const info = detectProject(store.root);
  const firstRun = !store.exists();
  let platform: Platform;

  if (firstRun) {
    out(`  First time with ScribUI in ${c.bold(info.name)}. Setting it up.`);
    out();
    if (flags.platform === "ios" && !onMac) {
      errLine(IOS_NEEDS_MAC);
      out(c.dim("    Review the Android or web build instead: --platform android or --platform web."));
      out();
      return process.exit(1);
    }
    platform = flags.platform ?? (await choosePlatform(info));
    let baseUrl: string | undefined;
    if (platform === "web") baseUrl = await findApp(store.root);
    else {
      out();
      out(`  ${BETA}  Mobile capture is in beta. It works, but capturing is slower than on the web (about 10 s per screen).`);
    }
    const appId = platform === "android" ? info.android?.appId : platform === "ios" ? info.ios?.bundleId : undefined;
    const build = platform === "android" ? info.android?.build : platform === "ios" ? info.ios?.build : undefined;
    const created = await store.init({ platform, name: info.name, baseUrl, appId, build });
    out();
    for (const p of created) okLine(`created ${p}`);
  } else {
    const manifest = await readManifestOrExplain(store);
    if (!manifest) return process.exit(1);
    platform = flags.platform ?? manifest.app.platform;
  }

  // capture tools and device
  out();
  const manifest = (await readManifestOrExplain(store))!;
  if (!manifest) return process.exit(1);
  if (!(await ensureTools(store, platform, manifest, info, flags))) {
    out();
    out(c.dim("  Run scribui again when that's sorted."));
    out();
    return process.exit(1);
  }

  // the agent lists the screens (mobile; on the web you capture views yourself in the app tab)
  const rounds = await store.listRounds();
  if (platform !== "web" && rounds.length === 0 && (await store.isStarterManifest())) {
    const ok = await waitForScreens(store, platform);
    if (!ok) return process.exit(1);
  }

  // non-interactive (an agent or CI ran plain `scribui`): capture and stop
  if (!interactive()) {
    const res = await captureProject(store, {
      app: "cli",
      platform,
      ...(flags.device ? { device: flags.device } : {}),
      log: flags.printEvent,
      onWait: (o) => warnLine(`Another capture is running (${o.app}, pid ${o.pid}); waiting for it to finish…`),
      onHandOver: (o) => line("server", `${o.url ?? ""} owns this project; the capture runs there`),
    });
    out();
    const r = res.result;
    if (r && !r.skipped && r.round !== null) okLine(`round ${pad(r.round)} captured. Open the canvas with: scribui`);
    return;
  }

  await serve(store, flags, platform, platform !== "web" && (await store.listRounds()).length === 0);
}

/** iOS capture runs the iOS Simulator, which only exists in Xcode on macOS. */
const IOS_NEEDS_MAC = "iOS capture needs a Mac with Xcode (it runs the iOS Simulator).";
const onMac = process.platform === "darwin";

async function choosePlatform(info: ProjectInfo): Promise<Platform> {
  if (info.kind === "web") {
    okLine("web app detected");
    return "web";
  }
  for (;;) {
    const picked = await select<Platform>(
      "Which platform do you want to review?",
      [
        { value: "android", label: "Android", hint: info.android ? "emulator or phone" : undefined },
        { value: "ios", label: "iOS", hint: onMac ? "simulator" : "requires a Mac" },
        { value: "web", label: "Web" },
      ],
      info.platform === "ios" && onMac ? "ios" : "android",
    );
    if (picked !== "ios" || onMac) return picked;
    warnLine(`${IOS_NEEDS_MAC} Pick Android or Web, or run scribui on a Mac.`);
    // non-interactive runs would ask forever; Android is the default there anyway
    if (!interactive()) return "android";
  }
}

/** Ask which localhost port the web app runs on, listing the dev servers that answer first. */
async function findApp(root: string): Promise<string> {
  const running = await detectDevServers(root);
  const titles = await Promise.all(running.map(pageTitle));
  const idle = DEV_PORTS.slice(0, 4)
    .map((p) => `http://localhost:${p}`)
    .filter((u) => !running.includes(u));
  const options = [
    ...running.map((u, i) => ({ value: u, label: u.replace(/^https?:\/\//, ""), hint: `running${titles[i] ? `  "${titles[i]}"` : ""}` })),
    ...idle.slice(0, Math.max(0, 4 - running.length)).map((u) => ({ value: u, label: u.replace(/^https?:\/\//, ""), hint: "not running yet" })),
    { value: "other", label: "Other port…" },
  ];
  const picked = await select("Which localhost port does your web app use?", options, options[0]!.value);
  if (picked !== "other") return picked;
  for (;;) {
    const answer = (await input("Port (or full URL)", "3000")).trim();
    if (/^\d{1,5}$/.test(answer) && Number(answer) > 0 && Number(answer) < 65536) return `http://localhost:${answer}`;
    if (/^https?:\/\/\S+$/.test(answer)) return answer.replace(/\/$/, "");
    warnLine(`"${answer}" is not a port number or a URL.`);
  }
}

async function pageTitle(url: string): Promise<string | null> {
  try {
    const html = await (await fetch(url, { signal: AbortSignal.timeout(1500) })).text();
    const t = /<title[^>]*>([^<]{1,80})<\/title>/i.exec(html)?.[1]?.trim();
    return t || null;
  } catch {
    return null;
  }
}

async function readManifestOrExplain(store: ReviewStore): Promise<ScreenManifest | null> {
  try {
    return await store.readManifest();
  } catch (e) {
    errLine((e as Error).message.split("\n")[0]!);
    for (const l of (e as Error).message.split("\n").slice(1)) out(c.dim(`  ${l}`));
    return null;
  }
}

async function ensureTools(store: ReviewStore, platform: Platform, manifest: ScreenManifest, info: ProjectInfo, flags: StartFlags): Promise<boolean> {
  if (platform === "web") {
    if (!(await ensureWebTools(store.root, info))) return false;
    const base = manifest.app.baseUrl;
    if (base && !(await reachable(base))) {
      warnLine(`Nothing answers at ${base}.`);
      out(c.dim(`    Start your app (e.g. ${info.packageManager} run dev), or change "baseUrl" in ${PRODUCT.folder}/screens.json.`));
      const how = await waitFor(`Waiting for ${base}… (Enter to continue anyway)`, () => reachable(base));
      if (how === "detected") okLine(`${base} is up`);
    } else if (base) okLine(`app running at ${base}`);
    return true;
  }
  const appId = manifest.app.bundleId && manifest.app.bundleId !== "com.example.app" ? manifest.app.bundleId : undefined;
  const device = flags.device ?? manifest.app.device;
  const r =
    platform === "android"
      ? await ensureAndroid(store.root, { appId, build: manifest.app.build, device })
      : await ensureIos(store.root, { bundleId: appId, build: manifest.app.build, device });
  if (r.ok && r.device && !manifest.app.device) {
    // remember the choice so the next capture doesn't ask again
    await store.updateApp({ device: r.device });
  }
  return r.ok;
}

async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2000), redirect: "manual" });
    return true;
  } catch {
    return false;
  }
}

async function waitForScreens(store: ReviewStore, platform: Platform): Promise<boolean> {
  const manifest = await store.readManifest();
  const prompt = screensPrompt(platform, manifest.app.baseUrl);
  const copied = await copyToClipboard(prompt);
  out();
  out(`  ${c.bold("Next: your coding agent lists the screens.")} Paste this into it${copied ? c.dim(" (already copied to your clipboard)") : ""}:`);
  out();
  out(`  ${c.accent("│")} ${prompt}`);
  out();
  let lastError = "";
  const how = await waitFor(`Waiting for ${PRODUCT.folder}/screens.json… ${c.dim("(Enter to capture what's there now)")}`, async () => {
    if (await store.isStarterManifest()) return false;
    try {
      await store.readManifest();
      return true;
    } catch (e) {
      const msg = (e as Error).message;
      if (msg !== lastError && !/Unexpected end|JSON/.test(msg)) {
        lastError = msg;
        process.stdout.write("\r\x1b[2K");
        warnLine(msg.split("\n").slice(0, 3).join(" "));
      }
      return false;
    }
  });
  if (how === "detected") {
    const m = await store.readManifest();
    okLine(`screens.json has ${m.screens.length} screen${m.screens.length === 1 ? "" : "s"}`);
    return true;
  }
  // Enter: go ahead with whatever is there
  try {
    await store.readManifest();
    return true;
  } catch (e) {
    errLine((e as Error).message);
    return false;
  }
}

/** Start (or reuse) the server, open the canvas, capture first when there is no round yet. */
async function serve(store: ReviewStore, flags: StartFlags, platform: Platform, captureFirst: boolean) {
  const port = flags.port ?? PRODUCT.defaultPort;
  const runner = makeRunner(store, { platform, ...(flags.device ? { device: flags.device } : {}) }, flags.printEvent, (l: string) =>
    out(c.dim(`    ${l.slice(0, 160)}`)),
  );
  const hosted = await hostProject(store, {
    app: "cli",
    port,
    server: { canvasDir: flags.canvasDir, lan: flags.lan, runner, saveView: (req) => saveCapturedView(store, req) },
    onWait: (o) => warnLine(`Another capture is running (${o.app}, pid ${o.pid}); waiting for it to finish…`),
  });
  if (hosted.kind === "running") {
    const running = hosted.owner.url ?? "";
    okLine(`scribui is already running for this project${hosted.owner.app === "desktop" ? " in the desktop app" : ""}: ${c.accent(running)}`);
    if (platform === "web" && hosted.owner.app !== "desktop") out(c.dim("    Its canvas is in the Chrome window ScribUI opened; press o in that terminal to bring it back."));
    else if (flags.open !== false && running && hosted.owner.app !== "desktop") openBrowser(running);
    out();
    return;
  }
  if (hosted.kind === "no-port") {
    errLine(`Ports ${portRange(port)} are all in use. Pass --port <n>.`);
    return process.exit(1);
  }
  const srv = hosted.server;
  const url = `http://127.0.0.1:${srv.port}/`;
  out();
  line("canvas", c.accent(url));
  // web: the canvas opens in a Chrome window ScribUI controls, so its app tab can capture the app
  let live: LiveWindow | null = null;
  if (platform === "web" && flags.open !== false) {
    live = await openLiveWindow(store, await liveCanvasUrl(store, srv.port), (req) => srv.saveView(req, "gui"), (msg) => warnLine(`Couldn't open the live window: ${msg}`));
    if (live) line("app tab", c.dim("browse your app in the canvas's app tab (L) and press Capture view"));
    else openBrowser(url);
  } else if (flags.open !== false) openBrowser(url);
  const show = () => (live ? void live.show() : openBrowser(url));

  if (captureFirst) {
    out();
    try {
      srv.runCapture({ trigger: "gui" });
    } catch (e) {
      errLine((e as Error).message);
    }
  } else {
    const latest = await store.latestRound();
    if (latest !== null) line("round", `${pad(latest)}  ${c.dim("(latest; recapture from the canvas)")}`);
  }
  out();
  out(c.dim(`  ${c.bold("r")} recapture changed   ${c.bold("R")} recapture all   ${c.bold("o")} open canvas   ${c.bold("q")} quit`));

  const stop = async () => {
    await live?.close();
    await srv.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // single-key commands in the terminal
  if (interactive()) {
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("keypress", (_s: string, key: { name?: string; ctrl?: boolean; shift?: boolean }) => {
      if (key?.ctrl && key.name === "c") void stop();
      else if (key?.name === "q") void stop();
      else if (key?.name === "o") show();
      else if (key?.name === "r") {
        try {
          out();
          // R: every screen, even when nothing looks changed
          srv.runCapture({ trigger: "gui", ...(key.shift ? { all: true } : {}) });
        } catch (e) {
          warnLine((e as Error).message);
        }
      }
    });
  }
}

/**
 * The canvas URL for the live window. When the app runs on localhost, the
 * canvas uses localhost too: the embedded app is then same-site, so its
 * cookies (and logins) work inside the app tab.
 */
async function liveCanvasUrl(store: ReviewStore, port: number): Promise<string> {
  const base = await store
    .readManifest()
    .then((m) => m.app.baseUrl)
    .catch(() => undefined);
  const host = base ? new URL(base).hostname : "";
  return `http://${host === "localhost" ? "localhost" : "127.0.0.1"}:${port}/`;
}

export function openBrowser(url: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    /* no browser */
  }
}

