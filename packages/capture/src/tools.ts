import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Platform } from "@scribui/core";
import { run, which } from "./exec.js";

/**
 * Find a command-line tool on PATH or in the places its installer puts it
 * (Android Studio's SDK, ~/.maestro/bin), which are often not on PATH.
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
  if (name === "adb") candidates.push(...sdks.map((s) => join(s, `platform-tools/adb${exe}`)));
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

export type ToolId = "adb" | "emulator" | "xcode" | "axe";

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
  /** How to install it on this system, when it's missing. */
  install?: { command?: string; url?: string };
};

type Os = "darwin" | "win32" | "linux";

/** AXe: the iOS Simulator's input, accessibility tree and (through its frameworks) the device view's stream. */
export const AXE_INSTALL = "brew tap cameroncooke/axe; brew trust --formula cameroncooke/axe/axe; brew install cameroncooke/axe/axe";

const INSTALL: Record<ToolId, Partial<Record<Os, { command?: string; url?: string }>>> = {
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
};

/**
 * The device tools ScribUI uses, found or not, with the command that installs
 * each missing one on this system. iOS tools are only listed on macOS.
 */
export async function detectTools(os: NodeJS.Platform = process.platform): Promise<ToolStatus[]> {
  const install = (id: ToolId) => INSTALL[id][os as Os];
  const found = (id: ToolId, path: string | null, missing: string) =>
    path ? { ok: true, detail: path } : { ok: false, detail: missing, ...(install(id) ? { install: install(id) } : {}) };

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
      ...(xcode.ok ? { ok: true, detail: xcode.detail } : { ok: false, detail: xcode.detail, install: install("xcode")! }),
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

/** Full Xcode (not just the Command Line Tools): `simctl` only comes with Xcode. */
async function xcodeStatus(): Promise<{ ok: boolean; detail: string }> {
  const dir = (await run("xcode-select", ["-p"], { timeoutMs: 5000 })).stdout.toString().trim();
  const simctl = await run("xcrun", ["simctl", "help"], { timeoutMs: 10_000 });
  if (simctl.code === 0) return { ok: true, detail: dir || "xcrun simctl" };
  if (/CommandLineTools/.test(dir)) return { ok: false, detail: "only the Command Line Tools are selected; the Simulator needs Xcode (then: sudo xcode-select -s /Applications/Xcode.app)" };
  return { ok: false, detail: "not installed" };
}
