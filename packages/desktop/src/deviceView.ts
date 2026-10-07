import { appendFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { app, type WebContents } from "electron";
import {
  AndroidTarget,
  AXE_INSTALL,
  bootSimulatorHeadless,
  findTool,
  installEnv,
  IosTarget,
  listSimulatorsLive,
  listAvds,
  run,
  SCRCPY_VERSION,
  startEmulator,
  type Capabilities,
  type CaptureProgress,
  type DeviceInfo,
  type LiveCapture,
  type LiveInput,
  type LiveSession,
  type LiveSize,
  type LiveTarget,
} from "@scribui/capture";
import type { ViewSaveResult } from "@scribui/server";
import { activityTitle } from "./deviceInput.js";
import type { LiveCaptureRequest, SaveView } from "./webCapture.js";

/**
 * The device tab of a mobile project: one live session at a time, its video
 * handed to the canvas (which decodes it with WebCodecs), the canvas's
 * pointer and keys handed back, and captures with progress, cancel and the
 * "screen was still changing" choice.
 */

export type DeviceStatus = "idle" | "connecting" | "live" | "reconnecting" | "lost";

export type DeviceState = {
  status: DeviceStatus;
  device: { id: string; name: string } | null;
  size: LiveSize | null;
  capabilities: Capabilities | null;
  /** Why it isn't live (connect failed, the device is gone). */
  message: string | null;
};

export type DeviceList = {
  devices: DeviceInfo[];
  /** Emulators (AVD names) or simulators (UDIDs) that can be started: not running. */
  startable: { id: string; name: string }[];
  /** A tool the device view needs is missing (adb; AXe or the helper on iOS): what to run to get it, and whether the app can install it. */
  missing: { tool: string; install?: string; installable?: "adb" | "axe" } | null;
};

export type CaptureOutcome =
  | { kind: "saved"; result: ViewSaveResult }
  /** The screen kept changing: the canvas shows both frames and asks. */
  | { kind: "unsettled"; first: Uint8Array; last: Uint8Array; attempts: number; elements: boolean };

/** The jar the client is written for: next to the app when packaged, vendor/ in the repo (scripts/fetch-scrcpy.mjs). */
export function scrcpyServerJar(): string | null {
  const candidates = [
    process.env.SCRCPY_SERVER,
    app.isPackaged ? join(process.resourcesPath, "scrcpy-server") : resolve(__dirname, "../vendor/scrcpy-server"),
  ].filter((p): p is string => !!p);
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** The iOS Simulator helper: next to the app when packaged, vendor/ in the repo (scripts/build-sim-helper.mjs). */
export function simHelperPath(): string | null {
  const candidates = [
    process.env.SCRIBUI_SIM_HELPER,
    app.isPackaged ? join(process.resourcesPath, "scribui-sim") : resolve(__dirname, "../vendor/scribui-sim"),
  ].filter((p): p is string => !!p);
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** AXe's frameworks, which scribui-sim runs on (Homebrew, Apple Silicon or Intel). */
const axeFrameworks = () => ["/opt/homebrew/opt/axe/libexec/Frameworks", "/usr/local/opt/axe/libexec/Frameworks"].some((p) => existsSync(join(p, "FBSimulatorControl.framework")));

/** SCRIBUI_DEBUG_DEVICE=<file>: the scrcpy server's log, visibility and key frames, appended to that file (stdout is lost in the sRGB relaunch). */
const debugFile = process.env.SCRIBUI_DEBUG_DEVICE;
const debug = debugFile ? (l: string) => appendFileSync(debugFile, `${new Date().toISOString().slice(11, 23)} ${l}\n`) : null;

export class DeviceView {
  private session: LiveSession | null = null;
  private target: LiveTarget | null = null;
  private state: DeviceState = { status: "idle", device: null, size: null, capabilities: null, message: null };
  private visible = false;
  private connecting: AbortController | null = null;
  private capturing: AbortController | null = null;
  private pending: { capture: LiveCapture; req: LiveCaptureRequest } | null = null;
  private off: (() => void)[] = [];

  constructor(
    private canvas: WebContents,
    private platform: "android" | "ios",
  ) {}

  private send(channel: string, payload: unknown) {
    if (!this.canvas.isDestroyed()) this.canvas.send(channel, payload);
  }

  private set(patch: Partial<DeviceState>) {
    this.state = { ...this.state, ...patch };
    this.send("scribui:device-state", this.state);
  }

  getState() {
    return this.state;
  }

  private async getTarget(): Promise<LiveTarget> {
    if (this.target) return this.target;
    if (this.platform === "ios") {
      const helper = simHelperPath();
      if (!helper) throw new Error("scribui-sim is missing from the app (run scripts/build-sim-helper.mjs)");
      this.target = new IosTarget({ helper, ...(debug ? { log: debug } : {}) });
      return this.target;
    }
    const jar = scrcpyServerJar();
    if (!jar) throw new Error(`scrcpy-server ${SCRCPY_VERSION} is missing from the app (run scripts/fetch-scrcpy.mjs)`);
    const adb = await findTool("adb");
    this.target = new AndroidTarget({ serverJar: jar, ...(adb ? { adb } : {}), ...(debug ? { log: debug } : {}) });
    return this.target;
  }

  async list(): Promise<DeviceList> {
    if (this.platform === "ios") return this.listSimulators();
    if (!(await findTool("adb"))) {
      const install = { darwin: "brew install --cask android-platform-tools", win32: "winget install Google.PlatformTools", linux: "sudo apt install adb" }[
        process.platform as "darwin"
      ];
      return { devices: [], startable: [], missing: { tool: "adb", ...(install ? { install } : {}), installable: "adb" } };
    }
    const target = await this.getTarget();
    const [devices, avds] = await Promise.all([target.list(), listAvds().catch(() => [])]);
    const running = new Set(devices.filter((d) => d.kind === "emulator").map((d) => d.name.replace(/ /g, "_")));
    return { devices, startable: avds.filter((a) => !running.has(a)).map((a) => ({ id: a, name: a.replace(/_/g, " ") })), missing: null };
  }

  private async listSimulators(): Promise<DeviceList> {
    const none = (tool: string, install?: string, installable?: "axe"): DeviceList => ({
      devices: [],
      startable: [],
      missing: { tool, ...(install ? { install } : {}), ...(installable ? { installable } : {}) },
    });
    if (process.platform !== "darwin") return none("a Mac (the iOS Simulator only runs on macOS)");
    if (!(await findTool("axe")) || !axeFrameworks()) return none("AXe", AXE_INSTALL, (await installEnv()).brew ? "axe" : undefined);
    if (!simHelperPath()) return none("scribui-sim, built with the app", "pnpm --filter @scribui/desktop exec node scripts/build-sim-helper.mjs");
    const { devices, startable } = await listSimulatorsLive();
    return { devices, startable, missing: null };
  }

  async connect(id: string) {
    if (this.state.device?.id === id && (this.state.status === "live" || this.state.status === "reconnecting")) return this.state;
    await this.disconnect();
    const ac = new AbortController();
    this.connecting = ac;
    this.set({ status: "connecting", device: { id, name: id }, size: null, capabilities: null, message: null });
    try {
      const s = await (await this.getTarget()).connect(id, ac.signal);
      if (ac.signal.aborted) {
        await s.dispose();
        return this.state;
      }
      this.attach(s);
      this.set({ status: "live", device: { id, name: s.name }, size: s.size, capabilities: s.capabilities, message: null });
    } catch (e) {
      if (!ac.signal.aborted) this.set({ status: "lost", message: (e as Error).message });
    } finally {
      if (this.connecting === ac) this.connecting = null;
    }
    return this.state;
  }

  private attach(s: LiveSession) {
    this.session = s;
    this.off = [
      s.on("frame", (f) => {
        if (debug && (f.config || f.key)) debug(`frame config=${f.config} key=${f.key} visible=${this.visible} bytes=${f.data.length}`);
        if (!this.visible) return;
        this.send("scribui:device-frame", { config: f.config, key: f.key, pts: Number(f.pts), data: f.data, ...(f.codec ? { codec: f.codec } : {}) });
      }),
      s.on("resize", (size) => this.set({ size })),
      s.on("disconnect", ({ reason }) => this.set({ status: "reconnecting", message: reason })),
      s.on("reconnect", (size) => this.set({ status: "live", size, message: null })),
      s.on("error", ({ message }) => {
        this.detach();
        this.set({ status: "lost", message });
      }),
    ];
  }

  private detach() {
    for (const f of this.off) f();
    this.off = [];
    const s = this.session;
    this.session = null;
    return s;
  }

  async disconnect() {
    this.connecting?.abort();
    this.capturing?.abort();
    this.pending = null;
    const s = this.detach();
    await s?.dispose();
    this.set({ status: "idle", device: null, size: null, capabilities: null, message: null });
  }

  /** Frames only go to the canvas while the device tab shows; coming back asks for a key frame. */
  setVisible(v: boolean) {
    debug?.(`visible ${this.visible} → ${v}`);
    if (v === this.visible) return;
    this.visible = v;
    if (v) this.session?.resetVideo();
  }

  resetVideo() {
    debug?.(`reset video (session: ${!!this.session})`);
    this.session?.resetVideo();
  }

  async input(ev: LiveInput) {
    if (!this.session || this.capturing) return;
    // only the keys this device has (iOS: no Back or Recents)
    if (ev.type === "key" && !this.session.capabilities.keys.includes(ev.key)) return;
    await this.session.input(ev);
  }

  /** Start an emulator or boot a simulator, wait until it's up, and show it. */
  async start(id: string) {
    if (this.platform === "ios") return this.bootSimulator(id);
    return this.startEmulator(id);
  }

  private async bootSimulator(udid: string) {
    const known = (await listSimulatorsLive()).startable.find((s) => s.id === udid);
    if (!known) throw new Error("no shut-down simulator with that id");
    await this.disconnect();
    this.set({ status: "connecting", device: { id: udid, name: `${known.name} (starting)` }, message: null });
    if (!(await bootSimulatorHeadless(udid))) {
      this.set({ status: "lost", message: `${known.name} didn't finish starting` });
      return this.state;
    }
    return this.connect(udid);
  }

  private async startEmulator(avd: string) {
    const known = await listAvds();
    if (!known.includes(avd)) throw new Error(`no emulator named ${avd}`);
    await this.disconnect();
    this.set({ status: "connecting", device: { id: avd, name: `${avd.replace(/_/g, " ")} (starting)` }, message: null });
    const ok = await startEmulator(avd);
    if (!ok) {
      this.set({ status: "lost", message: `${avd} didn't finish starting within 3 minutes` });
      return this.state;
    }
    const devices = await (await this.getTarget()).list();
    const started = devices.find((d) => d.kind === "emulator" && d.state === "ready" && d.name.replace(/ /g, "_") === avd);
    if (!started) {
      this.set({ status: "lost", message: `${avd} started but adb doesn't list it` });
      return this.state;
    }
    return this.connect(started.id);
  }

  /**
   * Capture what's on screen now. Settled: saved right away. Still changing
   * after every attempt: kept here until the user keeps the first frame
   * (`keep`) or tries again.
   */
  async capture(req: LiveCaptureRequest, save: SaveView): Promise<CaptureOutcome> {
    const s = this.session;
    if (!s || this.state.status !== "live") throw new Error("no device is showing");
    if (this.capturing) throw new Error("a capture is already running");
    const ac = new AbortController();
    this.capturing = ac;
    this.pending = null;
    try {
      const progress = (p: CaptureProgress) => this.send("scribui:device-progress", p);
      const c = await s.capture(ac.signal, progress);
      if (ac.signal.aborted) throw new Error("capture cancelled");
      if (!c.settled) {
        this.pending = { capture: c, req };
        return { kind: "unsettled", first: c.firstPng, last: c.lastPng, attempts: c.attempts, elements: c.elements };
      }
      return { kind: "saved", result: await this.save(c, req, save, false) };
    } finally {
      if (this.capturing === ac) this.capturing = null;
    }
  }

  /** Keep the frame from when Capture was pressed, with a note that element positions may be off. */
  async keep(save: SaveView): Promise<ViewSaveResult> {
    const p = this.pending;
    if (!p) throw new Error("nothing is waiting to be kept");
    this.pending = null;
    return this.save({ ...p.capture, png: p.capture.firstPng }, p.req, save, true);
  }

  discard() {
    this.pending = null;
  }

  cancelCapture() {
    this.capturing?.abort();
  }

  private async save(c: LiveCapture, req: LiveCaptureRequest, save: SaveView, unsettled: boolean) {
    const title = req.title?.trim() || (await this.foregroundTitle()) || undefined;
    return save({
      platform: this.platform,
      ...(title ? { title } : {}),
      ...(req.replace ? { replace: req.replace } : {}),
      orientation: c.orientation,
      device: c.device,
      png: c.png,
      raw: c.raw,
      ...(unsettled ? { unsettled: true } : {}),
      ...(c.elements ? {} : { noElements: true }),
    });
  }

  /** A name for the view from what's in front: the session's own (the iOS app), or the Android activity ("…/.wifi.WifiSettingsActivity" → "Wifi Settings"). */
  private async foregroundTitle(): Promise<string | null> {
    const id = this.state.device?.id;
    if (this.session?.foregroundTitle) return this.session.foregroundTitle().catch(() => null);
    if (!id || this.platform !== "android") return null;
    const adb = (await findTool("adb")) ?? "adb";
    const r = await run(adb, ["-s", id, "shell", "dumpsys", "activity", "activities"], { timeoutMs: 8000 });
    return activityTitle(r.stdout.toString());
  }

  dispose() {
    void this.disconnect();
  }
}
