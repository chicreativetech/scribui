import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { app, WebContentsView } from "electron";
import { resolveAll, type ScreenCapture, type UIElement } from "@scribui/core";
import { loadChromium } from "@scribui/capture";
import { attachLiveCapture } from "../../cli/src/live.js";
import type { ViewSaveRequest } from "@scribui/server";
import { openProject } from "./main.js";
import { captureFromCanvas, liveFrame } from "./webCapture.js";

/**
 * Spike W harness: captures the same views with the desktop path (main process
 * + DevTools) and today's path (Playwright-controlled browser), and measures
 * pixels, element bounds and probe alignment; then checks pages that refuse
 * embedding, in the iframe and in a WebContentsView. Results go to
 * SCRIBUI_SPIKE_OUT (default: a temp folder) as JSON and PNGs.
 */

const PROBE_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Probe</title><style>
  body { margin: 0; font: 16px/1.4 -apple-system, Helvetica, Arial, sans-serif; background: #ffffff; }
  header { position: sticky; top: 0; height: 56px; background: #1e3a2f; color: #fff; display: flex; align-items: center; padding: 0 16px; }
  #probe { position: absolute; left: 40px; top: 120px; width: 160px; height: 80px; background: #ff00ff; }
  #turned { position: absolute; left: 260px; top: 120px; width: 100px; height: 100px; background: #00ffff; transform: rotate(12deg); }
  #fade { position: absolute; left: 40px; top: 260px; width: 200px; height: 40px; background: #00ff00; opacity: 0.2; transition: opacity 30s linear; }
  #fade.on { opacity: 1; }
  #spin { position: absolute; left: 280px; top: 260px; width: 40px; height: 40px; background: #0000ff; animation: spin 2s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  input { position: absolute; left: 40px; top: 340px; width: 240px; height: 32px; font-size: 16px; }
  .tall { height: 1600px; }
</style></head><body>
  <header id="top">Probe page</header>
  <div id="probe" role="img" aria-label="probe"></div>
  <div id="turned"></div>
  <div id="fade"></div>
  <div id="spin"></div>
  <input id="field" value="caret here">
  <div class="tall"></div>
  <script>requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById("fade").classList.add("on"))); document.getElementById("field").focus();</script>
</body></html>`;

const REFUSING_PAGE = `<!doctype html><html><head><title>Refuses embedding</title></head><body style="margin:0;background:#ffcc00;font:20px sans-serif">
<p id="msg">This page sends X-Frame-Options: DENY</p></body></html>`;

const BUSTING_PAGE = `<!doctype html><html><head><title>Frame buster</title><script>if (top !== self) top.location = self.location;</script></head>
<body style="margin:0;background:#cc33ff"><p>frame-busting page</p></body></html>`;

function startSite(): Promise<{ server: Server; base: string }> {
  return new Promise((done) => {
    const server = createServer((req, res) => {
      if (req.url === "/refuses") {
        res.writeHead(200, { "content-type": "text/html", "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'" });
        return res.end(REFUSING_PAGE);
      }
      if (req.url === "/busts") {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(BUSTING_PAGE);
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(PROBE_PAGE);
    });
    server.listen(0, "127.0.0.1", () => {
      const a = server.address() as { port: number };
      done({ server, base: `http://127.0.0.1:${a.port}` });
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Put the canvas on the app tab, at a size preset, showing `url`. */
const SHOW_APP = (url: string, size: string) => `(async () => {
  localStorage.setItem("scribui:live-size", ${JSON.stringify(size)});
  const st = window.__scribui.getState();
  st.set({ view: "live", liveVisited: true });
  await new Promise((r) => setTimeout(r, 300));
  const sel = [...document.querySelectorAll(".live-bar select")].find((s) => [...s.options].some((o) => o.value === ${JSON.stringify(size)}));
  if (sel && sel.value !== ${JSON.stringify(size)}) {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(sel, ${JSON.stringify(size)});
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  }
  const input = document.querySelector(".live-address input");
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(url)});
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.form ? input.form.requestSubmit() : input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  return true;
})()`;

type Px = { w: number; h: number; data: Buffer; profile: boolean };

/**
 * Raw PNG values (8-bit RGB/RGBA, not interlaced), with no colour management:
 * what resvg and the agent see. Returned as BGRA to match the helpers below.
 */
