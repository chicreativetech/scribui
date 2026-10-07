import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { app, BrowserWindow } from "electron";
import { resolveAll, type RawElement, type ScreenCapture, type UIElement } from "@scribui/core";
import { avcCodecString, captureAndroidLive, dumpTree, Keycode, MotionAction, run, ScrcpySession, SCRCPY_VERSION, toCapture } from "@scribui/capture";

/**
 * Spike A: an Android device live in an Electron window (scrcpy H.264 decoded
 * with WebCodecs), controlled through scrcpy's control channel, captured with
 * the verify step, and checked with a mark that must resolve to the right
 * element. Edge cases: rotation (decoder reset), the keyboard, capture during
 * a scroll, the server dying and reconnecting.
 *
 * SCRIBUI_SPIKE=android npx electron .   (from packages/desktop, after npx tsup)
 * Needs one booted device or emulator and the scrcpy-server jar of SCRCPY_VERSION
 * (SCRCPY_SERVER, default: Homebrew's).
 */

const DECODER_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Spike A</title>
<style>html,body{margin:0;background:#111;height:100%}canvas{display:block;max-width:100%;max-height:100%;margin:auto}</style></head>
<body><canvas id="c"></canvas><script>
const cv = document.getElementById("c"), g = cv.getContext("2d");
let decoder = null, pendingConfig = null, codec = null;
const st = { frames: 0, errors: 0, configures: 0, lastError: "", sizes: [], latencies: [], firstFrameAt: 0 };
const sent = new Map();
function configure(c) {
  if (decoder && decoder.state !== "closed") decoder.close();
  decoder = new VideoDecoder({
    output: (f) => {
      if (cv.width !== f.displayWidth || cv.height !== f.displayHeight) { cv.width = f.displayWidth; cv.height = f.displayHeight; st.sizes.push([f.displayWidth, f.displayHeight]); }
      g.drawImage(f, 0, 0);
      const t = sent.get(f.timestamp);
      if (t) { st.latencies.push(Date.now() - t); sent.delete(f.timestamp); }
      if (!st.firstFrameAt) st.firstFrameAt = Date.now();
      st.frames++; st.lastFrameAt = Date.now();
      f.close();
    },
    error: (e) => { st.errors++; st.lastError = String(e && e.message || e); },
  });
  decoder.configure({ codec: c, optimizeForLatency: true });
  st.configures++;
}
window.spikeBridge.onPacket((p) => {
  if (p.config) {
    // a new session (start, rotation, reset): the config carries SPS/PPS, decoding restarts from it
    pendingConfig = p.data;
    if (p.codec) { codec = p.codec; configure(codec); }
    return;
  }
  if (!decoder || decoder.state !== "configured") return;
  let data = p.data;
  if (pendingConfig) { const m = new Uint8Array(pendingConfig.length + data.length); m.set(pendingConfig); m.set(data, pendingConfig.length); data = m; pendingConfig = null; }
  const ts = Number(p.pts);
  sent.set(ts, p.sentAt);
  try { decoder.decode(new EncodedVideoChunk({ type: p.key ? "key" : "delta", timestamp: ts, data })); }
  catch (e) { st.errors++; st.lastError = String(e.message || e); }
});
window.spikeStats = () => {
  const l = [...st.latencies].sort((a, b) => a - b);
  const q = (k) => l.length ? l[Math.min(l.length - 1, Math.floor(k * l.length))] : null;
  return { frames: st.frames, errors: st.errors, configures: st.configures, lastError: st.lastError, sizes: st.sizes, latencyMs: { p50: q(0.5), p95: q(0.95), max: l[l.length - 1] ?? null }, decoderState: decoder && decoder.state, firstFrameAt: st.firstFrameAt, lastFrameAt: st.lastFrameAt };
};
window.spikeResetLatency = () => { st.latencies = []; };
</script></body></html>`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function flatten(el: RawElement, out: RawElement[] = []) {
  out.push(el);
  for (const c of el.children) flatten(c, out);
  return out;
}
const flattenUI = (el: UIElement, out = new Map<string, UIElement>()) => {
  out.set(el.id, el);
  for (const c of el.children) flattenUI(c, out);
  return out;
};
const centre = (e: RawElement) => [e.bounds.x + e.bounds.w / 2, e.bounds.y + e.bounds.h / 2] as const;
const findLabel = (raw: RawElement, re: RegExp) => flatten(raw).find((e) => e.label && re.test(e.label) && e.bounds.w > 0);

export async function runAndroidSpike() {
  const out = resolve(process.env.SCRIBUI_SPIKE_OUT ?? mkdtempSync(join(tmpdir(), "scribui-spike-a-")));
  mkdirSync(out, { recursive: true });
  const report: Record<string, unknown> = { scrcpyServer: SCRCPY_VERSION, electron: process.versions.electron, chromium: process.versions.chrome };
  const log: string[] = [];
  const note = (l: string) => {
    log.push(`${new Date().toISOString().slice(11, 23)} ${l}`);
    console.log(l);
  };
  const finish = (code = 0) => {
    writeFileSync(join(out, "report.json"), JSON.stringify({ ...report, log }, null, 2));
    console.log(`SPIKE_REPORT ${join(out, "report.json")}`);
    app.exit(code);
  };

  try {
    const devs = (await run("adb", ["devices"])).stdout.toString().split("\n").slice(1).map((l) => l.trim().split(/\s+/)).filter((p) => p[1] === "device");
    const serial = devs[0]?.[0];
    if (!serial) throw new Error("no Android device");
    const adb = (args: string[], timeoutMs = 30_000) => run("adb", ["-s", serial, ...args], { timeoutMs });
    const sh = async (cmd: string) => (await adb(["shell", cmd])).stdout.toString().trim();
    report.device = { serial, model: await sh("getprop ro.product.model"), sdk: await sh("getprop ro.build.version.sdk"), size: await sh("wm size") };
    const jar = process.env.SCRCPY_SERVER ?? "/opt/homebrew/share/scrcpy/scrcpy-server";
    if (!existsSync(jar)) throw new Error(`no scrcpy-server jar at ${jar}`);
    await sh("settings put system accelerometer_rotation 0; settings put system user_rotation 0");
    // every step starts from a freshly started Settings app, whatever the emulator showed before
    const freshSettings = async () => {
      await sh("input keyevent 224; wm dismiss-keyguard; am force-stop com.android.settings; am start -W -a android.settings.SETTINGS");
      await sleep(1500);
    };
    await freshSettings();
    await sleep(1500);

    // decoding page
    const win = new BrowserWindow({ width: 520, height: 1000, show: true, webPreferences: { preload: join(__dirname, "spikeAndroidPreload.cjs"), contextIsolation: true, sandbox: true } });
    // served from 127.0.0.1 like the canvas: WebCodecs only exists in secure contexts (a data: URL isn't one)
    const page = createServer((_q, r) => r.writeHead(200, { "content-type": "text/html" }).end(DECODER_PAGE));
    await new Promise<void>((done) => page.listen(0, "127.0.0.1", () => done()));
    await win.loadURL(`http://127.0.0.1:${(page.address() as { port: number }).port}/`);
    report.page = await win.webContents.executeJavaScript("({ secureContext: isSecureContext, webCodecs: typeof VideoDecoder })");
    const stats = () => win.webContents.executeJavaScript("spikeStats()") as Promise<{ frames: number; errors: number; configures: number; lastError: string; sizes: number[][]; latencyMs: Record<string, number | null>; decoderState: string; firstFrameAt: number; lastFrameAt: number }>;

    let session!: ScrcpySession;
    const sessions: { width: number; height: number }[] = [];
    let closeReason = "";
    const connect = async () => {
      const t0 = Date.now();
      session = await ScrcpySession.start({ serial, serverJar: jar, maxSize: 1280, maxFps: 60, log: (l) => log.push(l) });
      session.on("session", (s) => {
        sessions.push({ width: s.width, height: s.height });
        note(`video session ${s.width}×${s.height}`);
      });
      session.on("packet", (p) => {
        win.webContents.send("scrcpy:packet", { config: p.config, key: p.key, pts: p.pts.toString(), data: p.data, sentAt: Date.now(), ...(p.config ? { codec: avcCodecString(p.data) } : {}) });
      });
      session.on("close", (r) => {
        closeReason = r;
        note(`session closed: ${r}`);
      });
      return Date.now() - t0;
    };
    const startMs = await connect();
    note(`connected to "${session.deviceName}" in ${startMs} ms`);
    await sleep(3000);
    await win.webContents.executeJavaScript("spikeResetLatency()");
    await sleep(3000);
    const s1 = await stats();
    report.stream = { connectMs: startMs, deviceName: session.deviceName, video: session.video, ...s1 };
    writeFileSync(join(out, "stream.png"), (await win.webContents.capturePage()).toPNG());

    // device pixels → video pixels
    const devSize = /(\d+)x(\d+)/.exec(String((report.device as { size: string }).size))!;
    const toVideo = (x: number, y: number, portrait = true) => {
      const v = session.video!;
      const dw = portrait ? Number(devSize[1]) : Number(devSize[2]);
      const dh = portrait ? Number(devSize[2]) : Number(devSize[1]);
      return [(x * v.width) / dw, (y * v.height) / dh] as const;
    };
    const tap = async (x: number, y: number, portrait = true) => {
      const [vx, vy] = toVideo(x, y, portrait);
      session.touch(MotionAction.down, vx, vy);
      await sleep(60);
      session.touch(MotionAction.up, vx, vy);
    };

    // interact: tap a Settings row through the control channel
    const home = await dumpTree(adb);
    const row = findLabel(home, /^(Network (&|and) internet|Connected devices|Apps)$/i);
    if (!row) throw new Error("no known Settings row on screen");
    note(`tapping "${row.label}"`);
    await tap(...centre(row));
    await sleep(1800);
    const after = await dumpTree(adb);
    const navigated = !findLabel(after, /^Connected devices$/i) || !!findLabel(after, /^(Internet|Airplane mode|Bluetooth|Pair new device|All apps|See all \d+ apps)$/i);
    report.interact = { tapped: row.label, navigated, newScreenSample: flatten(after).filter((e) => e.label).slice(0, 6).map((e) => e.label) };
    session.press(Keycode.back);
    await sleep(800);
    await freshSettings();

    // capture a settled screen, then check a mark resolves to the right element
    const cap = await captureAndroidLive({ serial });
    const shot = (name: string, png: Buffer) => writeFileSync(join(out, name), png);
    shot("capture-settled.png", cap.png);
    const asCapture = (c: typeof cap, id: string): ScreenCapture =>
      toCapture({ id, title: id }, "android", { name: c.model, width: Math.round(c.width / c.scale), height: Math.round(c.height / c.scale), scale: c.scale }, `screens/${id}.png`, c.raw, { width: c.width, height: c.height });
    const sc = asCapture(cap, "settings");
    // any labelled row on screen; prefer a known Settings row
    const labelled = [...flattenUI(sc.root).values()].filter((e) => e.label && e.bounds.w > 80 && e.bounds.h > 20 && e.bounds.y > sc.root.bounds.h * 0.15);
    const target = labelled.find((e) => /^(Network (&|and) internet|Connected devices|Apps)$/i.test(e.label!)) ?? labelled[0];
    let mark: Record<string, unknown> = { found: !!target };
    if (target) {
      const b = target.bounds;
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      const points: [number, number][] = Array.from({ length: 24 }, (_, i) => [cx + Math.cos((i / 24) * 2 * Math.PI) * (b.w / 2 + 16), cy + Math.sin((i / 24) * 2 * Math.PI) * (b.h / 2 + 16)]);
      const [a] = resolveAll([{ id: "m", screenId: sc.screenId, kind: "circle", geometry: { type: "path", points } }], new Map([[sc.screenId, sc.root]]));
      const hit = a?.resolution?.elements.map((id) => flattenUI(sc.root).get(id)) ?? [];
      const contains = (outer: UIElement, inner: UIElement): boolean => outer === inner || outer.children.some((c) => contains(c, inner));
      mark = { label: target.label, resolvedTo: hit.map((e) => `${e?.type} "${e?.label ?? ""}"`), ok: hit.some((e) => e && (e === target || contains(e, target))) };
    }
    report.capture = { settled: cap.settled, attempts: cap.attempts, change: cap.change, size: [cap.width, cap.height], scale: cap.scale, mark };

    // capture during a scroll: the verify step must notice
    const swipe = spawn("adb", ["-s", serial, "shell", "input swipe 540 1900 540 500 1500"]);
    await sleep(500);
    const moving = await captureAndroidLive({ serial, progress: (step, n) => note(`capture step: ${step} (${n})`) });
    swipe.kill();
    shot("capture-during-scroll.first.png", moving.firstPng);
    shot("capture-during-scroll.final.png", moving.png);
    report.captureDuringScroll = { settled: moving.settled, attempts: moving.attempts, lastChange: moving.change };
    await freshSettings();

    // keyboard: open search, type through the control channel, capture
    const search = findLabel(await dumpTree(adb), /^Search( settings)?$/i);
    if (search) {
      await tap(...centre(search));
      await sleep(1500);
      session.text("wifi");
      await sleep(1500);
      const kb = await captureAndroidLive({ serial });
      shot("capture-keyboard.png", kb.png);
      const imeShown = (await sh("dumpsys input_method | grep -m1 mInputShown")).includes("true");
      const typed = flatten(kb.raw).some((e) => e.label?.toLowerCase() === "wifi");
      // uiautomator dumps the app's window only: is the keyboard (IME) window in it?
      await sh("uiautomator dump /sdcard/scribui_ime.xml");
      const xml = (await adb(["exec-out", "cat", "/sdcard/scribui_ime.xml"])).stdout.toString();
      const packages = [...new Set([...xml.matchAll(/package="([^"]+)"/g)].map((m) => m[1]))];
      const imePackage = (await sh("settings get secure default_input_method")).split("/")[0];
      const imeFrame = /mFrame=\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(await sh("dumpsys window InputMethod | grep -m1 mFrame="))?.slice(1).map(Number);
      report.keyboard = { imeShown, typedTextInTree: typed, settled: kb.settled, treePackages: packages, imePackage, keyboardInTree: packages.includes(imePackage!), imeFrame };
      session.press(Keycode.back);
      await sleep(400);
      session.press(Keycode.back);
      await sleep(1000);
    }

    // rotation: a new video session, the decoder reconfigured, frames keep coming
    const before = await stats();
    await sh("settings put system user_rotation 1");
    await sleep(4000);
    const rotated = await stats();
    const land = await captureAndroidLive({ serial });
    shot("capture-landscape.png", land.png);
    writeFileSync(join(out, "stream-landscape.png"), (await win.webContents.capturePage()).toPNG());
    const rootW = land.raw.bounds.w, rootH = land.raw.bounds.h;
    report.rotation = {
      sessions: sessions.slice(-2),
      configuresBefore: before.configures,
      configuresAfter: rotated.configures,
      framesAfterRotation: rotated.frames - before.frames,
      decoderErrors: rotated.errors - before.errors,
      capture: { size: [land.width, land.height], treeRoot: [rootW, rootH], settled: land.settled },
    };
    await sh("settings put system user_rotation 0");
    await sleep(3000);

    // the server dies: notice, reconnect, frames again
    const pre = await stats();
    const killedAt = Date.now();
    await sh("pkill -f com.genymobile.scrcpy.Server");
    for (let i = 0; i < 50 && !closeReason; i++) await sleep(100);
    const noticedMs = closeReason ? Date.now() - killedAt : null;
    const reconnectMs = await connect();
    let framesBack: number | null = null;
    for (let i = 0; i < 60; i++) {
      const s = await stats();
      if (s.frames > pre.frames && s.lastFrameAt > killedAt) {
        framesBack = Date.now() - killedAt;
        break;
      }
      await sleep(100);
    }
    report.reconnect = { closeReason, noticedMs, reconnectMs, firstFrameAfterKillMs: framesBack };

    const end = await stats();
    report.streamEnd = { frames: end.frames, errors: end.errors, configures: end.configures, lastError: end.lastError, latencyMs: end.latencyMs };
    session.close();
    await sh("settings put system user_rotation 0");
    // report first: closing the last window quits the app
    finish(0);
  } catch (e) {
    report.error = (e as Error).stack ?? String(e);
    finish(1);
  }
}
