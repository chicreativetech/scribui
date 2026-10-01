import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { RawElement, ScreenCapture, ScreenEntry } from "@intentcue/core";
import { CaptureError } from "../exec.js";
import { pngSize } from "../png.js";
import type { CaptureAdapter, CaptureContext } from "../types.js";
import { resolveFlowPath, screenshotPath, toCapture, writePng } from "./shared.js";

// Minimal structural types so playwright stays an optional peer dependency.
type Page = {
  goto(url: string, o?: object): Promise<unknown>;
  waitForLoadState(s: string, o?: object): Promise<void>;
  screenshot(o?: object): Promise<Uint8Array>;
  evaluate<T>(fn: string): Promise<T>;
  close(): Promise<void>;
};
type Context = { newPage(): Promise<Page>; close(): Promise<void> };
type Browser = { newContext(o?: object): Promise<Context>; close(): Promise<void> };
type Chromium = { launch(o?: object): Promise<Browser>; executablePath(): string };

const DEFAULT_VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 2 };

/**
 * Walks the DOM in page context. Returns a RawElement tree in CSS pixels,
 * clipped to the viewport (or the full page when `full` is set).
 */
const DOM_WALK = String.raw`(() => {
  const SKIP = new Set(["SCRIPT","STYLE","NOSCRIPT","TEMPLATE","META","LINK","HEAD","TITLE","BR","WBR"]);
  const full = !!window.__intentcueFullPage;
  const vw = full ? document.documentElement.scrollWidth : window.innerWidth;
  const vh = full ? document.documentElement.scrollHeight : window.innerHeight;
  const sx = full ? 0 : window.scrollX, sy = full ? 0 : window.scrollY;
  const clip = (r) => {
    const x = Math.max(0, r.left + (full ? window.scrollX : 0));
    const y = Math.max(0, r.top + (full ? window.scrollY : 0));
    const x2 = Math.min(vw, r.right + (full ? window.scrollX : 0));
    const y2 = Math.min(vh, r.bottom + (full ? window.scrollY : 0));
    return { x, y, w: Math.max(0, x2 - x), h: Math.max(0, y2 - y) };
  };
  const ownText = (el) => {
    let t = "";
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.textContent;
    return t.replace(/\s+/g, " ").trim();
  };
  const typeOf = (el) => {
    const tag = el.tagName, role = el.getAttribute("role"), t = (el.getAttribute("type") || "").toLowerCase();
    if (role === "button" || tag === "BUTTON" || (tag === "INPUT" && ["button","submit","reset"].includes(t))) return "button";
    if (role === "switch" || role === "checkbox" || role === "radio" || (tag === "INPUT" && ["checkbox","radio"].includes(t))) return "toggle";
    if (role === "slider" || (tag === "INPUT" && t === "range")) return "slider";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || role === "textbox" || role === "searchbox" || el.isContentEditable) return "input";
    if (tag === "A" && el.hasAttribute("href")) return "link";
    if (role === "link") return "link";
    if (tag === "IMG" || tag === "SVG" || tag === "PICTURE" || tag === "CANVAS" || tag === "VIDEO" || role === "img") return "image";
    if (role === "tab") return "tab";
    if (role === "tablist") return "tabbar";
    if (role === "toolbar") return "toolbar";
    if (tag === "NAV" || role === "navigation") return "navbar";
    if (tag === "UL" || tag === "OL" || role === "list" || role === "listbox" || role === "grid") return "list";
    if (tag === "LI" || role === "listitem" || role === "option" || role === "row") return "cell";
    if (/^H[1-6]$/.test(tag) || tag === "P" || tag === "LABEL" || tag === "SPAN" && !el.children.length) return ownText(el) ? "text" : "container";
    if (!el.children.length && ownText(el)) return "text";
    return "container";
  };
  const labelOf = (el, type) => {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim();
    if (type === "image") return (el.getAttribute("alt") || el.getAttribute("title") || "").trim();
    if (type === "input") return (el.getAttribute("placeholder") || el.value || el.getAttribute("name") || "").toString().trim();
    if (type === "button" || type === "link" || type === "tab" || type === "cell" || type === "toggle")
      return (el.innerText || el.value || "").replace(/\s+/g, " ").trim().slice(0, 80);
    return ownText(el).slice(0, 80);
  };
  const walk = (el) => {
    if (SKIP.has(el.tagName)) return null;
    const cs = getComputedStyle(el);
    if (cs.display === "none") return null;
    const r = el.getBoundingClientRect();
    const b = clip(r);
    const hidden = cs.visibility === "hidden" || Number(cs.opacity) === 0;
    const type = typeOf(el);
    const children = [];
    if (type !== "image" || el.tagName !== "SVG") {
      for (const c of el.children) { const k = walk(c); if (k) children.push(k); }
    }
    const node = { type, nativeType: el.tagName.toLowerCase(), bounds: b, visible: !hidden, children };
    const tid = el.getAttribute("data-testid") || el.getAttribute("data-test-id") || el.getAttribute("data-test");
    if (tid) { node.id = tid; node.idSource = "testId"; }
    else if (el.id) { node.id = el.id; node.idSource = "dom"; }
    const label = labelOf(el, type);
    if (label) node.label = label;
    const comp = el.getAttribute("data-component");
    const src = el.getAttribute("data-source");
    if (comp || src) {
      const m = /^(.*?)(?::(\d+))?$/.exec(src || "");
      node.source = { file: (m && m[1]) || "", ...(m && m[2] ? { line: Number(m[2]) } : {}), ...(comp ? { component: comp } : {}) };
    }
    return node;
  };
  const body = walk(document.body) || { type: "container", bounds: { x: 0, y: 0, w: vw, h: vh }, children: [] };
  return { type: "screen", nativeType: "document", bounds: { x: 0, y: 0, w: vw, h: vh }, children: [body], __scroll: [sx, sy] };
})()`;