function bitmap(path: string): Px {
  const b = readFileSync(path);
  let i = 8;
  let w = 0, h = 0, type = 0, profile = false;
  const idat: Buffer[] = [];
  while (i < b.length) {
    const len = b.readUInt32BE(i);
    const t = b.toString("ascii", i + 4, i + 8);
    const d = b.subarray(i + 8, i + 8 + len);
    if (t === "IHDR") {
      w = d.readUInt32BE(0); h = d.readUInt32BE(4); type = d[9]!;
      if (d[8] !== 8 || d[12] !== 0) throw new Error("only 8-bit, non-interlaced PNGs");
    } else if (t === "iCCP") profile = true;
    else if (t === "IDAT") idat.push(d);
    i += 12 + len;
  }
  const bpp = type === 6 ? 4 : type === 2 ? 3 : 0;
  if (!bpp) throw new Error(`PNG colour type ${type} not handled`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const px = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x]!;
      const a = x >= bpp ? px[y * stride + x - bpp]! : 0;
      const up = y > 0 ? px[(y - 1) * stride + x]! : 0;
      const c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp]! : 0;
      const p = a + up - c;
      const pr = Math.abs(p - a) <= Math.abs(p - up) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - up) <= Math.abs(p - c) ? up : c;
      px[y * stride + x] = (v + (f === 0 ? 0 : f === 1 ? a : f === 2 ? up : f === 3 ? (a + up) >> 1 : pr)) & 255;
    }
  }
  const data = Buffer.alloc(w * h * 4);
  for (let p = 0, q = 0; p < px.length; p += bpp, q += 4) {
    data[q] = px[p + 2]!; data[q + 1] = px[p + 1]!; data[q + 2] = px[p]!; data[q + 3] = bpp === 4 ? px[p + 3]! : 255;
  }
  return { w, h, data, profile };
}

function pixelDiff(a: Px, b: Px) {
  if (a.w !== b.w || a.h !== b.h) return { sameSize: false, a: `${a.w}×${a.h}`, b: `${b.w}×${b.h}` };
  let differ = 0;
  let maxDelta = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.max(Math.abs(a.data[i]! - b.data[i]!), Math.abs(a.data[i + 1]! - b.data[i + 1]!), Math.abs(a.data[i + 2]! - b.data[i + 2]!));
    if (d > 8) differ++;
    maxDelta = Math.max(maxDelta, d);
  }
  return { sameSize: true, size: `${a.w}×${a.h}`, differingPixels: differ, differingPct: +((100 * differ) / (a.w * a.h)).toFixed(3), maxChannelDelta: maxDelta };
}

