import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { connect, type Socket } from "node:net";
import { run } from "../exec.js";

/**
 * A client for scrcpy's device server, written for exactly one server version.
 * The protocol is internal to scrcpy and changes between releases
 * (doc/develop.md, "Protocol"): ship the server jar of SCRCPY_VERSION and
 * update this file together with it.
 *
 * One session: video (H.264, Annex B) from the device, control (touch, keys,
 * text) to it, over an `adb forward` tunnel.
 */
export const SCRCPY_VERSION = "4.1";
const DEVICE_JAR = "/data/local/tmp/scribui-scrcpy-server.jar";
const DEVICE_NAME_LENGTH = 64;

export type VideoSession = { width: number; height: number; clientResized: boolean };
export type VideoPacket = { config: boolean; key: boolean; pts: bigint; data: Buffer };

export type ScrcpyOptions = {
  adb?: string;
  serial: string;
  /** Path to the scrcpy-server jar for SCRCPY_VERSION. */
  serverJar: string;
  /** Longest side of the video, 0 for the device's full size. */
  maxSize?: number;
  maxFps?: number;
  videoBitRate?: number;
  log?: (line: string) => void;
};

/** Control message types (app/src/control_msg.h, scrcpy 4.1). */
const MSG = { injectKeycode: 0, injectText: 1, injectTouch: 2, backOrScreenOn: 4, rotateDevice: 11, resetVideo: 17 } as const;
export const MotionAction = { down: 0, up: 1, move: 2 } as const;
export const KeyAction = { down: 0, up: 1 } as const;
/** android.view.KeyEvent key codes used by the device view. */
export const Keycode = { home: 3, back: 4, appSwitch: 187, power: 26, enter: 66, del: 67 } as const;
/** SC_POINTER_ID_GENERIC_FINGER: a finger, not a mouse (a mouse pointer would hover). */
const FINGER = 0xfffffffffffffffen;

export class ScrcpySession extends EventEmitter {
  deviceName = "";
  video: VideoSession | null = null;
  private videoSocket: Socket | null = null;
  private controlSocket: Socket | null = null;
  private server: ChildProcess | null = null;
  private port = 0;
  private closed = false;

  private constructor(private opts: ScrcpyOptions) {
    super();
  }

  override on(e: "session", cb: (s: VideoSession) => void): this;
  override on(e: "packet", cb: (p: VideoPacket) => void): this;
  override on(e: "close", cb: (reason: string) => void): this;
  override on(e: string, cb: (...args: never[]) => void): this {
    return super.on(e, cb as (...args: unknown[]) => void);
  }

  /** Push the server, start it and connect: resolves once the device has sent its name. */
  static async start(opts: ScrcpyOptions): Promise<ScrcpySession> {
    const s = new ScrcpySession(opts);
    await s.open();
    return s;
  }

  private adb(args: string[], timeoutMs = 30_000) {
    return run(this.opts.adb ?? "adb", ["-s", this.opts.serial, ...args], { timeoutMs });
  }

