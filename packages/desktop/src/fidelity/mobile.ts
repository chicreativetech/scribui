import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RawElement, ScreenCapture } from "@scribui/core";
import { normalizeTree } from "@scribui/core";
import { AndroidTarget, findTool, IosTarget, listSimulatorsOrWhy, run, type LiveCapture, type LiveSession, type LiveTarget } from "@scribui/capture";
import { announce, checkProbe, decode, findElement, flatten, markResolves, summary, type Check } from "./checks.js";
import { PROBES, serveProbe, type ProbeServer } from "./pages.js";

/**
 * The mobile fidelity suites (plan §5): the device tab's capture path on an
 * Android emulator or phone, or an iOS Simulator, against the probe page in
 * the device's browser (Chrome, Safari). Plain Node, no Electron:
 *
 *   npx tsx src/fidelity/mobile.ts android|ios [--device <serial|udid>] [--out <dir>]
 *
 * Needs vendor/scrcpy-server (scripts/fetch-scrcpy.mjs) or vendor/scribui-sim
 * (scripts/build-sim-helper.mjs). Writes report.json and the PNGs; exits 1
 * when a check fails.
 */

type Platform = "android" | "ios";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const vendor = fileURLToPath(new URL("../../vendor", import.meta.url));
const t0 = Date.now();
const at = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};

/**
 * Device pixels the probes may be off: Chrome on Android lays out at
 * fractional pixel ratios (2.625), and WebKit gives web content's accessibility
 * frames in whole points. So: one point, at least 2 px.
 */
const tolerance = (scale: number) => Math.max(2, Math.ceil(scale));

/** A live capture as the store would save it: the normalized tree the marks resolve against. */
function asCapture(c: LiveCapture, platform: Platform): ScreenCapture {
  return {
    screenId: "fidelity",
    platform,
    device: c.device,
    screenshot: "fidelity.png",
    root: normalizeTree(c.raw as RawElement),
  } as ScreenCapture;
}

async function target(platform: Platform): Promise<LiveTarget> {
  if (platform === "ios") return new IosTarget({ helper: join(vendor, "scribui-sim") });
  const adb = await findTool("adb");
  return new AndroidTarget({ serverJar: join(vendor, "scrcpy-server"), ...(adb ? { adb } : {}) });
}

/**
 * Open the probe page in the device's browser and wait until the browser has
 * fetched it: a freshly booted simulator's first Safari launch can take far
 * longer than a fixed pause (CI's always is fresh). Android reaches the host
 * through `adb reverse`.
 */
async function openProbe(platform: Platform, id: string, probe: ProbeServer, path = "/still", settleMs = 3000) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const since = Date.now();
    await sendProbeUrl(platform, id, `http://127.0.0.1:${probe.port}${path}`);
    if (await probe.requested(path, since, 20_000)) {
      // drawn, and any first-launch sheet gone
      await sleep(settleMs);
      return;
    }
  }
  throw new Error(`the browser never loaded ${path}`);
}

async function sendProbeUrl(platform: Platform, id: string, url: string) {
  if (platform === "ios") {
    await run("xcrun", ["simctl", "openurl", id, url], { timeoutMs: 20_000 });
    return;
  }
  const adb = (await findTool("adb")) ?? "adb";
  const port = new URL(url).port;
  await run(adb, ["-s", id, "reverse", `tcp:${port}`, `tcp:${port}`], { timeoutMs: 10_000 });
  // no first-run screens in Chrome (emulators allow the command-line file)
  await run(adb, ["-s", id, "shell", "echo 'chrome --disable-fre --no-default-browser-check --no-first-run' > /data/local/tmp/chrome-command-line"], { timeoutMs: 10_000 });
  await run(adb, ["-s", id, "shell", "am", "set-debug-app", "--persistent", "com.android.chrome"], { timeoutMs: 10_000 });
  // no notification prompt over the page (Android 13+)
  await run(adb, ["-s", id, "shell", "pm", "grant", "com.android.chrome", "android.permission.POST_NOTIFICATIONS"], { timeoutMs: 10_000 });
  // one application id: Chrome reuses its tab instead of piling up new ones (and their tips)
  await run(adb, ["-s", id, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url, "--es", "com.android.browser.application_id", "scribui.fidelity", "com.android.chrome"], {
    timeoutMs: 20_000,
  });
}

/** Kill the live stream under the session (not the device). */
async function killStream(platform: Platform, id: string) {
  if (platform === "ios") await run("pkill", ["-f", `scribui-sim serve --udid ${id}`]);
  else await run((await findTool("adb")) ?? "adb", ["-s", id, "shell", "pkill", "-f", "com.genymobile.scrcpy"], { timeoutMs: 10_000 });
}

