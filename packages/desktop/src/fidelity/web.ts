import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { app } from "electron";
import type { ScreenCapture } from "@scribui/core";
import { WebAdapter } from "@scribui/capture";
import { openProject, type Project } from "../projectWindow.js";
import { nextPaint } from "../webCapture.js";
import { announce, checkProbe, colourAt, colourBox, compareTrees, comparePixels, decode, findElement, markResolves, summary, type Check } from "./checks.js";
import { FADE_RGB, PROBES, SCROLL_TO, serveProbe, SPIN_RGB } from "./pages.js";

/**
 * The web fidelity suite (SCRIBUI_FIDELITY=web): the desktop app's own
 * capture path (the app's WebContentsView, captured from the canvas's
 * "Capture view") against the probe page, at the canvas's sizes, compared
 * with today's automatic path (the CLI's Playwright adapter) at the same CSS
 * size and pixel ratio. Run once per scale factor (--force-device-scale-factor).
 *
 * Writes report.json and the PNGs to SCRIBUI_FIDELITY_OUT; exits 1 when a
 * check fails. SCRIBUI_FIDELITY_MAX_PIXEL_PCT (default 3): the share of
 * pixels the two paths may differ by (text anti-aliasing, focus ring colour).
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
let step = "starting";
/** What the suite is doing, with the time: a hang in CI says where. */
const at = (s: string) => {
  step = s;
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
};
const SIZES = ["fit", "phone", "desktop"] as const;
const WINDOW = { width: 1400, height: 960 };
const WATCHDOG_MS = Number(process.env.SCRIBUI_FIDELITY_TIMEOUT_MS ?? 240_000);

/** Show the app tab at a size preset, through the canvas's own size menu. */
const SHOW_SIZE = (size: string) => `(async () => {
  localStorage.setItem("scribui:live-size", ${JSON.stringify(size)});
  window.__scribui.getState().set({ view: "live", liveVisited: true });
  await new Promise((r) => setTimeout(r, 300));
  const sel = [...document.querySelectorAll(".live-bar select")].find((s) => [...s.options].some((o) => o.value === ${JSON.stringify(size)}));
  if (sel && sel.value !== ${JSON.stringify(size)}) {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(sel, ${JSON.stringify(size)});
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  }
  return true;
})()`;

async function loaded(p: Project, url: string) {
  p.live.navigate(url);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const wc = p.live.webContents;
    if (wc && !wc.isLoading() && wc.getURL().startsWith(url)) break;
    await sleep(100);
  }
  const wc = p.live.webContents!;
  await wc.executeJavaScript("document.fonts.ready.then(() => true)");
  await nextPaint(wc);
}

/** Capture through the canvas, exactly as its button does, and read back what was saved. */
async function captureView(p: Project, title: string): Promise<{ cap: ScreenCapture; png: Buffer }> {
  const r = (await p.win.webContents.executeJavaScript(`window.__scribuiCapture({ title: ${JSON.stringify(title)} })`)) as { round: number; screenId: string };
  const cap = (await p.store.readCapture(r.round, r.screenId))!;
  return { cap, png: readFileSync(join(p.store.roundDir(r.round), cap.screenshot)) };
}

/** Today's path: the CLI's Playwright adapter, same page, same CSS size and pixel ratio. */
async function captureWithPlaywright(url: string, cap: ScreenCapture, work: string): Promise<{ cap: ScreenCapture; png: Buffer }> {
  const reviewDir = join(work, ".scribui");
  const roundDir = join(reviewDir, "rounds", "pw");
  mkdirSync(join(roundDir, "screens"), { recursive: true });
  const screen = { id: "pw", title: "pw", url, viewport: { width: cap.device.width, height: cap.device.height, deviceScaleFactor: cap.device.scale } };
  const adapter = new WebAdapter({ reviewDir, roundDir, manifest: { version: 1, app: { name: "fidelity", platform: "web" }, screens: [screen] } });
  try {
    await adapter.prepare(screen);
    const c = await adapter.capture(screen);
    return { cap: c, png: readFileSync(join(roundDir, c.screenshot)) };
  } finally {
    await adapter.dispose();
  }
}