  private async open() {
    const o = this.opts;
    const push = await this.adb(["push", o.serverJar, DEVICE_JAR], 60_000);
    if (push.code !== 0) throw new Error(`could not push the scrcpy server: ${push.stderr.trim()}`);
    const scid = (Math.floor(Math.random() * 0x7fffffff) >>> 0).toString(16).padStart(8, "0");
    const fwd = await this.adb(["forward", "tcp:0", `localabstract:scrcpy_${scid}`]);
    this.port = Number(fwd.stdout.toString().trim());
    if (fwd.code !== 0 || !this.port) throw new Error(`adb forward failed: ${fwd.stderr.trim()}`);

    const params = [
      `scid=${scid}`,
      "log_level=info",
      "audio=false",
      "tunnel_forward=true",
      "clipboard_autosync=false",
      "cleanup=true",
      ...(o.maxSize ? [`max_size=${o.maxSize}`] : []),
      ...(o.maxFps ? [`max_fps=${o.maxFps}`] : []),
      ...(o.videoBitRate ? [`video_bit_rate=${o.videoBitRate}`] : []),
    ];
    this.server = spawn(
      o.adb ?? "adb",
      ["-s", o.serial, "shell", `CLASSPATH=${DEVICE_JAR}`, "app_process", "/", "com.genymobile.scrcpy.Server", SCRCPY_VERSION, ...params],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const log = (b: Buffer) => b.toString().split(/\r?\n/).filter(Boolean).forEach((l) => o.log?.(`[server] ${l}`));
    this.server.stdout?.on("data", log);
    this.server.stderr?.on("data", log);
    this.server.on("exit", (code) => this.close(`server exited (${code ?? "signal"})`));

    // forward tunnel: the first socket gets a dummy byte once the server listens
    const video = await this.connectFirst();
    const control = await connectSocket(this.port);
    this.videoSocket = video.socket;
    this.controlSocket = control;
    control.on("data", () => {}); // device messages (clipboard): not used
    control.on("error", () => {});
    control.on("close", () => this.close("control socket closed"));

    const reader = new Reader(video.socket, video.rest);
    this.deviceName = (await reader.take(DEVICE_NAME_LENGTH)).toString("utf8").replace(/\0.*$/s, "");
    const codec = (await reader.take(4)).readUInt32BE(0);
    if (codec === 0) throw new Error("the device disabled video");
    if (codec === 1) throw new Error("the device could not start video");
    if (codec !== 0x68323634) throw new Error(`unexpected video codec 0x${codec.toString(16)}`);
    void this.readVideo(reader);
  }

  private async connectFirst(): Promise<{ socket: Socket; rest: Buffer }> {
    const deadline = Date.now() + 15_000;
    let last = "";
    while (Date.now() < deadline && !this.closed) {
      try {
        const socket = await connectSocket(this.port);
        const first = await firstBytes(socket, 1500);
        if (first.length > 0) return { socket, rest: first.subarray(1) };
        socket.destroy();
      } catch (e) {
        last = (e as Error).message;
      }
      await new Promise((r) => setTimeout(r, 120));
    }
    throw new Error(`could not connect to the scrcpy server${last ? `: ${last}` : ""}`);
  }

  private async readVideo(reader: Reader) {
    try {
      for (;;) {
        const h = await reader.take(12);
        if (h[0]! & 0x80) {
          this.video = { width: h.readUInt32BE(4), height: h.readUInt32BE(8), clientResized: (h[3]! & 1) === 1 };
          this.emit("session", this.video);
          continue;
        }
        const flags = h.readBigUInt64BE(0);
        const size = h.readUInt32BE(8);
        const data = await reader.take(size);
        this.emit("packet", { config: (flags & (1n << 62n)) !== 0n, key: (flags & (1n << 61n)) !== 0n, pts: flags & ((1n << 61n) - 1n), data });
      }
    } catch (e) {
      this.close((e as Error).message);
    }
  }

  /* ───────── control ───────── */

  private send(buf: Buffer) {
    if (!this.controlSocket || this.closed) throw new Error("not connected");
    this.controlSocket.write(buf);
  }

  /** A finger at (x, y) in the current video's pixels. */
  touch(action: number, x: number, y: number, pressure = 1) {
    const v = this.video;
    if (!v) throw new Error("no video yet");
    const b = Buffer.alloc(32);
    b[0] = MSG.injectTouch;
    b[1] = action;
    b.writeBigUInt64BE(FINGER, 2);
    b.writeInt32BE(Math.round(x), 10);
    b.writeInt32BE(Math.round(y), 14);
    b.writeUInt16BE(v.width, 18);
    b.writeUInt16BE(v.height, 20);
    b.writeUInt16BE(action === MotionAction.up ? 0 : Math.min(0xffff, Math.round(pressure * 0xffff)), 22);
    b.writeUInt32BE(0, 24); // action button
    b.writeUInt32BE(0, 28); // buttons
    this.send(b);
  }

  key(action: number, keycode: number, repeat = 0, metaState = 0) {
    const b = Buffer.alloc(14);
    b[0] = MSG.injectKeycode;
    b[1] = action;
    b.writeUInt32BE(keycode, 2);
    b.writeUInt32BE(repeat, 6);
    b.writeUInt32BE(metaState, 10);
    this.send(b);
  }

  press(keycode: number) {
    this.key(KeyAction.down, keycode);
    this.key(KeyAction.up, keycode);
  }

  text(s: string) {
    const utf8 = Buffer.from(s, "utf8").subarray(0, 300);
    const b = Buffer.alloc(5 + utf8.length);
    b[0] = MSG.injectText;
    b.writeUInt32BE(utf8.length, 1);
    utf8.copy(b, 5);
    this.send(b);
  }

  rotate() {
    this.send(Buffer.from([MSG.rotateDevice]));
  }

  /** Ask for a fresh config + key frame (after a decoder error). */
  resetVideo() {
    this.send(Buffer.from([MSG.resetVideo]));
  }

  close(reason = "closed") {
    if (this.closed) return;
    this.closed = true;
    this.videoSocket?.destroy();
    this.controlSocket?.destroy();
    this.server?.kill();
    if (this.port) void this.adb(["forward", "--remove", `tcp:${this.port}`]).catch(() => {});
    this.emit("close", reason);
  }
}

/* ───────── socket helpers ───────── */

function connectSocket(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = connect(port, "127.0.0.1");
    s.setNoDelay(true);
    s.once("connect", () => resolve(s));
    s.once("error", reject);
  });
}