export async function runMobileFidelity(platform: Platform) {
  const out = resolve(arg("--out") ?? process.env.SCRIBUI_FIDELITY_OUT ?? mkdtempSync(join(tmpdir(), `scribui-fidelity-${platform}-`)));
  mkdirSync(out, { recursive: true });
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail?: unknown) => {
    checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
    console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  };
  const report: Record<string, unknown> = { suite: platform, host: process.platform, arch: process.arch };
  const probe = await serveProbe();
  const { server } = probe;
  let session: LiveSession | null = null;
  let reverseFor: { adb: string; id: string } | null = null;
  const watchdog = setTimeout(() => {
    check("the suite finished in time", false);
    finish();
  }, Number(process.env.SCRIBUI_FIDELITY_TIMEOUT_MS ?? 600_000));
  const finish = () => {
    clearTimeout(watchdog);
    report.checks = checks;
    report.summary = summary(checks);
    writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
    announce(platform, checks);
    console.log(`FIDELITY_REPORT ${join(out, "report.json")} ${JSON.stringify(report.summary)}`);
    server.close();
    void session?.dispose();
    // this run's tunnel: left behind, they pile up on the device across runs (and once there are many, Chrome's requests stopped arriving)
    if (platform === "android" && reverseFor) {
      try {
        execFileSync(reverseFor.adb, ["-s", reverseFor.id, "reverse", "--remove", `tcp:${probe.port}`], { stdio: "ignore", timeout: 10_000 });
      } catch (e) {
        console.log(`couldn't remove the adb reverse tunnel: ${(e as Error).message}`);
      }
    }
    process.exit(checks.length && checks.every((c) => c.ok) ? 0 : 1);
  };

  try {
    const t = await target(platform);
    const devices = await t.list();
    const want = arg("--device");
    const device = devices.find((d) => d.state === "ready" && (!want || d.id === want));
    if (!device) {
      const why = platform === "ios" ? (await listSimulatorsOrWhy()).error : null;
      throw new Error(`no ready ${platform === "ios" ? "simulator" : "device"}${want ? ` ${want}` : ""}: ${JSON.stringify(devices)}${why ? ` (${why})` : ""}`);
    }
    report.device = device;

    at("opening the probe page");
    if (platform === "android") reverseFor = { adb: (await findTool("adb")) ?? "adb", id: device.id };
    await openProbe(platform, device.id, probe);

    at("connecting");
    const t1 = Date.now();
    const s = await t.connect(device.id);
    session = s;
    let frames = 0, keys = 0;
    s.on("frame", (f) => {
      frames++;
      if (f.key) keys++;
    });
    report.connectMs = Date.now() - t1;
    // a portrait start: an earlier run may have left the device turned
    if (s.size.width > s.size.height) {
      await s.input({ type: "rotate" });
      await sleep(2500);
    }
    s.resetVideo();
    for (let i = 0; i < 100 && !keys; i++) await sleep(100);
    check("the stream delivers pictures (a key frame within 10 s of asking)", keys > 0, { frames, keys, connectMs: report.connectMs });

    const capture = async (name: string) => {
      at(`capturing: ${name}`);
      const steps: string[] = [];
      const t2 = Date.now();
      const c = await s.capture(new AbortController().signal, (p) => steps.push(`${p.step}${p.attempt}`));
      writeFileSync(join(out, `${name}.png`), c.png);
      writeFileSync(join(out, `${name}.tree.json`), JSON.stringify(c.raw, null, 1));
      return { c, cap: asCapture(c, platform), img: decode(c.png), ms: Date.now() - t2, steps };
    };
    const probes = (name: string, r: Awaited<ReturnType<typeof capture>>, which: (keyof typeof PROBES)[]) => {
      for (const k of which) {
        // a turned box: the browsers round its accessibility bounds out to whole CSS pixels on each side
        const res = checkProbe(r.cap, r.img, {
          ...PROBES[k],
          tolerancePx: k === "turned" ? 2 * tolerance(r.c.device.scale) : tolerance(r.c.device.scale),
          // the browser's own UI meets the top of the page: Safari paints the header's colour behind
          // the status bar and side safe areas, Chrome draws its toolbar's shadow over it
          bottomOnly: k === "header",
        });
        check(`${name}: ${PROBES[k].name} aligned`, res.ok, res);
      }
    };

    // a fresh browser shows first-run tips over the page, and the tree then has none of it
    // (CI's simulator is always fresh): close them, then measure
    for (let i = 1; i <= 4; i++) {
      const pre = await capture(`overlay-check-${i}`).catch((e: Error) => {
        // a sheet can make even the plain tree unreadable for a moment
        console.log(`overlay check ${i}: ${e.message}`);
        return null;
      });
      if (!pre) {
        await sleep(2000);
        continue;
      }
      if (findElement(pre.cap, PROBES.probe.match)) break;
      const close = flatten(pre.cap.root).find((e) => /^(close|dismiss|not now|no thanks|continue|ok|done|don.t allow)$/i.test((e.label ?? "").trim()) && e.bounds.w > 0);
      if (!close) break;
      at(`closing "${close.label}" over the page`);
      const x = (close.bounds.x + close.bounds.w / 2) / pre.img.width;
      const y = (close.bounds.y + close.bounds.h / 2) / pre.img.height;
      await s.input({ type: "pointer", action: "down", x, y });
      await s.input({ type: "pointer", action: "up", x, y });
      await sleep(1500);
    }

    // portrait, still
    const p = await capture("portrait");
    check("portrait: settled on a still screen", p.c.settled && p.c.elements, { attempts: p.c.attempts, ms: p.ms, steps: p.steps, device: p.c.device });
    probes("portrait", p, ["probe", "turned", "header"]);
    const probeEl = findElement(p.cap, PROBES.probe.match);
    const mark = probeEl ? markResolves(p.cap, probeEl) : { ok: false, target: null, label: null };
    check("portrait: a circle around the probe resolves to it", mark.ok, mark);
    check("portrait: the screenshot is sRGB without a profile", !p.img.hasColourProfile);

    // landscape
    at("rotating");
    await s.input({ type: "rotate" });
    await sleep(3500);
    const l = await capture("landscape");
    check("landscape: saved turned (wider than tall)", l.c.orientation === "landscape" && l.img.width > l.img.height, { size: [l.img.width, l.img.height], device: l.c.device });
    probes("landscape", l, ["probe", "header"]);
    await s.input({ type: "rotate" });
    await sleep(3500);

    // Capture while something on the page still moves: either the capture waits for the screen to
    // settle or it says it didn't
    at("capturing while the page moves");
    await openProbe(platform, device.id, probe, "/moving", 0);
    await sleep(1200);
    const m = await capture("moving");
    const moved = m.c.attempts > 1 || !m.c.settled;
    check("while moving: the motion was noticed (retried or kept unsettled)", moved, { attempts: m.c.attempts, settled: m.c.settled, steps: m.steps, ms: m.ms });
    // whatever it settled on, its tree belongs to its picture
    if (m.c.settled) probes("while moving (settled)", m, ["probe", "header"]);
    await openProbe(platform, device.id, probe);
    await sleep(2500);

    // the keyboard (Android: in the screenshot, added to the tree)
    if (platform === "android") {
      at("opening the keyboard");
      // Android names a field by its text
      const field = findElement(p.cap, /^(probe field|caret here)$/);
      if (field) {
        const pt = { x: (field.bounds.x + field.bounds.w / 2) / s.size.width, y: (field.bounds.y + field.bounds.h / 2) / s.size.height };
        let kb = null;
        // a second tap when the first only dismissed a tip
        for (let tap = 0; tap < 2 && !kb; tap++) {
          await s.input({ type: "pointer", action: "down", ...pt });
          await s.input({ type: "pointer", action: "up", ...pt });
          await sleep(2500);
          kb = findElement((await capture("keyboard")).cap, /^On-screen keyboard$/);
        }
        check("keyboard: the on-screen keyboard is in the tree", !!kb, kb?.bounds);
        await s.input({ type: "key", key: "back" });
        await sleep(1500);
      } else check("keyboard: the probe field is in the tree", false);
    }

    // the stream dies in the middle of a capture: the capture still ends, the session comes back
    at("killing the stream mid-capture");
    let reconnected = false;
    const off = s.on("reconnect", () => (reconnected = true));
    const pending = s.capture(new AbortController().signal, () => {}).then(
      (c) => ({ ok: true, settled: c.settled }),
      (e: Error) => ({ ok: false, error: e.message }),
    );
    await sleep(200);
    await killStream(platform, device.id);
    const result = await Promise.race([pending, sleep(90_000).then(() => ({ ok: false, error: "still running after 90 s" }))]);
    check("stream killed mid-capture: the capture ends (saved or a clear error)", !("error" in result) || !/still running/.test(String(result.error)), result);
    for (let i = 0; i < 100 && !reconnected; i++) await sleep(100);
    check("stream killed: the session reconnects within 10 s", reconnected);
    off();
    report.frames = { frames, keys };
  } catch (e) {
    const detail = (e as { detail?: string }).detail;
    check("the suite ran to the end", false, `${(e as Error).stack ?? String(e)}${detail ? `\n${detail}` : ""}`);
  } finally {
    finish();
  }
}

const platform = process.argv[2];
if (platform === "android" || platform === "ios") void runMobileFidelity(platform);
else {
  console.error("usage: tsx src/fidelity/mobile.ts android|ios [--device <id>] [--out <dir>]");
  process.exit(2);
}
