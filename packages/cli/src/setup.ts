import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  findTool,
  listAndroidDevices,
  listAvds,
  listSimulators,
  bootSimulator,
  run,
  startEmulator,
  which,
  type AndroidDevice,
} from "@intentcue/capture";
import type { Platform } from "@intentcue/core";
import { confirm, select, spinner } from "./prompts.js";
import { c, errLine, okLine, out, warnLine } from "./ui.js";

/* ─────────────────────────── detection ─────────────────────────── */

export type ProjectInfo = {
  name: string;
  kind: "web" | "mobile";
  /** Best guess; for mobile the user confirms. */
  platform: Platform;
  hasPackageJson: boolean;
  packageManager: "npm" | "pnpm" | "yarn" | "bun";
  android?: { appId?: string; build?: string };
  ios?: { bundleId?: string; build?: string };
};

const read = (p: string) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
};

export function detectProject(root: string): ProjectInfo {
  const has = (p: string) => existsSync(join(root, p));
  const pkgText = read(join(root, "package.json"));
  let pkg: { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
  try {
    pkg = pkgText ? JSON.parse(pkgText) : {};
  } catch {
    /* ignore */
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const rn = !!deps["react-native"];
  const expo = !!deps["expo"];
  const flutter = has("pubspec.yaml");

  const packageManager: ProjectInfo["packageManager"] = has("pnpm-lock.yaml")
    ? "pnpm"
    : has("yarn.lock")
      ? "yarn"
      : has("bun.lockb") || has("bun.lock")
        ? "bun"
        : "npm";

  // Android
  const gradleDirs = ["", "android"].filter((d) => existsSync(join(root, d, "settings.gradle")) || existsSync(join(root, d, "settings.gradle.kts")));
  let android: ProjectInfo["android"];
  if (gradleDirs.length) {
    const dir = gradleDirs[0]!;
    const gradle = read(join(root, dir, "app/build.gradle.kts")) || read(join(root, dir, "app/build.gradle"));
    const appId = /applicationId\s*=?\s*["']([\w.]+)["']/.exec(gradle)?.[1];
    const build = expo
      ? "npx expo run:android"
      : rn
        ? "npx react-native run-android"
        : flutter
          ? "flutter run -d android --debug"
          : existsSync(join(root, dir, "gradlew"))
            ? `${dir ? `cd ${dir} && ` : ""}./gradlew installDebug`
            : undefined;
    android = { ...(appId ? { appId } : {}), ...(build ? { build } : {}) };
  }

  // iOS
  let ios: ProjectInfo["ios"];
  const iosDirs = ["", "ios"].filter((d) => {
    try {
      return readdirSync(join(root, d)).some((f) => f.endsWith(".xcodeproj") || f.endsWith(".xcworkspace"));
    } catch {
      return false;
    }
  });
  const appJson = read(join(root, "app.json"));
  if (iosDirs.length || (expo && /"ios"/.test(appJson))) {
    let bundleId = /"bundleIdentifier"\s*:\s*"([\w.-]+)"/.exec(appJson)?.[1];
    for (const d of iosDirs) {
      if (bundleId) break;
      const proj = readdirSync(join(root, d)).find((f) => f.endsWith(".xcodeproj"));
      if (!proj) continue;
      const pbx = read(join(root, d, proj, "project.pbxproj"));
      bundleId = [...pbx.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = "?([\w.-]+)"?;/g)].map((m) => m[1]!).find((id) => !id.includes("Tests"));
    }
    const build = expo ? "npx expo run:ios" : rn ? "npx react-native run-ios" : flutter ? "flutter run -d ios --debug" : undefined;
    ios = { ...(bundleId ? { bundleId } : {}), ...(build ? { build } : {}) };
  }

  const mobile = !!android || !!ios || rn || expo || flutter;
  return {
    name: pkg.name && !pkg.name.startsWith("@") ? pkg.name : basename(root),
    kind: mobile ? "mobile" : "web",
    platform: !mobile ? "web" : android && !ios ? "android" : ios && !android ? "ios" : "android",
    hasPackageJson: !!pkgText,
    packageManager,
    ...(android ? { android } : {}),
    ...(ios ? { ios } : {}),
  };
}

const DEV_PORTS = [3000, 5173, 5174, 8080, 4200, 8000, 4321, 3001, 5000, 4173, 1234, 9000, 8888, 3030];

/**
 * Find the app's dev server: first a listening process started from this
 * project folder (any port), then a few common dev-server ports.
 */
export async function detectDevServer(root?: string): Promise<string | null> {
  if (root) {
    const own = await serverStartedIn(root).catch(() => null);
    if (own) return own;
  }
  const probes = DEV_PORTS.map(async (port) => {
    const url = `http://localhost:${port}`;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(900), redirect: "manual" });
      return r.status < 500 ? url : null;
    } catch {
      return null;
    }
  });
  const found = await Promise.all(probes);
  return found.find((u) => u) ?? null;
}

