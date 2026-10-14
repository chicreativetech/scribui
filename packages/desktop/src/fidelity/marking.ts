import { createServer } from "node:http";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { app, nativeImage, type WebContents } from "electron";
import type { Annotation, ScreenManifest } from "@scribui/core";
import { openProject, type Project } from "../projectWindow.js";
import { nextPaint } from "../webCapture.js";

/**
 * Marking up the app tab (SCRIBUI_FIDELITY=marking): real mouse and key input
 * into the app's view, through the page's mark layer (markLayer.ts) and the
 * canvas (Marking.tsx). Checks that a mark becomes a note on a whole-page
 * screen with its element as anchor; that a second mark on the unchanged page
 * joins that screen; that the marks are drawn on the page where their elements
 * are, after scrolling and after leaving the page and coming back; that a
 * changed page gets a screen of its own; and that Escape stops marking.
 * Exits 1 when a check fails.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Review's orange (core ACCENT): the marks are drawn with its renderer
const MARK_RGB = [255, 79, 0] as const;

const PAGE = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>Marking probe</title><style>
  body { margin: 0; font: 16px sans-serif; background: #fff; }
  header { position: sticky; top: 0; height: 60px; background: #eee; }
  .box { position: absolute; left: 200px; width: 160px; height: 60px; background: #cde; }
</style></head><body>${body}</body></html>`;
const HOME = PAGE(`<header id="top">Header</header><div id="target" class="box" style="top: 300px">Target</div>
  <div id="far" class="box" style="top: 1500px">Far below</div><div style="height: 2400px"></div><a id="go" href="/other">other</a>`);
const OTHER = PAGE(`<h1 id="other">Another page</h1>`);

async function serve() {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(req.url?.startsWith("/other") ? OTHER : HOME);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` };
}

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

const canvas = <T>(p: Project, js: string) => p.win.webContents.executeJavaScript(js) as Promise<T>;
const page = <T>(wc: WebContents, js: string) => wc.executeJavaScript(js) as Promise<T>;

/** Center of an element of the page, in the view's coordinates. */
async function centerOf(wc: WebContents, sel: string): Promise<{ x: number; y: number }> {
  const r = await page<{ x: number; y: number; w: number; h: number }>(
    wc,
    `(() => { const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })()`,
  );
  const z = wc.getZoomFactor();
  return { x: Math.round((r.x + r.w / 2) * z), y: Math.round((r.y + r.h / 2) * z) };
}

async function click(wc: WebContents, x: number, y: number) {
  wc.sendInputEvent({ type: "mouseMove", x, y });
  wc.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
  await sleep(30);
  wc.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
  await sleep(150);
}

async function type(wc: WebContents, text: string) {
  for (const ch of text) wc.sendInputEvent({ type: "char", keyCode: ch });
  await sleep(50);
}

async function key(wc: WebContents, keyCode: string) {
  wc.sendInputEvent({ type: "keyDown", keyCode });
  wc.sendInputEvent({ type: "keyUp", keyCode });
  await sleep(150);
}

/** The mark colour somewhere within `r` px of a point of the view (its badge or outline). */
async function markNear(wc: WebContents, x: number, y: number, r = 16): Promise<boolean> {
  await nextPaint(wc);
  await sleep(150);
  const img = await wc.capturePage();
  const bmp = img.toBitmap();
  // the bitmap's pixels per view pixel: its width over the view's
  const viewWidth = (await page<number>(wc, "window.innerWidth")) * wc.getZoomFactor();
  const size = img.getSize();
  // getSize may be in view or device pixels; the bitmap is in device pixels
  const sf = Math.round(Math.sqrt(bmp.length / 4 / (size.width * size.height)) * 100) / 100 || 1;
  const w = Math.round(size.width * sf), h = Math.round(size.height * sf);
  const k = w / viewWidth;
  for (let dy = -r; dy <= r; dy += 2)
    for (let dx = -r; dx <= r; dx += 2) {
      const X = Math.round((x + dx) * k), Y = Math.round((y + dy) * k);
      if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
      const i = (Y * w + X) * 4;
      const R = bmp[i + 2]!, G = bmp[i + 1]!, B = bmp[i]!;
      if (Math.abs(R - MARK_RGB[0]) < 30 && Math.abs(G - MARK_RGB[1]) < 30 && Math.abs(B - MARK_RGB[2]) < 30) return true;
    }
  return false;
}

