import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { avcCodecString } from "./scrcpy.js";

/**
 * The desktop app's `scribui-sim` helper (packages/desktop/native/scribui-sim):
 * one process per shown simulator, holding its HID connection and H.264
 * stream. Commands go in as JSON lines; out come frames of
 * [kind u8][length u32 BE][payload]: kind 1 one NAL unit (Annex B), kind 2 JSON.
 */

export type SimPacket = { config: boolean; key: boolean; pts: bigint; data: Buffer; codec?: string };

type Reply = { id: number; ok: boolean; data?: unknown; message?: string };

type HelperEvents = {
  packet: [SimPacket];
  close: [reason: string];
  warning: [message: string];
};

/**
 * Packets for the decoder from single NAL units: SPS and PPS become one
 * config packet (with the codec string), SEI and the like go in front of the
 * next picture, IDR pictures are key frames.
 */
export class NalGrouper {
  private sps: Buffer | null = null;
  private pps: Buffer | null = null;
  private prefix: Buffer[] = [];
  private t0 = process.hrtime.bigint();

  push(nal: Buffer): SimPacket | null {
    const start = nal[2] === 1 ? 3 : 4;
    const type = nal[start]! & 0x1f;
    const pts = (process.hrtime.bigint() - this.t0) / 1000n;
    if (type === 7) {
      this.sps = nal;
      this.pps = null;
      return null;
    }
    if (type === 8) {
      this.pps = nal;
      if (!this.sps) return null;
      const data = Buffer.concat([this.sps, this.pps]);
      return { config: true, key: false, pts, data, codec: avcCodecString(data) ?? "avc1.42e01f" };
    }
    if (type === 1 || type === 5) {
      const data = this.prefix.length ? Buffer.concat([...this.prefix, nal]) : nal;
      this.prefix = [];
      return { config: false, key: type === 5, pts, data };
    }
    this.prefix.push(nal);
    return null;
  }
}

export class SimHelper extends EventEmitter<HelperEvents> {
  private child: ChildProcessWithoutNullStreams;
  private buf: Buffer = Buffer.alloc(0);
  private next = 1;
  private waiting = new Map<number, { done: (r: Reply) => void; timer: NodeJS.Timeout }>();
  private nals = new NalGrouper();
  private closed = false;
  private stderr = "";
  readonly ready: Promise<{ name: string }>;

  constructor(bin: string, udid: string, opts: { scale?: number; fps?: number; log?: (line: string) => void } = {}) {
    super();
    const args = ["serve", "--udid", udid, "--scale", String(opts.scale ?? 0.5), ...(opts.fps ? ["--fps", String(opts.fps)] : [])];
    this.child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    let ready!: (v: { name: string }) => void;
    let fail!: (e: Error) => void;
    this.ready = new Promise((res, rej) => ((ready = res), (fail = rej)));
    this.child.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      this.stderr = (this.stderr + s).slice(-2000);
      for (const l of s.split("\n")) if (l.trim()) opts.log?.(`scribui-sim: ${l}`);
    });
    this.child.stdout.on("data", (d: Buffer) => this.read(d, ready, fail));
    this.child.on("error", (e) => this.end(`can't start scribui-sim: ${e.message}`, fail));
    this.child.on("close", (code, signal) => {
      const why = this.stderr.trim().split("\n").pop();
      this.end(code === 0 ? "closed" : `the connection to the simulator stopped${why ? `: ${why}` : signal ? ` (${signal})` : ` (exit ${code})`}`, fail);
    });
    this.child.stdin.on("error", () => {});
  }

  get isClosed() {
    return this.closed;
  }

  private read(d: Buffer, ready: (v: { name: string }) => void, fail: (e: Error) => void) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.buf.length >= 5) {
      const len = this.buf.readUInt32BE(1);
      if (this.buf.length < 5 + len) break;
      const kind = this.buf[0];
      const payload = this.buf.subarray(5, 5 + len);
      this.buf = this.buf.subarray(5 + len);
      if (kind === 1) {
        const p = this.nals.push(Buffer.from(payload));
        if (p) this.emit("packet", p);
        continue;
      }
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(payload.toString()) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (msg.event === "ready") ready({ name: String(msg.name ?? "") });
      else if (msg.event === "error") fail(new Error(String(msg.message)));
      else if (msg.event === "warning") this.emit("warning", String(msg.message));
      else if (typeof msg.id === "number") {
        const w = this.waiting.get(msg.id);
        if (w) {
          clearTimeout(w.timer);
          this.waiting.delete(msg.id);
          w.done(msg as unknown as Reply);
        }
      }
    }
  }

  private end(reason: string, fail: (e: Error) => void) {
    if (this.closed) return;
    this.closed = true;
    fail(new Error(reason));
    for (const [, w] of this.waiting) {
      clearTimeout(w.timer);
      w.done({ id: 0, ok: false, message: reason });
    }
    this.waiting.clear();
    this.emit("close", reason);
  }

  /** Fire and forget (touches, keys): handled in order with everything else. */
  send(cmd: Record<string, unknown>) {
    if (!this.closed) this.child.stdin.write(`${JSON.stringify(cmd)}\n`);
  }

  /** A command with a reply. */
  call<T = unknown>(cmd: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error("scribui-sim isn't running"));
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`scribui-sim: ${String(cmd.op)} took longer than ${timeoutMs / 1000} s`));
      }, timeoutMs);
      this.waiting.set(id, { done: (r) => (r.ok ? resolve(r.data as T) : reject(new Error(r.message ?? "failed"))), timer });
      this.send({ ...cmd, id });
    });
  }

  close() {
    if (this.closed) return;
    this.child.stdin.end();
    // stdin closing ends it; make sure
    setTimeout(() => {
      if (!this.closed) this.child.kill();
    }, 2000).unref();
  }
}