/** The first bytes on a socket, or an empty buffer if it closes or times out first. */
function firstBytes(s: Socket, ms: number): Promise<Buffer> {
  return new Promise((resolve) => {
    const done = (b: Buffer) => {
      clearTimeout(t);
      s.off("data", onData);
      s.off("close", onClose);
      s.pause();
      resolve(b);
    };
    const onData = (b: Buffer) => done(b);
    const onClose = () => done(Buffer.alloc(0));
    const t = setTimeout(() => done(Buffer.alloc(0)), ms);
    s.on("data", onData);
    s.once("close", onClose);
  });
}

/** Exact-length reads from a stream. */
class Reader {
  private chunks: Buffer[] = [];
  private have = 0;
  private wait: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | null = null;
  private ended: Error | null = null;

  constructor(socket: Socket, rest: Buffer) {
    if (rest.length) this.push(rest);
    socket.on("data", (b: Buffer) => this.push(b));
    socket.on("close", () => this.end(new Error("video socket closed")));
    socket.on("error", (e) => this.end(e));
    socket.resume();
  }

  private push(b: Buffer) {
    this.chunks.push(b);
    this.have += b.length;
    this.flush();
  }

  private end(e: Error) {
    this.ended = e;
    if (this.wait) {
      this.wait.reject(e);
      this.wait = null;
    }
  }

  private flush() {
    if (!this.wait || this.have < this.wait.n) return;
    const all = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks);
    const out = all.subarray(0, this.wait.n);
    const rest = all.subarray(this.wait.n);
    this.chunks = rest.length ? [rest] : [];
    this.have = rest.length;
    const w = this.wait;
    this.wait = null;
    w.resolve(Buffer.from(out));
  }

  take(n: number): Promise<Buffer> {
    if (this.ended && this.have < n) return Promise.reject(this.ended);
    return new Promise((resolve, reject) => {
      this.wait = { n, resolve, reject };
      this.flush();
    });
  }
}

/** The H.264 codec string WebCodecs needs, from an SPS in an Annex B config packet. */
export function avcCodecString(config: Buffer): string | null {
  for (let i = 0; i + 4 < config.length; i++) {
    const start = config[i] === 0 && config[i + 1] === 0 && (config[i + 2] === 1 || (config[i + 2] === 0 && config[i + 3] === 1));
    if (!start) continue;
    const nal = i + (config[i + 2] === 1 ? 3 : 4);
    if ((config[nal]! & 0x1f) === 7) {
      const hex = (v: number) => v.toString(16).padStart(2, "0");
      return `avc1.${hex(config[nal + 1]!)}${hex(config[nal + 2]!)}${hex(config[nal + 3]!)}`;
    }
  }
  return null;
}