async function serverStartedIn(root: string): Promise<string | null> {
  const ls = await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"], { timeoutMs: 5000 });
  if (ls.code !== 0) return null;
  // -F output: p<pid> then n<addr:port> lines
  const ports = new Map<string, number[]>();
  let pid = "";
  for (const l of ls.stdout.toString().split("\n")) {
    if (l.startsWith("p")) pid = l.slice(1);
    else if (l.startsWith("n") && pid) {
      const port = Number(/:(\d+)$/.exec(l)?.[1]);
      if (port && port !== 4382) ports.set(pid, [...(ports.get(pid) ?? []), port]);
    }
  }
  for (const [p, list] of ports) {
    const cwd = await run("lsof", ["-a", "-p", p, "-d", "cwd", "-Fn"], { timeoutMs: 3000 });
    const dir = cwd.stdout.toString().split("\n").find((l) => l.startsWith("n"))?.slice(1);
    if (!dir || !(dir === root || dir.startsWith(root + "/"))) continue;
    for (const port of [...new Set(list)].sort((a, b) => a - b)) {
      const url = `http://localhost:${port}`;
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(900), redirect: "manual" });
        if (r.status < 500) return url;
      } catch {
        /* not http */
      }
    }
  }
  return null;
}

/* ─────────────────────────── running installs ─────────────────────────── */

