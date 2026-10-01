import type { RawElement, ScreenCapture, ScreenEntry } from "@intentcue/core";
import { CaptureError, run } from "../exec.js";
import { findTool } from "../tools.js";
import { parseUiautomator } from "../parsers/uiautomator.js";
import { pngSize } from "../png.js";
import type { CaptureAdapter, CaptureContext } from "../types.js";
import { runFlow, screenshotPath, toCapture, writePng } from "./shared.js";

/** Android emulator: Maestro flows, `adb screencap`, `uiautomator dump`. */
export class AndroidAdapter implements CaptureAdapter {
  readonly platform = "android" as const;
  private serial: string | null = null;

  constructor(private ctx: CaptureContext) {}

  async check() {
    const problems: string[] = [];
    this.adbPath = await findTool("adb");
    if (!this.adbPath) {
      problems.push("adb not found. Install platform tools: brew install --cask android-platform-tools");
      return { ok: false, problems };
    }
    if (!(await this.findDevice())) {
      const list = this.devices.map((d) => `    ${d.serial}${d.model ? `  (${d.model})` : ""}`).join("\n");
      if (this.ctx.device) problems.push(`No connected device matches "${this.ctx.device}". Connected:\n${list || "    none"}`);
      else if (this.devices.length > 1)
        problems.push(
          `${this.devices.length} devices are connected; pick one with --device <serial|model|emulator>,\n` +
            `  or set "device" under "app" in screens.json:\n${list}`,
        );
      else problems.push("No running emulator or device. Start one: emulator -avd <name>  (list: emulator -list-avds)");
    }
    const needsMaestro = this.ctx.manifest.screens.some((s) => /\.ya?ml$/i.test(s.flow ?? ""));
    if (needsMaestro && !(await findTool("maestro")))
      problems.push("screens.json uses Maestro flows but maestro is not installed: curl -fsSL https://get.maestro.mobile.dev | bash");
    return { ok: problems.length === 0, problems };
  }

  private devices: { serial: string; model: string }[] = [];
  private adbPath: string | null = null;

  /**
   * One connected device is used as is. With several, `--device` / `app.device`
   * picks one by serial, model name, or "emulator".
   */
  private async findDevice(): Promise<string | null> {
    if (this.serial) return this.serial;
    this.adbPath ??= await findTool("adb");
    if (!this.adbPath) return null;
    const r = await run(this.adbPath, ["devices", "-l"]);
    this.devices = r.stdout
      .toString()
      .split("\n")
      .slice(1)
      .map((l) => l.trim().split(/\s+/))
      .filter((p) => p[1] === "device")
      .map((p) => ({ serial: p[0]!, model: p.find((x) => x.startsWith("model:"))?.slice(6) ?? "" }));
    const want = this.ctx.device;
    if (want) {
      const w = want.toLowerCase();
      const hit =
        this.devices.find((d) => d.serial === want) ??
        this.devices.find((d) => d.model.toLowerCase() === w) ??
        (w === "emulator" ? this.devices.find((d) => d.serial.startsWith("emulator-")) : undefined);
      this.serial = hit?.serial ?? null;
    } else if (this.devices.length === 1) {
      this.serial = this.devices[0]!.serial;
    }
    return this.serial;
  }

  private adb(args: string[], timeoutMs = 30_000) {
    return run(this.adbPath ?? "adb", ["-s", this.serial!, ...args], { timeoutMs });
  }

  async prepare(screen: ScreenEntry) {
    const serial = await this.findDevice();
    if (!serial) throw new CaptureError("no Android device");
    await runFlow(this.ctx, screen, ["--device", serial], { ANDROID_SERIAL: serial });
  }

  async capture(screen: ScreenEntry): Promise<ScreenCapture> {
    const serial = await this.findDevice();
    if (!serial) throw new CaptureError("no Android device");
    // the tree first: uiautomator waits for the UI to go idle, so the screenshot
    // taken right after shows the same settled screen (not a splash or animation)
    // a failed dump ("null root node" mid-transition) exits 0 and leaves the previous
    // screen's file: delete it first, and retry until the dump really succeeds
    let raw: RawElement | null = null;
    let lastErr = "";
    for (let attempt = 0; attempt < 6 && !raw; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 700));
      await this.adb(["shell", "rm", "-f", "/sdcard/intentcue_dump.xml"]);
      const d = await this.adb(["shell", "uiautomator", "dump", "/sdcard/intentcue_dump.xml"], 60_000);
      const msg = `${d.stdout.toString()}${d.stderr}`;
      if (d.code !== 0 || /ERROR/i.test(msg)) {
        lastErr = msg.trim();
        continue;
      }
      const x = await this.adb(["exec-out", "cat", "/sdcard/intentcue_dump.xml"]);
      if (x.code === 0 && x.stdout.length > 0) raw = parseUiautomator(x.stdout.toString());
    }
    if (!raw) throw new CaptureError("could not read the screen's element tree (uiautomator)", lastErr);

    const shot = screenshotPath(this.ctx, screen.id);
    const s = await this.adb(["exec-out", "screencap", "-p"]);
    if (s.code !== 0 || s.stdout.length < 24) throw new CaptureError(`screencap failed for "${screen.id}"`, s.stderr);
    await writePng(shot.abs, s.stdout);
    const px = pngSize(s.stdout);

    const dens = await this.adb(["shell", "wm", "density"]);
    const dpi = Number(/(\d+)\s*$/.exec(dens.stdout.toString().trim())?.[1] ?? 160);
    const scale = Math.round((dpi / 160) * 100) / 100 || 1;
    const model = (await this.adb(["shell", "getprop", "ro.product.model"])).stdout.toString().trim();
    const device = { name: model || serial, width: Math.round(px.width / scale), height: Math.round(px.height / scale), scale };
    return toCapture(screen, "android", device, shot.rel, raw, px);
  }
}
