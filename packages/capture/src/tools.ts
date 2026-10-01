import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { run, which } from "./exec.js";

/**
 * Find a command-line tool on PATH or in the places its installer puts it
 * (Android Studio's SDK, ~/.maestro/bin), which are often not on PATH.
 */
export async function findTool(name: "adb" | "emulator" | "maestro" | "idb" | "xcrun"): Promise<string | null> {
  const onPath = await which(name);
  if (onPath) return onPath;
  const home = homedir();
  const sdks = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, join(home, "Library/Android/sdk"), join(home, "Android/Sdk")].filter(
    (p): p is string => !!p,
  );
  const candidates: string[] = [];
  if (name === "adb") candidates.push(...sdks.map((s) => join(s, "platform-tools/adb")));
  if (name === "emulator") candidates.push(...sdks.map((s) => join(s, "emulator/emulator")));
  if (name === "maestro") candidates.push(join(home, ".maestro/bin/maestro"));
  if (name === "idb") candidates.push(join(home, ".local/bin/idb"), "/opt/homebrew/bin/idb");
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
