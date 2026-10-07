import { EventEmitter } from "node:events";
import { run } from "../exec.js";
import { findTool } from "../tools.js";
import { captureAndroidLive, readRotation } from "./androidCapture.js";
import { avcCodecString, Keycode, MotionAction, ScrcpySession } from "./scrcpy.js";
import {
  scalePoint,
  type Capabilities,
  type CaptureProgress,
  type DeviceInfo,
  type EditKey,
  type LiveCapture,
  type LiveEvents,
  type LiveInput,
  type LiveKey,
  type LiveSession,
  type LiveSize,
  type LiveTarget,
  type Rotation,
  type ViewPoint,
} from "./session.js";

/**
 * Android emulators and USB phones, live: scrcpy's H.264 stream and control
 * channel, captures with `screencap` + `uiautomator` and the verify step.
 * A session that loses its stream (server killed, cable pulled, emulator
 * restarted) reconnects on its own while the device is there.
 */

export type AndroidTargetOptions = {
  /** The scrcpy-server jar of SCRCPY_VERSION. */
  serverJar: string;
  adb?: string;
  /** Longest side of the video; captures always use the full resolution. */
  maxSize?: number;
  maxFps?: number;
  /** How long a lost device is waited for before giving up. */
  reconnectForMs?: number;
  log?: (line: string) => void;
};

const CAPABILITIES: Capabilities = {
  video: "h264",
  pointer: true,
  scroll: true,
  text: true,
  keys: ["back", "home", "recents", "lock"],
  rotate: true,
  orientation: "auto",
};

const KEYS: Record<LiveKey, number> = { home: Keycode.home, back: Keycode.back, recents: Keycode.appSwitch, lock: Keycode.power };
const EDIT: Record<EditKey, number> = {
  enter: Keycode.enter,
  backspace: Keycode.del,
  delete: Keycode.forwardDel,
  tab: Keycode.tab,
  escape: Keycode.escape,
  up: Keycode.up,
  down: Keycode.down,
  left: Keycode.left,
  right: Keycode.right,
  home: Keycode.moveHome,
  end: Keycode.moveEnd,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `adb devices -l` lines → devices; states other than "device" say why one can't be shown. */
export function parseAdbDevices(out: string): { serial: string; state: DeviceInfo["state"]; model: string }[] {
  return out
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 2 && p[0])
    .map((p) => ({
      serial: p[0]!,
      state: p[1] === "device" ? "ready" : p[1] === "unauthorized" ? "unauthorized" : "offline",
      model: (p.find((x) => x.startsWith("model:"))?.slice(6) ?? "").replace(/_/g, " "),
    }));
}

/** `wm size` / `wm density`: the override when one is set, else the physical value. */
export function parseWm(out: string): number[] | null {
  const pick = /Override \w+: ([\dx]+)/.exec(out) ?? /Physical \w+: ([\dx]+)/.exec(out);
  return pick ? pick[1]!.split("x").map(Number) : null;
}

export class AndroidTarget implements LiveTarget {
  constructor(private opts: AndroidTargetOptions) {}

  private async adbPath() {
    return this.opts.adb ?? (await findTool("adb")) ?? "adb";
  }

  async list(): Promise<DeviceInfo[]> {
    const adb = await this.adbPath();
    const r = await run(adb, ["devices", "-l"], { timeoutMs: 10_000 });
    if (r.code !== 0) return [];
    return Promise.all(
      parseAdbDevices(r.stdout.toString()).map(async (d) => {
        const emulator = d.serial.startsWith("emulator-");
        let name = d.model || d.serial;
        if (emulator && d.state === "ready") {
          const avd = (await run(adb, ["-s", d.serial, "shell", "getprop", "ro.boot.qemu.avd_name"], { timeoutMs: 5000 })).stdout.toString().trim();
          if (avd) name = avd.replace(/_/g, " ");
        }
        if (emulator && d.state === "ready") {
          const booted = (await run(adb, ["-s", d.serial, "shell", "getprop", "sys.boot_completed"], { timeoutMs: 5000 })).stdout.toString().trim();
          if (booted !== "1") return { id: d.serial, name, kind: "emulator" as const, state: "booting" as const };
        }
        return { id: d.serial, name, kind: emulator ? ("emulator" as const) : ("phone" as const), state: d.state };
      }),
    );
  }

