import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Platform } from "@scribui/core";
import { run, which } from "./exec.js";
import { installEnv, installPlan, RUNTIME_DIR, TOOLS_DIR, type InstallEnv, type InstallPlan } from "./install.js";

/**
 * Find a command-line tool on PATH or in the places its installer puts it
 * (Android Studio's SDK, ~/.maestro/bin, ScribUI's own ~/.scribui/tools),
 * which are often not on PATH.
 */
export async function findTool(name: "adb" | "emulator" | "maestro" | "idb" | "idb_companion" | "axe" | "xcrun"): Promise<string | null> {
  const onPath = await which(name);
  if (onPath) return onPath;
  const home = homedir();
  const sdks = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(home, "Library/Android/sdk"),
    join(home, "Android/Sdk"),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Android/Sdk"),
  ].filter((p): p is string => !!p);
  const exe = process.platform === "win32" ? ".exe" : "";
  const candidates: string[] = [];
  if (name === "adb") candidates.push(...sdks.map((s) => join(s, `platform-tools/adb${exe}`)), join(TOOLS_DIR, `platform-tools/adb${exe}`));
  if (name === "emulator") candidates.push(...sdks.map((s) => join(s, `emulator/emulator${exe}`)));
  if (name === "maestro") candidates.push(join(home, ".maestro/bin/maestro"));
  if (name === "idb") candidates.push(join(home, ".local/bin/idb"), "/opt/homebrew/bin/idb");
  if (name === "idb_companion") candidates.push("/opt/homebrew/bin/idb_companion", "/usr/local/bin/idb_companion");
  if (name === "axe") candidates.push("/opt/homebrew/bin/axe", "/usr/local/bin/axe");
  return candidates.find((p) => existsSync(p)) ?? null;
}

export type AndroidDevice = { serial: string; model: string; emulator: boolean };

export async function listAndroidDevices(): Promise<AndroidDevice[]> {
  const adb = await findTool("adb");
  if (!adb) return [];
  const r = await run(adb, ["devices", "-l"], { timeoutMs: 10_000 });
  return r.stdout
    .toString()
    .split("\n")
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p[1] === "device")
    .map((p) => ({
      serial: p[0]!,
      model: p.find((x) => x.startsWith("model:"))?.slice(6).replace(/_/g, " ") ?? "",
      emulator: p[0]!.startsWith("emulator-"),
    }));
}

export async function listAvds(): Promise<string[]> {
  const emu = await findTool("emulator");
  if (!emu) return [];
  const r = await run(emu, ["-list-avds"], { timeoutMs: 15_000 });
  return r.stdout
    .toString()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("INFO"));
}

/** Start an Android emulator in the background and wait until it has booted. */
export async function startEmulator(avd: string, onTick?: () => void): Promise<boolean> {
  const emu = await findTool("emulator");
  const adb = await findTool("adb");
  if (!emu || !adb) return false;
  const { spawn } = await import("node:child_process");
  const child = spawn(emu, ["-avd", avd, "-no-boot-anim"], { detached: true, stdio: "ignore" });
  child.unref();
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    onTick?.();
    const devices = await listAndroidDevices();
    for (const d of devices.filter((x) => x.emulator)) {
      const b = await run(adb, ["-s", d.serial, "shell", "getprop", "sys.boot_completed"], { timeoutMs: 5000 });
      if (b.stdout.toString().trim() === "1") return true;
    }
  }
  return false;
}

export type Simulator = { udid: string; name: string; state: string; runtime: string };

export async function listSimulators(): Promise<Simulator[]> {
  const r = await run("xcrun", ["simctl", "list", "devices", "available", "-j"], { timeoutMs: 20_000 });
  if (r.code !== 0) return [];
  const data = JSON.parse(r.stdout.toString()) as { devices: Record<string, Omit<Simulator, "runtime">[]> };
  return Object.entries(data.devices).flatMap(([runtime, list]) =>
    list.map((d) => ({ ...d, runtime: runtime.replace(/^.*SimRuntime\./, "").replace(/-/g, " ") })),
  );
}

