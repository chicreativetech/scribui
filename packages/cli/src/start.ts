import { spawn } from "node:child_process";
import { emitKeypressEvents } from "node:readline";
import { Platform, PRODUCT, ScreenManifest, screensPrompt } from "@intentcue/core";
import { ReviewStore, startServer } from "@intentcue/server";
import { captureRound, type CaptureEvent } from "./capture.js";
import { confirm, input, interactive, select, waitFor } from "./prompts.js";
import { makeRunner } from "./runner.js";
import {
  BETA,
  copyToClipboard,
  detectDevServer,
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
 * `intentcue` with no command: set up on first run (asking only what it can't
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
    out(`  First time with intentcue in ${c.bold(info.name)}. Setting it up.`);
    out();
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
    out(c.dim("  Run intentcue again when that's sorted."));
    out();
    return process.exit(1);
  }

  // the agent lists the screens
  const rounds = await store.listRounds();
  if (rounds.length === 0 && (await store.isStarterManifest())) {
    const ok = await waitForScreens(store, platform);
    if (!ok) return process.exit(1);
  }

  // non-interactive (an agent or CI ran plain `intentcue`): capture and stop
  if (!interactive()) {
    const r = await captureRound(store, { platform, ...(flags.device ? { device: flags.device } : {}), log: flags.printEvent });
    out();
    if (r && !r.skipped) okLine(`round ${pad(r.round)} captured. Open the canvas with: intentcue`);
    return;
  }

  await serve(store, flags, platform, (await store.listRounds()).length === 0);
}

async function choosePlatform(info: ProjectInfo): Promise<Platform> {
  if (info.kind === "web") {
    okLine("web app detected");
    return "web";
  }
  return select(
    "Which platform do you want to review?",
    [
      { value: "android", label: "Android", hint: info.android ? "emulator or phone" : undefined },
      { value: "ios", label: "iOS", hint: "simulator" },
      { value: "web", label: "Web" },
    ],
    info.platform === "ios" ? "ios" : "android",
  );
}

async function findApp(root: string): Promise<string> {
  const found = await detectDevServer(root);
  if (found) {
    const title = await pageTitle(found);
    okLine(`found an app at ${c.accent(found)}${title ? c.dim(`  "${title}"`) : ""}`);
    if (await confirm(`Review the app at ${found}?`, true)) return found;
  }
  return input("Where does your app run?", found ?? "http://localhost:3000");
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
  const running = await findRunning(store.root, port);
  if (running) {
    okLine(`intentcue is already running for this project: ${c.accent(running)}`);
    if (flags.open !== false) openBrowser(running);
    out();
    return;
  }

  const runner = makeRunner(store, { platform, ...(flags.device ? { device: flags.device } : {}) }, flags.printEvent, (l) =>
    out(c.dim(`    ${l.slice(0, 160)}`)),
  );
  let srv: Awaited<ReturnType<typeof startServer>> | null = null;
  for (let p = port; p < port + 10 && !srv; p++) {
    try {
      srv = await startServer({ projectDir: store.root, canvasDir: flags.canvasDir, port: p, lan: flags.lan, runner });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
    }
  }
  if (!srv) {
    errLine(`Ports ${port}–${port + 9} are all in use. Pass --port <n>.`);
    return process.exit(1);
  }
  const url = `http://127.0.0.1:${srv.port}/`;
  out();
  line("canvas", c.accent(url));
  if (flags.open !== false) openBrowser(url);

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
  out(c.dim(`  ${c.bold("r")} recapture   ${c.bold("o")} open canvas   ${c.bold("q")} quit`));

  const stop = async () => {
    await srv!.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // single-key commands in the terminal
  if (interactive()) {
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("keypress", (_s: string, key: { name?: string; ctrl?: boolean }) => {
      if (key?.ctrl && key.name === "c") void stop();
      else if (key?.name === "q") void stop();
      else if (key?.name === "o") openBrowser(url);
      else if (key?.name === "r") {
        try {
          out();
          srv!.runCapture({ trigger: "gui" });
        } catch (e) {
          warnLine((e as Error).message);
        }
      }
    });
  }
}

async function findRunning(root: string, port: number): Promise<string | null> {
  for (let p = port; p < port + 10; p++) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/api/project`, { signal: AbortSignal.timeout(500) });
      const body = (await r.json()) as { root?: string };
      if (body.root === root) return `http://127.0.0.1:${p}/`;
    } catch {
      /* free or someone else */
    }
  }
  return null;
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