  async connect(serial: string, signal?: AbortSignal): Promise<LiveSession> {
    const devices = await this.list();
    const d = devices.find((x) => x.id === serial);
    if (!d) throw new Error(`${serial} isn't connected`);
    if (d.state === "unauthorized") throw new Error(`${d.name}: allow USB debugging on the phone (a prompt is waiting there)`);
    if (d.state !== "ready") throw new Error(`${d.name} isn't ready (${d.state})`);
    const s = new AndroidSession(serial, d.name, await this.adbPath(), this.opts);
    await s.open(signal);
    return s;
  }
}

class AndroidSession implements LiveSession {
  readonly capabilities = CAPABILITIES;
  size: LiveSize = { width: 0, height: 0, scale: 1, rotation: 0 };
  private natural = { width: 0, height: 0 };
  private model = "";
  private scrcpy: ScrcpySession | null = null;
  private events = new EventEmitter();
  private disposed = false;
  private reconnecting = false;

  constructor(
    readonly deviceId: string,
    readonly name: string,
    private adbPath: string,
    private opts: AndroidTargetOptions,
  ) {}

  private adb = (args: string[], timeoutMs = 30_000) => run(this.adbPath, ["-s", this.deviceId, ...args], { timeoutMs });

  on<E extends keyof LiveEvents>(event: E, cb: (e: LiveEvents[E]) => void): () => void {
    this.events.on(event, cb);
    return () => void this.events.off(event, cb);
  }

  private emit<E extends keyof LiveEvents>(event: E, e: LiveEvents[E]) {
    this.events.emit(event, e);
  }

  async open(signal?: AbortSignal) {
    const [size, density, model] = await Promise.all([
      this.adb(["shell", "wm", "size"]),
      this.adb(["shell", "wm", "density"]),
      this.adb(["shell", "getprop", "ro.product.model"]),
    ]);
    const wh = parseWm(size.stdout.toString());
    if (!wh || wh.length !== 2) throw new Error(`can't read ${this.name}'s screen size`);
    this.natural = { width: Math.min(wh[0]!, wh[1]!), height: Math.max(wh[0]!, wh[1]!) };
    const dpi = parseWm(density.stdout.toString())?.[0] ?? 160;
    this.size = { ...this.size, scale: Math.round((dpi / 160) * 100) / 100 || 1 };
    this.model = model.stdout.toString().trim();
    if (signal?.aborted) throw new Error("cancelled");
    await this.start();
    if (signal?.aborted) {
      await this.dispose();
      throw new Error("cancelled");
    }
  }

  private async start() {
    const s = await ScrcpySession.start({
      serial: this.deviceId,
      adb: this.adbPath,
      serverJar: this.opts.serverJar,
      maxSize: this.opts.maxSize ?? 1280,
      maxFps: this.opts.maxFps ?? 60,
      log: this.opts.log,
    });
    if (this.disposed) return s.close("disposed");
    this.scrcpy = s;
    s.on("session", (v) => void this.resized(v.width, v.height));
    s.on("packet", (p) =>
      this.emit("frame", { config: p.config, key: p.key, pts: p.pts, data: p.data, ...(p.config ? { codec: avcCodecString(p.data) ?? undefined } : {}) }),
    );
    s.on("close", (reason) => {
      if (this.scrcpy === s && !this.disposed) void this.reconnect(reason);
    });
    // live means a known size: the video's first session packet can come a moment after the codec
    if (!s.video) await new Promise<void>((done) => {
      const t = setTimeout(done, 20_000);
      s.once("session", () => (clearTimeout(t), done()));
      s.once("close", () => (clearTimeout(t), done()));
    });
    if (s.video) await this.resized(s.video.width, s.video.height);
  }