export async function bootSimulator(udid: string): Promise<boolean> {
  const r = await run("xcrun", ["simctl", "boot", udid], { timeoutMs: 120_000 });
  await run("open", ["-a", "Simulator"], { timeoutMs: 10_000 }).catch(() => null);
  const ok = r.code === 0 || /current state: Booted/i.test(r.stderr);
  if (ok) await run("xcrun", ["simctl", "bootstatus", udid, "-b"], { timeoutMs: 180_000 });
  return ok;
}

/* ─────────────────────────── tool report ─────────────────────────── */

export type ToolId = "adb" | "emulator" | "xcode" | "axe" | "playwright";

export type ToolStatus = {
  id: ToolId;
  name: string;
  /** What it's for, in a few words. */
  purpose: string;
  /** Platforms whose capture needs it. */
  platforms: Platform[];
  /** Capture can't work without it (the others make it better or are needed later). */
  required: boolean;
  ok: boolean;
  /** Where it was found, or why it isn't usable. */
  detail: string;
  /**
   * When it's missing: the command to copy, a page about it, and either
   * what ScribUI's own install does (`auto`) or what to do instead (`note`).
   */
  install?: { command?: string; url?: string; auto?: { does: string; terms?: string; after?: string }; note?: string };
};

type Os = "darwin" | "win32" | "linux";

/** AXe: the iOS Simulator's input, accessibility tree and (through its frameworks) the device view's stream. */
export const AXE_INSTALL = "brew tap cameroncooke/axe; brew trust --formula cameroncooke/axe/axe; brew install cameroncooke/axe/axe";

/** The commands to copy, for a terminal (the app can install most of these itself, see `installPlan`). */
const COMMANDS: Record<ToolId, Partial<Record<Os, { command?: string; url?: string }>>> = {
  adb: {
    darwin: { command: "brew install --cask android-platform-tools" },
    win32: { command: "winget install Google.PlatformTools" },
    linux: { command: "sudo apt install adb" },
  },
  emulator: {
    darwin: { command: "brew install --cask android-studio", url: "https://developer.android.com/studio" },
    win32: { command: "winget install Google.AndroidStudio", url: "https://developer.android.com/studio" },
    linux: { command: "sudo snap install android-studio --classic", url: "https://developer.android.com/studio" },
  },
  xcode: { darwin: { command: 'open "macappstore://apps.apple.com/app/xcode/id497799835"', url: "https://developer.apple.com/xcode/" } },
  // current Homebrew asks to trust a third-party formula before installing it
  axe: { darwin: { command: AXE_INSTALL, url: "https://github.com/cameroncooke/AXe" } },
  playwright: {
    darwin: { command: "npm i -D playwright && npx playwright install chromium", url: "https://playwright.dev" },
    win32: { command: "npm i -D playwright && npx playwright install chromium", url: "https://playwright.dev" },
    linux: { command: "npm i -D playwright && npx playwright install chromium", url: "https://playwright.dev" },
  },
};

/** What a missing tool's report says about installing it: the command to copy, and the app's own install or why there's none. */
export function installInfo(id: ToolId, env: InstallEnv): ToolStatus["install"] | undefined {
  const manual = COMMANDS[id][env.os as Os] ?? {};
  const plan: InstallPlan = installPlan(id, env);
  if (plan.auto) return { ...manual, auto: { does: plan.does, ...(plan.terms ? { terms: plan.terms } : {}), ...(plan.after ? { after: plan.after } : {}) } };
  const info = { ...manual, ...(plan.command ? { command: plan.command } : {}), ...(plan.url ? { url: plan.url } : {}), note: plan.reason };
  return info;
}

/**
 * The device tools ScribUI uses, found or not, with how to install each
 * missing one on this system. iOS tools are only listed on macOS.
 */
