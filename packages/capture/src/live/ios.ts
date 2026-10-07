import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { run } from "../exec.js";
import { captureIosLive } from "./iosCapture.js";
import {
  HID_USAGE,
  IOS_EDIT_KEYS,
  parseDeviceProfile,
  parseSimctlDevices,
  simulatorDevices,
  toPortraitPoints,
  turnFor,
  uiOrientation,
  type SimOrientation,
  type SimulatorEntry,
} from "./iosScreen.js";
import { scalePoint, type Capabilities, type CaptureProgress, type DeviceInfo, type LiveCapture, type LiveEvents, type LiveInput, type LiveSession, type LiveSize, type LiveTarget, type ViewPoint } from "./session.js";
import { SimHelper } from "./simHelper.js";

/**
 * The iOS Simulator, live (macOS only): the `scribui-sim` helper holds the
 * simulator's HID connection and H.264 stream (a touch costs milliseconds),
 * captures are `simctl io screenshot` + the accessibility tree with the
 * verify step. A session whose helper stops (simulator restarted, shut down)
 * reconnects on its own while the simulator is booted.
 */

export type IosTargetOptions = {
  /** The scribui-sim binary. */
  helper: string;
  /** The stream's size relative to the screen; captures always use the full resolution. */
  videoScale?: number;
  reconnectForMs?: number;
  log?: (line: string) => void;
};