  /** A new video session (start, rotation): the device's size follows the video's shape. */
  private async resized(vw: number, vh: number) {
    const landscape = vw > vh;
    const { width, height } = this.natural;
    const guess: Rotation = landscape ? 90 : 0;
    this.size = { ...this.size, width: landscape ? height : width, height: landscape ? width : height, rotation: guess };
    this.emit("resize", this.size);
    const rotation = await readRotation(this.adb, landscape).catch(() => guess);
    if (rotation !== this.size.rotation && (rotation % 180 === 90) === landscape) {
      this.size = { ...this.size, rotation };
      this.emit("resize", this.size);
    }
  }

  private async reconnect(reason: string) {
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.scrcpy = null;
    this.emit("disconnect", { reason });
    const deadline = Date.now() + (this.opts.reconnectForMs ?? 60_000);
    let wait = 300;
    let last = reason;
    try {
      while (!this.disposed && Date.now() < deadline) {
        const state = (await this.adb(["get-state"], 5000)).stdout.toString().trim();
        if (state === "device") {
          try {
            await this.start();
            if (this.disposed) return;
            this.emit("reconnect", this.size);
            return;
          } catch (e) {
            last = (e as Error).message;
          }
        } else last = `${this.name} is ${state || "not connected"}`;
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

  async input(ev: LiveInput) {
    const s = this.scrcpy;
    if (!s || s.isClosed) throw new Error(`${this.name} is reconnecting`);
    const video = () => {
      const v = s.video;
      if (!v) throw new Error("no video yet");
      return v;
    };
    switch (ev.type) {
      case "pointer": {
        const v = video();
        const p = scalePoint(ev, v.width, v.height);
        s.touch(MotionAction[ev.action], p.x, p.y);
        return;
      }
      case "scroll": {
        const v = video();
        const p = scalePoint(ev, v.width, v.height);
        s.scroll(p.x, p.y, ev.dx, ev.dy);
        return;
      }
      case "key":
        return s.press(KEYS[ev.key]);
      case "edit":
        return s.press(EDIT[ev.key]);
      case "text":
        // scrcpy takes up to 300 bytes per message
        for (const part of chunkText(ev.text, 300)) s.text(part);
        return;
      case "rotate": {
        // portrait ↔ landscape, locked: auto-rotate goes off, as with Android's own rotate button
        // (scrcpy's rotate thaws auto-rotate again, and the sensor turns the screen straight back;
        // it also reads the rotation while turning auto-rotate off can still be applying an old one)
        const now = await readRotation(this.adb, this.size.width > this.size.height);
        const next = now % 180 === 0 ? 1 : 0;
        await this.adb(["shell", `settings put system accelerometer_rotation 0; settings put system user_rotation ${next}`], 8000);
        return;
      }
    }
  }

  resetVideo() {
    if (this.scrcpy && !this.scrcpy.isClosed) this.scrcpy.resetVideo();
  }

  async capture(signal: AbortSignal, progress: (p: CaptureProgress) => void): Promise<LiveCapture> {
    const c = await captureAndroidLive({ adb: this.adbPath, serial: this.deviceId, signal, progress: (step, attempt) => progress({ step, attempt }) });
    return {
      png: c.png,
      raw: c.raw,
      device: { name: this.name || this.model || c.model, width: Math.round(c.width / c.scale), height: Math.round(c.height / c.scale), scale: c.scale },
      orientation: c.width > c.height ? "landscape" : "portrait",
      settled: c.settled,
      elements: c.elements,
      attempts: c.attempts,
      firstPng: c.firstPng,
      lastPng: c.lastPng,
    };
  }

  async dispose() {
    this.disposed = true;
    this.scrcpy?.close("closed");
    this.scrcpy = null;
    this.events.removeAllListeners();
  }
}

/** Split text into pieces of at most `max` UTF-8 bytes, never inside a character. */
export function chunkText(text: string, max: number): string[] {
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of text) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > max && cur) {
      out.push(cur);
      cur = "";
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  if (cur) out.push(cur);
  return out;
}