export class WebAdapter implements CaptureAdapter {
  readonly platform = "web" as const;
  private browser: Browser | null = null;
  private page: Page | null = null;
  private context: Context | null = null;

  constructor(private ctx: CaptureContext) {}

  /** Playwright from the project being reviewed first (works with a global intentcue), then our own. */
  private async chromium(): Promise<Chromium> {
    type Mod = { chromium?: Chromium; default?: { chromium?: Chromium } };
    const load = async (spec: string) => {
      const mod = (await import(spec)) as Mod;
      const c = mod.chromium ?? mod.default?.chromium;
      if (!c) throw new Error("no chromium export");
      return c;
    };
    // the project first, then the shared install intentcue makes for projects without package.json
    for (const base of [dirname(this.ctx.reviewDir), join(homedir(), ".intentcue", "runtime")]) {
      try {
        const req = createRequire(join(base, "package.json"));
        return await load(pathToFileURL(req.resolve("playwright")).href);
      } catch {
        /* not there */
      }
    }
    try {
      return await load("playwright");
    } catch {
      throw new CaptureError("playwright is not installed", "npm i -D playwright && npx playwright install chromium");
    }
  }

  async check() {
    const problems: string[] = [];
    try {
      const c = await this.chromium();
      const { existsSync } = await import("node:fs");
      if (!existsSync(c.executablePath())) problems.push("Chromium for Playwright is missing: npx playwright install chromium (or run intentcue to install it)");
    } catch (e) {
      const ce = e as CaptureError;
      problems.push(`${ce.message}. Install: ${ce.detail ?? ""}`.trim());
    }
    const base = this.ctx.manifest.app.baseUrl;
    const needsBase = this.ctx.manifest.screens.some((s) => s.url && !/^[a-z]+:/i.test(s.url));
    if (needsBase && !base) problems.push('screens.json: relative screen urls need "app.baseUrl"');
    if (base && needsBase) {
      try {
        await fetch(base, { signal: AbortSignal.timeout(4000) });
      } catch {
        problems.push(`App not reachable at ${base}. Start your dev server first.`);
      }
    }
    return { ok: problems.length === 0, problems };
  }

  private urlFor(screen: ScreenEntry): string {
    if (!screen.url) throw new CaptureError(`screen "${screen.id}" has no url`);
    if (/^[a-z]+:/i.test(screen.url)) return screen.url;
    const base = this.ctx.manifest.app.baseUrl;
    if (!base) throw new CaptureError('relative url needs "app.baseUrl" in screens.json');
    return new URL(screen.url, base.endsWith("/") ? base : base + "/").toString();
  }

  async prepare(screen: ScreenEntry) {
    if (!this.browser) this.browser = await (await this.chromium()).launch({ headless: true });
    await this.context?.close().catch(() => {});
    const vp = { ...DEFAULT_VIEWPORT, ...screen.viewport };
    this.context = await this.browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.deviceScaleFactor,
      isMobile: vp.width < 600,
      hasTouch: vp.width < 600,
    });
    this.page = await this.context.newPage();
    try {
      await this.page.goto(this.urlFor(screen), { waitUntil: "load", timeout: 30_000 });
      await this.page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
    } catch (e) {
      throw new CaptureError(`could not open ${this.urlFor(screen)}`, String((e as Error).message ?? e));
    }
    if (screen.setup) {
      const path = resolveFlowPath(this.ctx, screen.setup);
      try {
        const mod = (await import(pathToFileURL(path).href + `?t=${Date.now()}`)) as {
          default?: (page: Page, screen: ScreenEntry) => Promise<void>;
        };
        await mod.default?.(this.page, screen);
      } catch (e) {
        throw new CaptureError(`setup script failed for "${screen.id}" (${screen.setup})`, String((e as Error).stack ?? e));
      }
    }
    // settle animations
    await this.page.evaluate(`document.fonts ? document.fonts.ready.then(() => true) : true`);
    await new Promise((r) => setTimeout(r, 150));
  }

  async capture(screen: ScreenEntry): Promise<ScreenCapture> {
    if (!this.page) await this.prepare(screen);
    const page = this.page!;
    const full = !!screen.viewport?.fullPage;
    await page.evaluate(`window.__intentcueFullPage = ${full}`);
    const png = await page.screenshot({ type: "png", fullPage: full, animations: "disabled", caret: "hide" });
    const shot = screenshotPath(this.ctx, screen.id);
    await writePng(shot.abs, png);
    const px = pngSize(png);

    const css = await page.evaluate<RawElement>(DOM_WALK);
    const vp = { ...DEFAULT_VIEWPORT, ...screen.viewport };
    const scale = vp.deviceScaleFactor ?? px.width / css.bounds.w;
    const raw = scaleTree(css, scale);
    const device = { name: `Chromium ${vp.width}×${vp.height}`, width: Math.round(px.width / scale), height: Math.round(px.height / scale), scale };
    await page.close();
    this.page = null;
    return toCapture(screen, "web", device, shot.rel, raw, px);
  }

  async dispose() {
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    this.browser = null;
  }
}

function scaleTree(e: RawElement, s: number): RawElement {
  const { x, y, w, h } = e.bounds;
  const out: RawElement = { ...e, bounds: { x: x * s, y: y * s, w: w * s, h: h * s }, children: e.children.map((c) => scaleTree(c, s)) };
  delete (out as { __scroll?: unknown }).__scroll;
  return out;
}