export async function runWebFidelity() {
  const out = resolve(process.env.SCRIBUI_FIDELITY_OUT ?? mkdtempSync(join(tmpdir(), "scribui-fidelity-web-")));
  mkdirSync(out, { recursive: true });
  const maxPixelPct = Number(process.env.SCRIBUI_FIDELITY_MAX_PIXEL_PCT ?? 3);
  const checks: Check[] = [];
  const cases: Record<string, unknown> = {};
  const check = (name: string, ok: boolean, detail?: unknown) => checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
  const report: Record<string, unknown> = {
    suite: "web",
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    maxPixelPct,
  };

  const { server, port } = await serveProbe();
  const url = `http://127.0.0.1:${port}/`;
  const work = mkdtempSync(join(tmpdir(), "scribui-fidelity-project-"));
  cpSync(resolve(__dirname, "../../../fixtures/project"), work, { recursive: true });
  const manifestPath = join(work, ".scribui/screens.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.app.baseUrl = url;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  let exitCode = 1;
  // a stuck step fails the run (with its name) instead of hanging CI
  const watchdog = setTimeout(() => {
    check(`the suite finished within ${WATCHDOG_MS / 1000} s`, false, { stuckAt: step });
    finish();
  }, WATCHDOG_MS);
  const finish = () => {
    clearTimeout(watchdog);
    report.cases = cases;
    report.checks = checks;
    report.summary = summary(checks);
    writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
    for (const c of checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}`);
    announce(`web, scale ${report.scaleFactor ?? "?"}`, checks);
    console.log(`FIDELITY_REPORT ${join(out, "report.json")} ${JSON.stringify(report.summary)}`);
    server.close();
    app.exit(checks.length && checks.every((c) => c.ok) ? exitCode : 1);
  };
  try {
    at("opening the project");
    const opened = await openProject(work, { surface: "view" });
    if (!opened.ok) throw new Error(`could not open the fidelity project: ${opened.error}`);
    const p = opened.project;
    p.win.setContentSize(WINDOW.width, WINDOW.height);
    await sleep(1500);
    report.scaleFactor = await p.win.webContents.executeJavaScript("devicePixelRatio");

    for (const size of SIZES) {
      at(`${size}: showing the probe page`);
      await p.win.webContents.executeJavaScript(SHOW_SIZE(size));
      await sleep(600);
      await loaded(p, url);
      await sleep(400);
      const c: Record<string, unknown> = {};
      cases[size] = c;

      // top of the page
      at(`${size}: capturing the top`);
      const top = await captureView(p, `${size} top`);
      writeFileSync(join(out, `${size}.top.electron.png`), top.png);
      const img = decode(top.png);
      const s = top.cap.device.scale;
      c.device = top.cap.device;
      for (const probe of [PROBES.probe, PROBES.turned, PROBES.header]) {
        const r = checkProbe(top.cap, img, probe);
        check(`${size}: ${probe.name} aligned`, r.ok, r);
      }
      const probeEl = findElement(top.cap, PROBES.probe.match);
      const mark = probeEl ? markResolves(top.cap, probeEl) : { ok: false, target: null, label: null };
      check(`${size}: a circle around the probe resolves to it`, mark.ok, mark);
      const box = colourBox(img, PROBES.probe.rgb, 40);
      const raw = box ? colourAt(img, box) : null;
      check(`${size}: raw sRGB values (probe is #ff00ff, no embedded profile)`, raw === "#ff00ff" && !img.hasColourProfile, { raw, profile: img.hasColourProfile });
      const fade = colourBox(img, FADE_RGB, 12);
      check(`${size}: a running transition is captured finished`, !!fade && fade.w >= 190 * s, fade);
      const spin = colourBox(img, SPIN_RGB, 12);
      check(`${size}: an infinite animation is captured at rest`, !!spin && Math.abs(spin.w - 40 * s) <= 2 && Math.abs(spin.h - 40 * s) <= 2, spin);

      // scrolled: the sticky header stays on top, the low probe is in view
      await p.live.webContents!.executeJavaScript(`scrollTo(0, ${SCROLL_TO}); true`);
      await nextPaint(p.live.webContents!);
      at(`${size}: capturing scrolled`);
      const scrolled = await captureView(p, `${size} scrolled`);
      writeFileSync(join(out, `${size}.scrolled.electron.png`), scrolled.png);
      const simg = decode(scrolled.png);
      for (const probe of [PROBES.header, PROBES.low]) {
        const r = checkProbe(scrolled.cap, simg, probe);
        check(`${size} scrolled: ${probe.name} aligned`, r.ok, r);
      }
      const header = checkProbe(scrolled.cap, simg, PROBES.header);
      check(`${size} scrolled: the sticky header is at the top`, header.pixels?.y === 0 && header.tree?.y === 0, header);
      await p.live.webContents!.executeJavaScript("scrollTo(0, 0); true");

      // today's path at the same CSS size and pixel ratio
      at(`${size}: capturing with Playwright`);
      const pw = await captureWithPlaywright(url, top.cap, work);
      writeFileSync(join(out, `${size}.top.playwright.png`), pw.png);
      const pixels = comparePixels(img, decode(pw.png));
      const trees = compareTrees(top.cap, pw.cap);
      c.pixels = pixels;
      c.trees = trees;
      check(`${size}: same picture as Playwright (≤ ${maxPixelPct}% of pixels differ)`, pixels.sameSize && pixels.differingPct <= maxPixelPct, pixels);
      check(`${size}: same element bounds as Playwright (≤ 1 px)`, trees.maxBoundsDeltaPx <= 1, trees);
      const pwProbe = checkProbe(pw.cap, decode(pw.png), PROBES.probe);
      check(`${size}: Playwright's probe aligned too (the reference)`, pwProbe.ok, pwProbe);
    }
    at("closing");
    await p.close();
    exitCode = checks.every((c) => c.ok) ? 0 : 1;
  } catch (e) {
    check("the suite ran to the end", false, (e as Error).stack ?? String(e));
  } finally {
    finish();
  }
}