export async function runMarkingFidelity() {
  const checks: { name: string; ok: boolean; detail?: unknown }[] = [];
  const check = (name: string, ok: boolean, detail?: unknown) => {
    checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
  };
  const { server, url } = await serve();
  const work = mkdtempSync(join(tmpdir(), "scribui-marking-"));
  cpSync(resolve(__dirname, "../../../fixtures/project"), work, { recursive: true });
  const mPath = join(work, ".scribui/screens.json");
  const m = JSON.parse(readFileSync(mPath, "utf8")) as ScreenManifest;
  m.app.baseUrl = url;
  writeFileSync(mPath, JSON.stringify(m, null, 2));
  const watchdog = setTimeout(() => {
    check("the suite finished in time", false);
    done();
  }, 120_000);
  const done = () => {
    clearTimeout(watchdog);
    server.close();
    console.log(`MARKING ${checks.filter((c) => c.ok).length}/${checks.length} ok`);
    app.exit(checks.length && checks.every((c) => c.ok) ? 0 : 1);
  };

  try {
    const opened = await openProject(work, { surface: "view" });
    if (!opened.ok) throw new Error(opened.error);
    const p = opened.project;
    p.win.setContentSize(1300, 900);
    await waitFor("the canvas", () => canvas<boolean>(p, "!!window.__scribui"));
    await canvas(p, `window.__scribui.getState().set({ view: "live", liveVisited: true })`);
    const wc = await waitFor("the app's view", async () => {
      const w = p.live.webContents;
      return w && !w.isLoading() && w.getURL().startsWith(url) ? w : null;
    });
    await page(wc, "document.fonts.ready.then(() => true)");
    await sleep(500);

    const annotations = () => canvas<Annotation[]>(p, "window.__scribui.getState().annotations");
    const manifest = async () => JSON.parse(readFileSync(mPath, "utf8")) as ScreenManifest;

    // 1. a comment on #target
    await canvas(p, `window.__scribui.getState().setTool("comment")`);
    await sleep(300);
    const t = await centerOf(wc, "#target");
    await click(wc, t.x, t.y);
    await type(wc, "make it bigger");
    await key(wc, "Return");
    const first = await waitFor("the first note", async () => (await annotations()).find((a) => a.text === "make it bigger"));
    const s1 = (await manifest()).screens.find((s) => s.id === first.screenId);
    check("a mark captures the page as a whole-page screen", !!s1?.viewport?.fullPage && !!s1.pageSignature, s1);
    check("the note's anchor is the element it was made on", first.anchor?.selector === "#target", first.anchor);
    const scale = await canvas<number>(p, `window.__scribui.getState().captures.get(${JSON.stringify(first.screenId)}).device.scale`);
    const g = first.geometry as { x: number; y: number };
    check("the note sits on the element in the screenshot", Math.abs(g.x / scale - 280) < 3 && Math.abs(g.y / scale - 330) < 3, { g, scale });
    await sleep(400);
    check("the mark is drawn on the page", await markNear(wc, t.x, t.y));

    // 2. the wheel still scrolls the page while a tool is on; then a comment on #far: the same screen
    wc.sendInputEvent({ type: "mouseWheel", x: 600, y: 400, deltaX: 0, deltaY: -600 });
    await sleep(400);
    const wheeled = await page<number>(wc, "window.scrollY");
    check("the page scrolls with the wheel while a tool is on", wheeled > 100, { scrollY: wheeled });
    await page(wc, "window.scrollTo(0, 1200)");
    await sleep(300);
    const f = await centerOf(wc, "#far");
    await click(wc, f.x, f.y);
    await type(wc, "align left");
    await key(wc, "Return");
    const second = await waitFor("the second note", async () => (await annotations()).find((a) => a.text === "align left"));
    const g2 = second.geometry as { x: number; y: number };
    check("a second mark on the unchanged page joins its screen", second.screenId === first.screenId, { first: first.screenId, second: second.screenId });
    check("a mark after scrolling is placed in page coordinates", Math.abs(g2.y / scale - 1530) < 3, g2);
    check("the second mark is drawn where it was made", await markNear(wc, f.x, f.y));

    // a circle dragged around the header
    await canvas(p, `window.__scribui.getState().setTool("circle")`);
    await sleep(300);
    const loop = Array.from({ length: 24 }, (_, i) => [600 + 80 * Math.cos((i / 23) * 2 * Math.PI), 30 + 22 * Math.sin((i / 23) * 2 * Math.PI)] as const);
    wc.sendInputEvent({ type: "mouseMove", x: loop[0]![0], y: loop[0]![1] });
    wc.sendInputEvent({ type: "mouseDown", x: loop[0]![0], y: loop[0]![1], button: "left", clickCount: 1 });
    for (const [x, y] of loop) {
      wc.sendInputEvent({ type: "mouseMove", x: Math.round(x), y: Math.round(y), button: "left" } as Electron.MouseInputEvent);
      await sleep(10);
    }
    wc.sendInputEvent({ type: "mouseUp", x: loop[23]![0], y: loop[23]![1], button: "left", clickCount: 1 });
    await sleep(200);
    await type(wc, "lighter header");
    await key(wc, "Return");
    const circ = await waitFor("the circle", async () => (await annotations()).find((a) => a.kind === "circle"));
    check("a dragged circle becomes a note with its loop", circ.geometry.type === "path" && circ.geometry.points.length > 10 && circ.text === "lighter header", circ.geometry.type);
    await canvas(p, `window.__scribui.getState().setTool("comment")`);
    await sleep(200);

    // 3. back to the top: the first mark is drawn on #target again
    await page(wc, "window.scrollTo(0, 0)");
    await sleep(300);
    const t2 = await centerOf(wc, "#target");
    check("after scrolling back, the first mark is on its element", await markNear(wc, t2.x, t2.y));

    // 4. another page and back: the marks come back
    await canvas(p, `window.__scribui.getState().setTool("select")`);
    await sleep(200);
    p.live.navigate(`${url}other`);
    await waitFor("the other page", async () => (!wc.isLoading() && wc.getURL().includes("/other") ? true : null));
    await sleep(400);
    check("another page doesn't show this page's marks", !(await markNear(wc, t2.x, t2.y)));
    p.live.back();
    await waitFor("the page again", async () => (!wc.isLoading() && !wc.getURL().includes("/other") ? true : null));
    await sleep(900);
    await page(wc, "window.scrollTo(0, 0)");
    const t3 = await centerOf(wc, "#target");
    check("back on the page, its marks are drawn again", await markNear(wc, t3.x, t3.y));

    // 5. the page changes: a mark on it gets a screen of its own
    await page(wc, `document.body.insertAdjacentHTML("afterbegin", '<p style="height: 200px">New content</p>')`);
    await sleep(200);
    await canvas(p, `window.__scribui.getState().setTool("remove")`);
    await sleep(300);
    const t4 = await centerOf(wc, "#target");
    await click(wc, t4.x, t4.y);
    await key(wc, "Return");
    const third = await waitFor("the mark on the changed page", async () => (await annotations()).find((a) => a.kind === "remove"));
    check("a mark on a changed page gets a new screen", third.screenId !== first.screenId, { third: third.screenId });
    // that capture was taken with the earlier marks on the page: they stay out of it
    const cap = await p.store.readCapture(await p.store.latestRound().then((n) => n!), third.screenId);
    const img = nativeImage.createFromPath(join(p.store.roundDir((await p.store.latestRound())!), cap!.screenshot));
    const bmp = img.toBitmap();
    const W = img.getSize().width;
    let marked = 0;
    for (let i = 0; i < bmp.length; i += 16) if (Math.abs(bmp[i + 2]! - MARK_RGB[0]) < 30 && Math.abs(bmp[i + 1]! - MARK_RGB[1]) < 30 && Math.abs(bmp[i]! - MARK_RGB[2]) < 30) marked++;
    check("marks on the page stay out of the screenshot", marked === 0, { marked, width: W });

    // 6. a sketch: a box and a line with the sketch tools, Ready, a note; one sketch note with both parts
    await canvas(p, `window.__scribui.getState().setTool("box")`);
    await sleep(300);
    const drag = async (x0: number, y0: number, x1: number, y1: number) => {
      wc.sendInputEvent({ type: "mouseMove", x: x0, y: y0 });
      wc.sendInputEvent({ type: "mouseDown", x: x0, y: y0, button: "left", clickCount: 1 });
      for (let i = 1; i <= 6; i++) {
        wc.sendInputEvent({ type: "mouseMove", x: Math.round(x0 + ((x1 - x0) * i) / 6), y: Math.round(y0 + ((y1 - y0) * i) / 6), button: "left" } as Electron.MouseInputEvent);
        await sleep(10);
      }
      wc.sendInputEvent({ type: "mouseUp", x: x1, y: y1, button: "left", clickCount: 1 });
      await sleep(150);
    };
    await drag(700, 500, 900, 620);
    await canvas(p, `window.__scribui.getState().setTool("line")`);
    await sleep(300);
    await drag(700, 660, 900, 660);
    await key(wc, "Return");
    await type(wc, "a new card here");
    await key(wc, "Return");
    const sketch = await waitFor("the sketch", async () => (await annotations()).find((a) => a.kind === "sketch" && a.text === "a new card here"));
    check("sketch tools make one sketch note with all its parts", sketch.sketch?.parts?.map((x) => x.type).join() === "box,line", sketch.sketch?.parts?.map((x) => x.type));

    // 7. Escape in the page stops marking
    await key(wc, "Escape");
    await sleep(300);
    check("Escape stops marking", (await canvas<string>(p, "window.__scribui.getState().tool")) === "select");
  } catch (e) {
    check("the suite ran", false, (e as Error).message);
  }
  done();
}