/** Bounding box of pixels close to a colour (BGRA bitmap). */
function colourBox(p: Px, rgb: [number, number, number], tol = 24) {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = 0; y < p.h; y++)
    for (let x = 0; x < p.w; x++) {
      const i = (y * p.w + x) * 4;
      if (Math.abs(p.data[i + 2]! - rgb[0]) <= tol && Math.abs(p.data[i + 1]! - rgb[1]) <= tol && Math.abs(p.data[i]! - rgb[2]) <= tol) {
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
    }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

const flatten = (el: UIElement, out = new Map<string, UIElement>()) => {
  out.set(el.id, el);
  for (const c of el.children) flatten(c, out);
  return out;
};

function treeDiff(a: ScreenCapture, b: ScreenCapture) {
  const A = flatten(a.root);
  const B = flatten(b.root);
  let matched = 0;
  let maxDelta = 0;
  const onlyA = [...A.keys()].filter((k) => !B.has(k));
  const onlyB = [...B.keys()].filter((k) => !A.has(k));
  for (const [id, ea] of A) {
    const eb = B.get(id);
    if (!eb) continue;
    matched++;
    maxDelta = Math.max(maxDelta, Math.abs(ea.bounds.x - eb.bounds.x), Math.abs(ea.bounds.y - eb.bounds.y), Math.abs(ea.bounds.w - eb.bounds.w), Math.abs(ea.bounds.h - eb.bounds.h));
  }
  return { elementsA: A.size, elementsB: B.size, matched, onlyA: onlyA.slice(0, 8), onlyB: onlyB.slice(0, 8), maxBoundsDeltaPx: +maxDelta.toFixed(2) };
}

/** Probe alignment: the #probe element's bounds in the tree vs where magenta is in the screenshot. */
function alignment(cap: ScreenCapture, png: Px) {
  const probe = flatten(cap.root).get("probe");
  const seen = colourBox(png, [255, 0, 255]);
  if (!probe || !seen) return { probe: !!probe, seen: !!seen };
  return {
    tree: probe.bounds,
    pixels: seen,
    maxDeltaPx: Math.max(Math.abs(probe.bounds.x - seen.x), Math.abs(probe.bounds.y - seen.y), Math.abs(probe.bounds.w - seen.w), Math.abs(probe.bounds.h - seen.h)),
  };
}

/** Is the #fade transition finished (opaque green) and the caret hidden? Checks the frozen-animation behaviour. */
/** A circle drawn around the probe resolves to the probe element. */
function markResolves(cap: ScreenCapture): { target: string | null; ok: boolean } {
  const p = flatten(cap.root).get("probe");
  if (!p) return { target: null, ok: false };
  const cx = p.bounds.x + p.bounds.w / 2, cy = p.bounds.y + p.bounds.h / 2;
  const points: [number, number][] = Array.from({ length: 24 }, (_, i) => {
    const a = (i / 24) * Math.PI * 2;
    return [cx + Math.cos(a) * (p.bounds.w / 2 + 12), cy + Math.sin(a) * (p.bounds.h / 2 + 12)];
  });
  const [a] = resolveAll([{ id: "m", screenId: cap.screenId, kind: "circle", geometry: { type: "path", points } }], new Map([[cap.screenId, cap.root]]));
  const target = a?.resolution?.elements[0] ?? null;
  return { target, ok: target === "probe" };
}

/** Raw value of the probe's centre: #ff00ff when the capture is sRGB. */
function probeColour(p: Px) {
  const box = colourBox(p, [255, 0, 255], 40);
  if (!box) return null;
  const i = ((box.y + (box.h >> 1)) * p.w + box.x + (box.w >> 1)) * 4;
  return "#" + [p.data[i + 2]!, p.data[i + 1]!, p.data[i]!].map((v) => v.toString(16).padStart(2, "0")).join("");
}

function animationState(png: Px, scale: number) {
  const fade = colourBox(png, [0, 255, 0], 12);
  return { fadeFinished: !!fade && fade.w >= 190 * scale };
}

export async function runSpike(_dir: string | null) {
  const out = resolve(process.env.SCRIBUI_SPIKE_OUT ?? mkdtempSync(join(tmpdir(), "scribui-spike-w-")));
  mkdirSync(out, { recursive: true });
  const report: Record<string, unknown> = { electron: process.versions.electron, chromium: process.versions.chrome, platform: process.platform, arch: process.arch };

  // a throwaway project pointing at the test site
  const { server, base } = await startSite();
  // SCRIBUI_SPIKE_PROJECT: run against an existing project (e.g. one the CLI already owns)
  const projectDir = process.env.SCRIBUI_SPIKE_PROJECT ?? mkdtempSync(join(tmpdir(), "scribui-spike-project-"));
  if (!process.env.SCRIBUI_SPIKE_PROJECT) cpSync(resolve(__dirname, "../../../fixtures/project"), projectDir, { recursive: true });
  const manifestPath = join(projectDir, ".scribui/screens.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.app.baseUrl = base;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const project = await openProject(projectDir);
  if (!project) throw new Error("could not open the spike project");
  const wc = project.win.webContents;
  report.desktopRole = project.guest ? "guest (another process owns the project)" : "owner";
  await sleep(1500);
  const contentSize = project.win.getContentSize();
  report.window = { content: contentSize, scaleFactor: (await wc.executeJavaScript("devicePixelRatio")) as number };

  // today's path: Playwright drives a browser on the same canvas
  const chromium = (await loadChromium(resolve(__dirname, "../../.."))) as {
    launch(o: object): Promise<{ version(): string; newContext(o: object): Promise<unknown>; close(): Promise<void> }>;
  };
  const browser = await chromium.launch({ headless: true });
  report.playwrightChromium = browser.version();
  const ctx = (await browser.newContext({ viewport: { width: contentSize[0], height: contentSize[1] }, deviceScaleFactor: report.window ? ((report.window as { scaleFactor: number }).scaleFactor) : 2 })) as {
    newPage(): Promise<{ goto(u: string): Promise<unknown>; evaluate<T>(f: string): Promise<T>; waitForTimeout(ms: number): Promise<void> }>;
  };
  await attachLiveCapture(ctx, (req: ViewSaveRequest) => project.save(req));
  const page = await ctx.newPage();
  await page.goto(wc.getURL());
  await page.waitForTimeout(1500);

  const cases: { name: string; size: string; url: string }[] = [
    { name: "fit", size: "fit", url: `${base}/` },
    { name: "phone", size: "phone", url: `${base}/` },
    { name: "desktop-beyond-window", size: "desktop", url: `${base}/` },
  ];
  const results: Record<string, unknown> = {};
  for (const c of cases) {
    await wc.executeJavaScript(SHOW_APP(c.url, c.size));
    await page.evaluate(SHOW_APP(c.url, c.size));
    await sleep(1800);
    await page.waitForTimeout(300);
    const el = await captureFromCanvas(wc, { title: `el-${c.name}` }, project.save);
    const pw = await page.evaluate<{ round: number; screenId: string }>(`window.__scribuiCapture({ title: "pw-${c.name}" })`);
    const capEl = (await project.store.readCapture(el.round, el.screenId))!;
    const capPw = (await project.store.readCapture(pw.round, pw.screenId))!;
    const pngEl = join(project.store.roundDir(el.round), capEl.screenshot);
    const pngPw = join(project.store.roundDir(pw.round), capPw.screenshot);
    cpSync(pngEl, join(out, `${c.name}.electron.png`));
    cpSync(pngPw, join(out, `${c.name}.playwright.png`));
    const a = bitmap(pngEl);
    const b = bitmap(pngPw);
    results[c.name] = {
      electron: { device: capEl.device, colourProfile: a.profile, alignment: alignment(capEl, a), mark: markResolves(capEl), animation: animationState(a, capEl.device.scale), probeColour: probeColour(a) },
      playwright: { device: capPw.device, colourProfile: b.profile, alignment: alignment(capPw, b), animation: animationState(b, capPw.device.scale), probeColour: probeColour(b) },
      pixels: pixelDiff(a, b),
      tree: treeDiff(capEl, capPw),
    };
  }
  report.capture = results;

  // pages that refuse embedding: iframe vs WebContentsView
  await wc.executeJavaScript(SHOW_APP(`${base}/refuses`, "fit"));
  await sleep(1500);
  const f = liveFrame(wc);
  const iframeText = f ? String(await f.executeJavaScript("document.body ? document.body.innerText.slice(0, 80) : ''").catch((e: Error) => `error: ${e.message}`)) : "no frame";
  const view = new WebContentsView({ webPreferences: { session: wc.session, contextIsolation: true, sandbox: true, nodeIntegration: false } });
  project.win.contentView.addChildView(view);
  view.setBounds({ x: 150, y: 60, width: 800, height: 600 });
  await view.webContents.loadURL(`${base}/refuses`);
  const viewText = String(await view.webContents.executeJavaScript("document.getElementById('msg')?.innerText ?? ''"));
  const viewShot = await view.webContents.capturePage();
  writeFileSync(join(out, "refuses.webcontentsview.png"), viewShot.toPNG());
  writeFileSync(join(out, "refuses.iframe-window.png"), (await wc.capturePage()).toPNG());
  report.refusesEmbedding = { iframe: { frameUrl: f?.url ?? null, text: iframeText }, webContentsView: { url: view.webContents.getURL(), text: viewText } };

  // frame-busting script: in the iframe it tries to navigate the canvas window away
  view.webContents.close();
  project.win.contentView.removeChildView(view);
  let topNavigationBlocked = false;
  wc.once("will-navigate", () => (topNavigationBlocked = true));
  await wc.executeJavaScript(SHOW_APP(`${base}/busts`, "fit"));
  await sleep(1500);
  report.frameBusting = { canvasStillShown: wc.getURL().startsWith(project.canvasOrigin), topNavigationAttempted: topNavigationBlocked };

  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
  console.log(`SPIKE_REPORT ${join(out, "report.json")}`);
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
  server.close();
  await project.close();
  app.exit(0);
}
