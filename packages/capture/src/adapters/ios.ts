import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawElement, ScreenCapture, ScreenEntry } from "@intentcue/core";
import { CaptureError, run, which } from "../exec.js";
import { findTool } from "../tools.js";
import { parseIdb } from "../parsers/idb.js";
import { parseMaestro } from "../parsers/maestro.js";
import { pngSize } from "../png.js";
import type { CaptureAdapter, CaptureContext } from "../types.js";
import { runFlow, screenshotPath, toCapture, writePng } from "./shared.js";

type SimDevice = { udid: string; name: string; state: string };

/**
 * iOS simulator: Maestro flows for navigation, `simctl` for screenshots,
 * Maestro hierarchy (or idb) for the element tree.
 */
export class IosAdapter implements CaptureAdapter {
  readonly platform = "ios" as const;
  private sim: SimDevice | null = null;
  private tree: "maestro" | "idb" | null = null;
  private booted: SimDevice[] = [];
  private maestroPath: string | null = null;
  private idbPath: string | null = null;

  constructor(private ctx: CaptureContext) {}

  async check() {
    const problems: string[] = [];
    if (!(await which("xcrun")))
      problems.push("xcrun not found. Install Xcode and run: xcode-select --install");
    else {
      const sim = await this.findSim();
      if (!sim)
        problems.push(
          this.ctx.device
            ? `No booted simulator matches "${this.ctx.device}". Boot it: xcrun simctl boot "${this.ctx.device}"`
            : this.booted.length > 1
              ? `${this.booted.length} simulators are booted; pick one with --device <name|udid> or "device" under "app" in screens.json:\n` +
                this.booted.map((d) => `    ${d.name}  ${d.udid}`).join("\n")
              : "No booted iOS simulator. Open Simulator.app or run: xcrun simctl boot \"iPhone 16\"",
        );
    }
    const maestro = await findTool("maestro");
    const idb = await findTool("idb");
    this.maestroPath = maestro;
    this.idbPath = idb;
    if (!maestro && !idb)
      problems.push(
        "Neither maestro nor idb found (needed for the element tree).\n" +
          "  Install Maestro: curl -fsSL https://get.maestro.mobile.dev | bash\n" +
          "  or idb:          brew tap facebook/fb && brew install idb-companion && pip3 install fb-idb",
      );
    const needsMaestro = this.ctx.manifest.screens.some((s) => /\.ya?ml$/i.test(s.flow ?? ""));
    if (needsMaestro && !maestro)
      problems.push("screens.json uses Maestro flows but maestro is not installed: curl -fsSL https://get.maestro.mobile.dev | bash");
    this.tree = maestro ? "maestro" : idb ? "idb" : null;
    return { ok: problems.length === 0, problems };
  }

  private async findSim(): Promise<SimDevice | null> {
    if (this.sim) return this.sim;
    const r = await run("xcrun", ["simctl", "list", "devices", "booted", "-j"]);
    if (r.code !== 0) return null;
    const data = JSON.parse(r.stdout.toString()) as { devices: Record<string, SimDevice[]> };
    const booted = Object.values(data.devices).flat().filter((d) => d.state === "Booted");
    const want = this.ctx.device;
    this.booted = booted;
    // several booted simulators: require an explicit choice
    this.sim = (want ? booted.find((d) => d.udid === want || d.name === want) : booted.length === 1 ? booted[0] : undefined) ?? null;
    return this.sim;
  }

  async prepare(screen: ScreenEntry) {
    const sim = await this.findSim();
    if (!sim) throw new CaptureError("no booted simulator");
    await runFlow(this.ctx, screen, ["--udid", sim.udid], { INTENTCUE_UDID: sim.udid });
  }

  async capture(screen: ScreenEntry): Promise<ScreenCapture> {
    const sim = await this.findSim();
    if (!sim) throw new CaptureError("no booted simulator");
    if (!this.tree) await this.check();

    const shot = screenshotPath(this.ctx, screen.id);
    const tmp = join(tmpdir(), `intentcue-${process.pid}-${screen.id}.png`);
    const r = await run("xcrun", ["simctl", "io", sim.udid, "screenshot", "--type=png", tmp], { timeoutMs: 30_000 });
    if (r.code !== 0) throw new CaptureError(`screenshot failed for "${screen.id}"`, r.stderr);
    const png = await readFile(tmp);
    await rm(tmp, { force: true });
    await writePng(shot.abs, png);
    const px = pngSize(png);

    const raw = await this.hierarchy(sim.udid, px.width);
    const pointsW = raw.points.w || px.width / 3;
    const scale = Math.round((px.width / pointsW) * 100) / 100;
    const device = { name: sim.name, width: Math.round(px.width / scale), height: Math.round(px.height / scale), scale };
    return toCapture(screen, "ios", device, shot.rel, raw.tree(scale), px);
  }

  /** Returns a tree factory (bounds depend on scale) and the root's size in points. */
  private async hierarchy(udid: string, pxWidth: number) {
    if (this.tree === "maestro") {
      const r = await run(this.maestroPath ?? "maestro", ["--udid", udid, "hierarchy"], { timeoutMs: 90_000 });
      if (r.code !== 0) throw new CaptureError("maestro hierarchy failed", r.stderr);
      const out = r.stdout.toString();
      const probe = parseMaestro(out, "ios", 1);
      return { points: probe.bounds, tree: (s: number): RawElement => parseMaestro(out, "ios", s) };
    }
    if (this.tree === "idb") {
      const r = await run(this.idbPath ?? "idb", ["ui", "describe-all", "--udid", udid, "--json", "--nested"], { timeoutMs: 60_000 });
      let out = r.stdout.toString();
      if (r.code !== 0) {
        const flat = await run(this.idbPath ?? "idb", ["ui", "describe-all", "--udid", udid, "--json"], { timeoutMs: 60_000 });
        if (flat.code !== 0) throw new CaptureError("idb ui describe-all failed", flat.stderr);
        out = flat.stdout.toString();
      }
      const probe = parseIdb(out, 1);
      return { points: probe.bounds, tree: (s: number): RawElement => parseIdb(out, s) };
    }
    throw new CaptureError("no element tree tool available (maestro or idb)", `screenshot is ${pxWidth}px wide`);
  }
}