/** Run a shell command with its output streaming to the terminal. */
export function runVisible(cmd: string, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  out(c.dim(`  $ ${cmd}`));
  return new Promise((resolve) => {
    const child = spawn(cmd, { cwd, shell: true, stdio: "inherit", env });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

/* ─────────────────────────── web: Playwright ─────────────────────────── */

export const RUNTIME_DIR = join(homedir(), ".intentcue", "runtime");

type PlaywrightMod = { chromium?: { executablePath(): string }; default?: { chromium?: { executablePath(): string } } };

async function findPlaywright(root: string): Promise<{ dir: string; chromiumPath: string | null } | null> {
  for (const base of [root, RUNTIME_DIR]) {
    try {
      const req = createRequire(join(base, "package.json"));
      const entry = req.resolve("playwright");
      const mod = (await import(pathToFileURL(entry).href)) as PlaywrightMod;
      const chromium = mod.chromium ?? mod.default?.chromium;
      let chromiumPath: string | null = null;
      try {
        const p = chromium?.executablePath();
        chromiumPath = p && existsSync(p) ? p : null;
      } catch {
        chromiumPath = null;
      }
      return { dir: base, chromiumPath };
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Make sure Playwright and Chromium are available; offers to install them. */
export async function ensureWebTools(root: string, info: ProjectInfo): Promise<boolean> {
  let pw = await findPlaywright(root);
  if (!pw) {
    out();
    out(`  Playwright is required to capture web screens ${c.dim("(it drives a headless Chrome).")}`);
    if (!(await confirm("Install Playwright?", true))) {
      errLine("Skipped. Install later with: npm i -D playwright && npx playwright install chromium");
      return false;
    }
    let ok: boolean;
    if (info.hasPackageJson) {
      const add = { npm: "npm install -D playwright", pnpm: "pnpm add -D playwright", yarn: "yarn add -D playwright", bun: "bun add -d playwright" }[
        info.packageManager
      ];
      ok = await runVisible(add, root);
    } else {
      // no package.json (plain HTML, other stacks): keep it out of the project
      await mkdir(RUNTIME_DIR, { recursive: true });
      if (!existsSync(join(RUNTIME_DIR, "package.json")))
        await writeFile(join(RUNTIME_DIR, "package.json"), JSON.stringify({ name: "intentcue-runtime", private: true }) + "\n");
      ok = await runVisible("npm install --no-audit --no-fund playwright", RUNTIME_DIR);
    }
    if (!ok) {
      errLine("Installing Playwright failed (see above).");
      return false;
    }
    pw = await findPlaywright(root);
    if (!pw) return false;
  }
  if (!pw.chromiumPath) {
    out();
    out("  Playwright needs its Chromium browser (about 150 MB, once).");
    if (!(await confirm("Download Chromium now?", true))) return false;
    if (!(await runVisible("npx playwright install chromium", pw.dir))) {
      errLine("Downloading Chromium failed (see above).");
      return false;
    }
  }
  okLine("Playwright and Chromium ready");
  return true;
}

/* ─────────────────────────── Android ─────────────────────────── */

export const BETA = c.warn("beta");

/** adb (required), Maestro (optional), a device, and the app on it. Returns the device to use. */
export async function ensureAndroid(
  root: string,
  opts: { appId?: string; build?: string; device?: string },
): Promise<{ device: string | null; ok: boolean }> {
  let adb = await findTool("adb");
  if (!adb) {
    out();
    out("  adb (Android platform tools) is required to capture Android screens.");
    if (await which("brew")) {
      if (await confirm("Install it with Homebrew?", true)) {
        await runVisible("brew install --cask android-platform-tools", root);
        adb = await findTool("adb");
      }
    } else {
      out(c.dim("    Install Android Studio (https://developer.android.com/studio), or the platform tools alone."));
    }
    if (!adb) {
      errLine("adb not found.");
      return { device: null, ok: false };
    }
  }
  okLine("adb ready");

  if (!(await findTool("maestro"))) {
    out(c.dim("  Tip: Maestro (https://maestro.mobile.dev) makes navigation flows faster. It's optional;"));
    out(c.dim("  intentcue's built-in adb helper works without it."));
  }

  const device = await ensureAndroidDevice(opts.device);
  if (!device) return { device: null, ok: false };

  if (opts.appId) {
    const r = await run(adb, ["-s", device.serial, "shell", "pm", "list", "packages", opts.appId], { timeoutMs: 15_000 });
    const installed = r.stdout.toString().split("\n").some((l) => l.trim() === `package:${opts.appId}`);
    if (!installed) {
      warnLine(`${opts.appId} is not installed on ${device.model || device.serial}.`);
      if (opts.build && (await confirm(`Build and install it now? (${opts.build})`, true))) {
        const ok = await runVisible(opts.build, root, buildEnv(device.serial));
        if (!ok) {
          errLine("The build failed (see above). Fix it, install the app, then run intentcue again.");
          return { device: device.serial, ok: false };
        }
      } else {
        errLine("Install the app on the device, then run intentcue again.");
        return { device: device.serial, ok: false };
      }
    } else okLine(`${opts.appId} installed on ${device.model || device.serial}`);
  }
  return { device: device.emulator ? "emulator" : device.serial, ok: true };
}

async function ensureAndroidDevice(want?: string): Promise<AndroidDevice | null> {
  let devices = await listAndroidDevices();
  if (want) {
    const w = want.toLowerCase();
    const hit = devices.find((d) => d.serial === want || d.model.toLowerCase() === w || (w === "emulator" && d.emulator));
    if (hit) {
      okLine(`device: ${hit.model || hit.serial}${hit.emulator ? c.dim(" (emulator)") : ""}`);
      return hit;
    }
  }
  if (devices.length === 0) {
    const avds = await listAvds();
    if (avds.length === 0) {
      errLine("No Android device or emulator found.");
      out(c.dim("    Connect a phone with USB debugging on, or create an emulator in Android Studio (Device Manager)."));
      return null;
    }
    out();
    const avd = avds.length === 1 ? avds[0]! : await select("Which emulator should intentcue start?", avds.map((a) => ({ value: a, label: a.replace(/_/g, " ") })), avds[0]!);
    if (!(await confirm(`Start the ${avd.replace(/_/g, " ")} emulator?`, true))) return null;
    const spin = spinner(`Starting ${avd.replace(/_/g, " ")}… (first boot can take a minute)`);
    const ok = await startEmulator(avd);
    spin.stop(ok ? `  ${c.ok("✓")} emulator started` : undefined);
    if (!ok) {
      errLine("The emulator did not finish booting within 3 minutes.");
      return null;
    }
    devices = await listAndroidDevices();
  }
  if (devices.length === 1) {
    okLine(`device: ${devices[0]!.model || devices[0]!.serial}${devices[0]!.emulator ? c.dim(" (emulator)") : ""}`);
    return devices[0]!;
  }
  const serial = await select(
    "Several devices are connected. Which one should intentcue use?",
    devices.map((d) => ({ value: d.serial, label: d.model || d.serial, hint: d.emulator ? "emulator" : `phone · ${d.serial}` })),
    (devices.find((d) => d.emulator) ?? devices[0]!).serial,
  );
  return devices.find((d) => d.serial === serial)!;
}

/**
 * Environment for build commands: Android Studio's bundled JDK when JAVA_HOME
 * is unset or older than 17 (current Gradle needs 17+), and the chosen device.
 */
export function buildEnv(serial?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const jbr = [
    "/Applications/Android Studio.app/Contents/jbr/Contents/Home",
    join(homedir(), "Applications/Android Studio.app/Contents/jbr/Contents/Home"),
  ].find((p) => existsSync(p));
  if (jbr && (!env.JAVA_HOME || javaMajor(env.JAVA_HOME) < 17)) env.JAVA_HOME = jbr;
  if (serial) env.ANDROID_SERIAL = serial;
  return env;
}

/** Major Java version from a JDK's release file (0 when unknown). */
function javaMajor(home: string): number {
  const v = /JAVA_VERSION="(\d+)(?:\.(\d+))?/.exec(read(join(home, "release")));
  if (!v) return 0;
  return v[1] === "1" ? Number(v[2] ?? 0) : Number(v[1]);
}

/* ─────────────────────────── iOS ─────────────────────────── */

export async function ensureIos(root: string, opts: { bundleId?: string; build?: string; device?: string }): Promise<{ device: string | null; ok: boolean }> {
  if (process.platform !== "darwin" || !(await which("xcrun"))) {
    errLine("iOS capture needs a Mac with Xcode. Install Xcode from the App Store, then run: xcode-select --install");
    return { device: null, ok: false };
  }
  okLine("Xcode tools ready");
  if (!(await findTool("maestro")) && !(await findTool("idb"))) {
    out();
    out("  Maestro is required to read iOS screens and navigate between them.");
    if (!(await confirm("Install Maestro? (curl -fsSL https://get.maestro.mobile.dev | bash)", true))) {
      errLine("Skipped. Install Maestro, then run intentcue again.");
      return { device: null, ok: false };
    }
    await runVisible("curl -fsSL https://get.maestro.mobile.dev | bash", root);
    if (!(await findTool("maestro"))) {
      errLine("Maestro did not install (it needs Java 17+: brew install openjdk@17).");
      return { device: null, ok: false };
    }
  }
  okLine("Maestro ready");

  const sims = await listSimulators();
  let booted = sims.filter((s) => s.state === "Booted");
  if (opts.device) booted = booted.filter((s) => s.udid === opts.device || s.name === opts.device);
  let sim = booted[0];
  if (booted.length > 1) {
    const udid = await select("Several simulators are booted. Which one?", booted.map((s) => ({ value: s.udid, label: s.name, hint: s.runtime })), booted[0]!.udid);
    sim = booted.find((s) => s.udid === udid);
  }
  if (!sim) {
    const phones = sims.filter((s) => /iPhone/.test(s.name)).reverse();
    if (!phones.length) {
      errLine("No iPhone simulators found. Add one in Xcode → Window → Devices and Simulators.");
      return { device: null, ok: false };
    }
    const udid = await select("Which simulator should intentcue boot?", phones.slice(0, 6).map((s) => ({ value: s.udid, label: s.name, hint: s.runtime })), phones[0]!.udid);
    const spin = spinner("Booting the simulator…");
    const ok = await bootSimulator(udid);
    spin.stop(ok ? `  ${c.ok("✓")} simulator booted` : undefined);
    if (!ok) return { device: null, ok: false };
    sim = sims.find((s) => s.udid === udid);
  } else okLine(`simulator: ${sim.name}`);

  if (opts.bundleId && sim) {
    const r = await run("xcrun", ["simctl", "get_app_container", sim.udid, opts.bundleId], { timeoutMs: 15_000 });
    if (r.code !== 0) {
      warnLine(`${opts.bundleId} is not installed on ${sim.name}.`);
      if (opts.build && (await confirm(`Build and install it now? (${opts.build})`, true))) {
        if (!(await runVisible(opts.build, root))) return { device: sim.name, ok: false };
      } else {
        errLine("Build and run the app on the simulator once (Xcode ▶), then run intentcue again.");
        return { device: sim.name, ok: false };
      }
    } else okLine(`${opts.bundleId} installed`);
  }
  return { device: sim?.name ?? null, ok: true };
}

/* ─────────────────────────── misc ─────────────────────────── */

/** Copy to the clipboard when a clipboard tool exists; returns whether it worked. */
export async function copyToClipboard(text: string): Promise<boolean> {
  const tool = process.platform === "darwin" ? ["pbcopy"] : process.platform === "win32" ? ["clip"] : (await which("wl-copy")) ? ["wl-copy"] : ["xclip", "-selection", "clipboard"];
  return new Promise((resolve) => {
    try {
      const child = spawn(tool[0]!, tool.slice(1), { stdio: ["pipe", "ignore", "ignore"] });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
      child.stdin.end(text);
    } catch {
      resolve(false);
    }
  });
}
