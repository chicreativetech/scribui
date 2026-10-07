import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  findTool,
  installEnv,
  installPlan,
  listAndroidDevices,
  listAvds,
  listSimulators,
  bootSimulator,
  run,
  runInstall,
  RUNTIME_DIR,
  startEmulator,
  which,
  type AndroidDevice,
} from "@scribui/capture";
import { buildEnv, type ProjectInfo } from "@scribui/project";
import { confirm, select, spinner } from "./prompts.js";
import { c, errLine, okLine, out, warnLine } from "./ui.js";

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
        await writeFile(join(RUNTIME_DIR, "package.json"), JSON.stringify({ name: "scribui-runtime", private: true }) + "\n");
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
    const plan = installPlan("adb", await installEnv());
    if (plan.auto && (await confirm(`Install it? ${c.dim(plan.does)}`, true))) {
      if (plan.terms) out(c.dim(`    Google's terms: ${plan.terms}`));
      const r = await runInstall(plan, (l) => out(c.dim(`    ${l}`)));
      if (!r.ok) errLine(`Installing adb failed: ${r.error}`);
      adb = await findTool("adb");
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
    out(c.dim("  ScribUI's built-in adb helper works without it."));
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
          errLine("The build failed (see above). Fix it, install the app, then run scribui again.");
          return { device: device.serial, ok: false };
        }
      } else {
        errLine("Install the app on the device, then run scribui again.");
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
    const avd = avds.length === 1 ? avds[0]! : await select("Which emulator should ScribUI start?", avds.map((a) => ({ value: a, label: a.replace(/_/g, " ") })), avds[0]!);
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
    "Several devices are connected. Which one should ScribUI use?",
    devices.map((d) => ({ value: d.serial, label: d.model || d.serial, hint: d.emulator ? "emulator" : `phone · ${d.serial}` })),
    (devices.find((d) => d.emulator) ?? devices[0]!).serial,
  );
  return devices.find((d) => d.serial === serial)!;
}

/* ─────────────────────────── iOS ─────────────────────────── */

export async function ensureIos(root: string, opts: { bundleId?: string; build?: string; device?: string }): Promise<{ device: string | null; ok: boolean }> {
  if (process.platform !== "darwin" || !(await which("xcrun"))) {
    errLine("iOS capture needs a Mac with Xcode. Install Xcode from the App Store, then run: xcode-select --install");
    return { device: null, ok: false };
  }
  okLine("Xcode tools ready");
  if (!(await findTool("maestro")) && !(await findTool("axe")) && !(await findTool("idb"))) {
    out();
    out("  Maestro is required to read iOS screens and navigate between them.");
    if (!(await confirm("Install Maestro? (curl -fsSL https://get.maestro.mobile.dev | bash)", true))) {
      errLine("Skipped. Install Maestro, then run scribui again.");
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
    const udid = await select("Which simulator should ScribUI boot?", phones.slice(0, 6).map((s) => ({ value: s.udid, label: s.name, hint: s.runtime })), phones[0]!.udid);
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
        errLine("Build and run the app on the simulator once (Xcode ▶), then run scribui again.");
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