const CAPABILITIES: Capabilities = {
  video: "h264",
  pointer: true,
  scroll: true,
  text: true,
  physicalKeys: true,
  keys: ["home", "lock"],
  rotate: true,
  orientation: "auto",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wheel units (the canvas sends about 1 per 100 px of scrolling) → points the finger moves. */
const SCROLL_POINTS = 60;
/** A scroll gesture ends (the finger lifts) this long after the last wheel event. */
const SCROLL_IDLE_MS = 120;
/** Grid (points) for finding web views' elements: 25 found every element of the test pages in ~1.8 s; 10 takes ~10 s. */
const REMOTE_GRID_POINTS = 25;
/** How often the UI's orientation is checked while the device is turned (an app may refuse a turn, or follow it later). */
const ORIENTATION_POLL_MS = 2000;

export async function listSimulatorEntries(): Promise<SimulatorEntry[]> {
  return (await readSimulatorEntries()).sims;
}

/** The simulators, or why simctl couldn't list them (it can take a while right after Xcode is switched or a simulator boots). */
async function readSimulatorEntries(timeoutMs = 20_000): Promise<{ sims: SimulatorEntry[]; error: string | null }> {
  const r = await run("xcrun", ["simctl", "list", "devices", "-j"], { timeoutMs });
  if (r.code !== 0) return { sims: [], error: `simctl list failed (exit ${r.code}): ${r.stderr.trim().split("\n").slice(-2).join(" ")}` };
  return { sims: parseSimctlDevices(r.stdout.toString()), error: null };
}

/** A device type's screen: pixels (portrait) and scale, from its profile in the Simulator's device types. */
async function deviceProfile(deviceType: string | null) {
  if (!deviceType) return null;
  const r = await run("xcrun", ["simctl", "list", "devicetypes", "-j"], { timeoutMs: 20_000 });
  if (r.code !== 0) return null;
  const types = (JSON.parse(r.stdout.toString()) as { devicetypes: { identifier: string; bundlePath?: string }[] }).devicetypes;
  const bundle = types.find((t) => t.identifier === deviceType)?.bundlePath;
  if (!bundle) return null;
  const p = await run("plutil", ["-convert", "json", "-o", "-", `${bundle}/Contents/Resources/profile.plist`], { timeoutMs: 10_000 });
  return p.code === 0 ? parseDeviceProfile(p.stdout.toString()) : null;
}

/** Shut-down simulators (and booted ones) to show, newest iOS first. */
export async function listSimulatorsLive() {
  return simulatorDevices(await listSimulatorEntries());
}

/** Boot a simulator without opening Simulator.app (the device tab shows it), and wait until it's up. */
export async function bootSimulatorHeadless(udid: string): Promise<boolean> {
  const r = await run("xcrun", ["simctl", "boot", udid], { timeoutMs: 120_000 });
  if (r.code !== 0 && !/current state: Booted/i.test(r.stderr)) return false;
  const s = await run("xcrun", ["simctl", "bootstatus", udid, "-b"], { timeoutMs: 180_000 });
  return s.code === 0;
}

export class IosTarget implements LiveTarget {
  constructor(private opts: IosTargetOptions) {}

  async list(): Promise<DeviceInfo[]> {
    return (await listSimulatorsLive()).devices;
  }

  async connect(udid: string, signal?: AbortSignal): Promise<LiveSession> {
    // one retry with more time: a failed or slow listing isn't "no such simulator"
    let listed = await readSimulatorEntries();
    if (listed.error || !listed.sims.some((s) => s.udid === udid)) listed = await readSimulatorEntries(60_000);
    const sim = listed.sims.find((s) => s.udid === udid);
    if (!sim) throw new Error(listed.error ?? `no simulator ${udid} (simctl lists ${listed.sims.length}: ${listed.sims.slice(0, 5).map((s) => `${s.name} ${s.runtime} ${s.state}`).join(", ") || "none"})`);
    if (sim.state !== "Booted") throw new Error(`${sim.name} isn't booted (${sim.state.toLowerCase()})`);
    const profile = await deviceProfile(sim.deviceType);
    if (!profile) throw new Error(`can't read ${sim.name}'s screen size`);
    const s = new IosSession(udid, sim.name, profile, this.opts);
    await s.open(signal);
    return s;
  }
}

class IosSession implements LiveSession {
  readonly capabilities = CAPABILITIES;
  size: LiveSize;
  private helper: SimHelper | null = null;
  private events = new EventEmitter();
  private disposed = false;
  private reconnecting = false;
  /** Where the device was turned; the UI follows when the app allows it. */
  private device: SimOrientation = "portrait";
  private ui: SimOrientation = "portrait";
  private portraitPoints: { width: number; height: number };
  private finger: { x: number; y: number; origin: ViewPoint } | null = null;
  private fingerTimer: NodeJS.Timeout | null = null;
  private poll: NodeJS.Timeout | null = null;
  private lastInput = 0;
  private capturing = false;
  private appName: string | null = null;

  constructor(
    readonly deviceId: string,
    readonly name: string,
    private profile: { width: number; height: number; scale: number },
    private opts: IosTargetOptions,
  ) {
    this.portraitPoints = { width: profile.width / profile.scale, height: profile.height / profile.scale };
    this.size = { width: profile.width, height: profile.height, scale: profile.scale, rotation: 0, videoRotation: 0 };
  }

  on<E extends keyof LiveEvents>(event: E, cb: (e: LiveEvents[E]) => void): () => void {
    this.events.on(event, cb);
    return () => void this.events.off(event, cb);
  }

  private emit<E extends keyof LiveEvents>(event: E, e: LiveEvents[E]) {
    this.events.emit(event, e);
  }

  async open(signal?: AbortSignal) {
    await this.start();
    if (signal?.aborted) {
      await this.dispose();
      throw new Error("cancelled");
    }
    this.poll = setInterval(() => {
      // only while turned: an upright iPhone shows apps upright
      if (this.device !== "portrait" && !this.capturing && Date.now() - this.lastInput > 400) void this.readOrientation();
    }, ORIENTATION_POLL_MS);
  }

  private async start() {
    const h = new SimHelper(this.opts.helper, this.deviceId, { scale: this.opts.videoScale ?? 0.5, log: this.opts.log });
    try {
      await Promise.race([h.ready, sleep(30_000).then(() => Promise.reject(new Error("scribui-sim didn't connect within 30 s")))]);
    } catch (e) {
      h.close();
      throw e;
    }
    if (this.disposed) return h.close();
    this.helper = h;
    h.on("packet", (p) => this.emit("frame", { config: p.config, key: p.key, pts: p.pts, data: p.data, ...(p.codec ? { codec: p.codec } : {}) }));
    h.on("warning", (m) => this.opts.log?.(`scribui-sim: ${m}`));
    h.on("close", (reason) => {
      if (this.helper === h && !this.disposed) void this.reconnect(reason);
    });
    // the simulator keeps its turn across helper restarts: send ours again
    if (this.device !== "portrait") h.send({ op: "orientation", value: this.device });
    h.send({ op: "stream", on: true });
    await this.readOrientation();
    // already turned before we came: that's where the device is
    if (this.device === "portrait" && this.ui !== "portrait") this.device = this.ui;
  }

  /** The UI's orientation from the frontmost app's frame; a change turns the view. */
  private async readOrientation() {
    const h = this.helper;
    if (!h || h.isClosed) return;
    try {
      const root = await h.call<{ frame?: { width: number; height: number }; AXLabel?: string } | null>({ op: "screen" }, 10_000);
      this.appName = root?.AXLabel?.trim() || null;
      this.setUi(uiOrientation(root?.frame ?? null, this.device));
    } catch {
      /* no frontmost app for a moment (springboard switching): keep what we have */
    }
  }

  private setUi(o: SimOrientation) {
    const turn = turnFor(o);
    const landscape = turn === 90 || turn === 270;
    const next: LiveSize = {
      width: landscape ? this.profile.height : this.profile.width,
      height: landscape ? this.profile.width : this.profile.height,
      scale: this.profile.scale,
      rotation: turn,
      videoRotation: turn,
    };
    this.ui = o;
    if (next.width === this.size.width && next.rotation === this.size.rotation) return;
    this.size = next;
    this.emit("resize", this.size);
  }

  private async reconnect(reason: string) {
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.helper = null;
    this.finger = null;
    this.emit("disconnect", { reason });
    const deadline = Date.now() + (this.opts.reconnectForMs ?? 60_000);
    let wait = 300;
    let last = reason;
    try {
      while (!this.disposed && Date.now() < deadline) {
        const sim = (await listSimulatorEntries()).find((s) => s.udid === this.deviceId);
        if (sim?.state === "Booted") {
          try {
            await this.start();
            if (this.disposed) return;
            this.emit("reconnect", this.size);
            return;
          } catch (e) {
            last = (e as Error).message;
          }
        } else last = sim ? `${this.name} is ${sim.state.toLowerCase()}` : `${this.name} is gone`;
        await sleep(wait);
        wait = Math.min(wait * 2, 3000);
      }
      if (!this.disposed) this.emit("error", { message: `lost ${this.name}: ${last}` });
    } finally {
      this.reconnecting = false;
    }
  }

  toDevice(p: ViewPoint) {
    return scalePoint(p, this.size.width, this.size.height);
  }

  private hid(p: ViewPoint) {
    return toPortraitPoints(p, this.ui, this.portraitPoints);
  }

  async input(ev: LiveInput) {
    const h = this.helper;
    if (!h || h.isClosed) throw new Error(`${this.name} is reconnecting`);
    this.lastInput = Date.now();
    switch (ev.type) {
      case "pointer":
        // a move is another touch-down at the new place
        h.send({ op: "touch", down: ev.action !== "up", ...this.hid(ev) });
        return;
      case "scroll":
        return this.scroll(h, ev);
      case "key":
        h.send({ op: "button", name: ev.key === "lock" ? "lock" : "home" });
        if (ev.key === "home") setTimeout(() => void this.readOrientation(), 800);
        return;
      case "edit":
        h.send({ op: "key", code: IOS_EDIT_KEYS[ev.key] });
        return;
      case "physical": {
        // the simulator applies its keyboard layout, as Simulator.app does
        const usage = HID_USAGE[ev.code];
        if (usage) h.send({ op: "press", code: usage, shift: ev.shift, alt: ev.alt });
        else if (ev.text) await this.paste(h, ev.text);
        return;
      }
      case "text":
        // pasted text: HID keys would come out in the simulator's keyboard layout
        return this.paste(h, ev.text);
      case "rotate": {
        // portrait ↔ landscape; the UI follows if the app allows it
        this.device = this.device === "portrait" ? "landscapeLeft" : "portrait";
        h.send({ op: "orientation", value: this.device });
        for (const ms of [500, 1200]) setTimeout(() => void this.readOrientation(), ms);
        return;
      }
    }
  }

  private async paste(h: SimHelper, text: string) {
    await pbcopy(this.deviceId, text);
    h.send({ op: "paste" });
  }

  /**
   * The Simulator has no wheel: a scroll is a finger dragged by the wheel's
   * distance, lifted once the wheel stops (iOS then flings as usual).
   */
  private scroll(h: SimHelper, ev: { x: number; y: number; dx: number; dy: number }) {
    const { width, height } = this.portraitPoints;
    const landscape = this.ui === "landscapeLeft" || this.ui === "landscapeRight";
    const w = landscape ? height : width;
    const hh = landscape ? width : height;
    if (!this.finger) {
      this.finger = { x: ev.x, y: ev.y, origin: { x: ev.x, y: ev.y } };
      h.send({ op: "touch", down: true, ...this.hid(this.finger) });
    }
    const f = this.finger;
    f.x = Math.min(1, Math.max(0, f.x + (ev.dx * SCROLL_POINTS) / w));
    f.y = Math.min(1, Math.max(0, f.y + (ev.dy * SCROLL_POINTS) / hh));
    h.send({ op: "touch", down: true, ...this.hid(f) });
    if (this.fingerTimer) clearTimeout(this.fingerTimer);
    this.fingerTimer = setTimeout(() => this.endScroll(), SCROLL_IDLE_MS);
  }

  private endScroll() {
    if (this.fingerTimer) clearTimeout(this.fingerTimer);
    this.fingerTimer = null;
    const end = this.finger;
    this.finger = null;
    if (end && this.helper) this.helper.send({ op: "touch", down: false, ...this.hid(end) });
  }

  resetVideo() {
    this.helper?.send({ op: "keyframe" });
  }

  async foregroundTitle() {
    await this.readOrientation();
    return this.appName;
  }

  async capture(signal: AbortSignal, progress: (p: CaptureProgress) => void): Promise<LiveCapture> {
    const h = this.helper;
    if (!h || h.isClosed) throw new Error(`${this.name} is reconnecting`);
    this.capturing = true;
    // a wheel scroll still holding its finger: lift it first. A held page stands still, so both
    // screenshots agree, but the accessibility tree leaves out the overscroll (a 150 pt pull read
    // as settled with every element 150 pt off); lifted, the bounce back shows as motion
    if (this.finger) {
      this.endScroll();
      await sleep(100);
    }
    try {
      const c = await captureIosLive({
        udid: this.deviceId,
        scale: this.profile.scale,
        device: this.device,
        describe: () => describeOnce(this.opts.helper, this.deviceId, this.portraitPoints),
        signal,
        progress: (step, attempt) => progress({ step, attempt }),
      });
      if (c.app) this.appName = c.app;
      this.setUi(c.orientation);
      return {
        png: c.png,
        raw: c.raw,
        device: { name: this.name, width: Math.round(c.width / c.scale), height: Math.round(c.height / c.scale), scale: c.scale },
        orientation: c.width > c.height ? "landscape" : "portrait",
        settled: c.settled,
        elements: c.elements,
        attempts: c.attempts,
        firstPng: c.firstPng,
        lastPng: c.lastPng,
      };
    } finally {
      this.capturing = false;
    }
  }

  async dispose() {
    this.disposed = true;
    if (this.poll) clearInterval(this.poll);
    if (this.fingerTimer) clearTimeout(this.fingerTimer);
    this.helper?.close();
    this.helper = null;
    this.events.removeAllListeners();
  }
}

/**
 * The frontmost app's tree for a capture, web views included, from a fresh
 * `scribui-sim describe`: idb finds web content by hit-testing a grid of
 * points and skips what it found before for the rest of its process, so the
 * live helper can't be asked twice.
 */
async function describeOnce(helper: string, udid: string, portrait: { width: number; height: number }): Promise<unknown> {
  // the grid covers the whole screen in the HID's portrait points (the app's frame is turned in landscape)
  const region = `0,0,${portrait.width},${portrait.height}`;
  const r = await run(helper, ["describe", "--udid", udid, "--remote-step", String(REMOTE_GRID_POINTS), "--region", region], { timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(`couldn't read the Simulator's elements: ${r.stderr.trim().split("\n").pop() ?? r.code}`);
  return JSON.parse(r.stdout.toString()) as unknown;
}

/** Put text on the simulator's pasteboard (for text the HID can't type). */
function pbcopy(udid: string, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn("xcrun", ["simctl", "pbcopy", udid], { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d: Buffer) => (err += d.toString()));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`simctl pbcopy failed: ${err.trim()}`))));
    p.stdin.end(text);
  });
}