export async function detectTools(os: NodeJS.Platform = process.platform, env?: InstallEnv): Promise<ToolStatus[]> {
  const ienv = env ?? (await installEnv(os));
  const found = (id: ToolId, path: string | null, missing: string) => (path ? { ok: true, detail: path } : missingTool(id, missing, ienv));

  const [adb, emulator] = await Promise.all([findTool("adb"), findTool("emulator")]);
  const tools: ToolStatus[] = [
    {
      id: "adb",
      name: "adb",
      purpose: "talks to Android emulators and phones",
      platforms: ["android"],
      required: true,
      ...found("adb", adb, "not found on PATH or in the Android SDK"),
    },
    {
      id: "emulator",
      name: "Android emulator",
      purpose: "runs virtual Android devices (or use a phone over USB)",
      platforms: ["android"],
      required: false,
      ...found("emulator", emulator, "not found in the Android SDK"),
    },
  ];
  if (os !== "darwin") return tools;

  const [xcode, axe] = await Promise.all([xcodeStatus(), findTool("axe")]);
  tools.push(
    {
      id: "xcode",
      name: "Xcode",
      purpose: "runs the iOS Simulator",
      platforms: ["ios"],
      required: true,
      ...(xcode.ok ? { ok: true, detail: xcode.detail } : missingTool("xcode", xcode.detail, ienv)),
    },
    {
      id: "axe",
      name: "AXe",
      purpose: "shows, controls and reads the iOS Simulator",
      platforms: ["ios"],
      required: true,
      ...found("axe", axe, "not found"),
    },
  );
  return tools;
}

function missingTool(id: ToolId, detail: string, env: InstallEnv): { ok: false; detail: string; install?: ToolStatus["install"] } {
  const install = installInfo(id, env);
  return { ok: false, detail, ...(install ? { install } : {}) };
}

/** Full Xcode (not just the Command Line Tools): `simctl` only comes with Xcode. */
async function xcodeStatus(): Promise<{ ok: boolean; detail: string }> {
  const dir = (await run("xcode-select", ["-p"], { timeoutMs: 5000 })).stdout.toString().trim();
  const simctl = await run("xcrun", ["simctl", "help"], { timeoutMs: 10_000 });
  if (simctl.code === 0) return { ok: true, detail: dir || "xcrun simctl" };
  if (/CommandLineTools/.test(dir)) return { ok: false, detail: "only the Command Line Tools are selected; the Simulator needs Xcode" };
  return { ok: false, detail: "not installed" };
}

/**
 * Playwright and its Chromium, which recapture web screens on their own:
 * from the project first, then ScribUI's shared install. Views captured in
 * the desktop app's own browser don't need it.
 */
export async function playwrightStatus(projectDir?: string, env?: InstallEnv): Promise<ToolStatus> {
  const base = {
    id: "playwright" as const,
    name: "Playwright",
    purpose: "recaptures web screens on its own (views you capture in the app don't need it)",
    platforms: ["web" as Platform],
    required: false,
  };
  const ienv = env ?? (await installEnv());
  let found: { dir: string; chromium: string | null } | null = null;
  for (const dir of [projectDir, RUNTIME_DIR].filter((d): d is string => !!d)) {
    try {
      const entry = createRequire(join(dir, "package.json")).resolve("playwright");
      type Mod = { chromium?: { executablePath(): string }; default?: { chromium?: { executablePath(): string } } };
      const mod = (await import(pathToFileURL(entry).href)) as Mod;
      let chromium: string | null = null;
      try {
        const p = (mod.chromium ?? mod.default?.chromium)?.executablePath();
        chromium = p && existsSync(p) ? p : null;
      } catch {
        chromium = null;
      }
      found = { dir, chromium };
      break;
    } catch {
      /* not there */
    }
  }
  if (found?.chromium) return { ...base, ok: true, detail: found.dir === RUNTIME_DIR ? `${found.dir} (shared)` : found.dir };
  return { ...base, ...missingTool("playwright", found ? "installed, but its Chromium isn't downloaded yet" : "not installed", ienv) };
}
