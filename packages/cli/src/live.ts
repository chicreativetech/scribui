import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { captureLiveFrame, loadChromium } from "@scribui/capture";
import type { ScreenEntry } from "@scribui/core";
import type { ReviewStore } from "@scribui/server";
import { carryForward } from "./capture.js";

/**
 * The live window: a Chrome window ScribUI controls, showing the canvas. Its
 * app tab embeds the running app; "Capture view" calls a function this module
 * exposes to the page, which screenshots the embedded app exactly as the user
 * left it (login, open menus, form input) and adds it to the open round.
 */

export type LiveCaptureRequest = { title?: string; replace?: string };
export type LiveCaptureResult = { round: number; screenId: string; title: string };

type Frame = {
  url(): string;
  title(): Promise<string>;
  evaluate<T>(fn: string): Promise<T>;
  parentFrame(): Frame | null;
};
type ElementHandle = { contentFrame(): Promise<Frame | null>; screenshot(o?: object): Promise<Uint8Array> };
type Page = {
  goto(url: string): Promise<unknown>;
  bringToFront(): Promise<void>;
  isClosed(): boolean;
  $(selector: string): Promise<ElementHandle | null>;
  evaluate(fn: string): Promise<unknown>;
  mainFrame(): Frame;
  on(event: "framenavigated", cb: (f: Frame) => void): void;
};
type Context = {
  pages(): Page[];
  newPage(): Promise<Page>;
  exposeBinding(name: string, cb: (source: { page: Page }, arg: unknown) => unknown): Promise<void>;
  on(event: "close" | "page", cb: (p?: Page) => void): void;
  close(): Promise<void>;
};
type Chromium = { launchPersistentContext(dir: string, o: object): Promise<Context> };

export type LiveWindow = {
  /** Bring the canvas window to the front, reopening it if it was closed. */
  show(): Promise<void>;
  close(): Promise<void>;
};

/** Open the live window on the canvas. Returns null when Chrome can't be started. */
export async function openLiveWindow(store: ReviewStore, canvasUrl: string, onError?: (msg: string) => void): Promise<LiveWindow | null> {
  let chromium: Chromium;
  try {
    chromium = (await loadChromium(store.root)) as Chromium;
  } catch (e) {
    onError?.((e as Error).message);
    return null;
  }
  // one profile per project: logins persist between sessions, and several projects can be open at once
  const profile = join(homedir(), ".scribui", "browser", createHash("sha1").update(store.root).digest("hex").slice(0, 12));
  await mkdir(profile, { recursive: true });

  let ctx: Context | null = null;

  const launch = async (): Promise<Context | null> => {
    const opts = { headless: false, viewport: null, args: ["--no-first-run", "--no-default-browser-check"] };
    let c: Context;
    try {
      c = await chromium.launchPersistentContext(profile, { ...opts, channel: "chrome" }); // your installed Chrome
    } catch {
      try {
        c = await chromium.launchPersistentContext(profile, opts); // Playwright's Chromium
      } catch (e) {
        onError?.((e as Error).message.split("\n")[0]!);
        return null;
      }
    }
    await attachLiveCapture(c, store);
    c.on("close", () => {
      if (ctx === c) ctx = null;
    });
    const page = c.pages()[0] ?? (await c.newPage());
    await page.goto(canvasUrl);
    return c;
  };

  ctx = await launch();
  if (!ctx) return null;

  return {
    async show() {
      if (!ctx) ctx = await launch();
      if (!ctx) return;
      const page = ctx.pages().find((p) => !p.isClosed());
      if (page) await page.bringToFront();
      else await (await ctx.newPage()).goto(canvasUrl);
    },
    async close() {
      await ctx?.close().catch(() => {});
      ctx = null;
    },
  };
}

/**
 * Give every canvas page in this browser context the capture function the
 * app tab calls, and report the embedded app's navigations to it.
 */
export async function attachLiveCapture(context: unknown, store: ReviewStore) {
  const c = context as Context;
  let busy = false;
  await c.exposeBinding("__scribuiCapture", async ({ page }, arg) => {
    if (busy) throw new Error("a capture is already running");
    busy = true;
    try {
      return await captureFromPage(store, page, (arg ?? {}) as LiveCaptureRequest);
    } finally {
      busy = false;
    }
  });
  const watch = (p: Page) =>
    // the canvas can't read a cross-origin frame's url; tell it where the embedded app went
    p.on("framenavigated", (f) => {
      if (f.parentFrame() !== p.mainFrame()) return;
      void p.evaluate(`window.dispatchEvent(new CustomEvent("scribui:live-url", { detail: ${JSON.stringify(f.url())} }))`).catch(() => {});
    });
  for (const p of c.pages()) watch(p);
  c.on("page", (p) => p && watch(p));
}

async function captureFromPage(store: ReviewStore, page: Page, req: LiveCaptureRequest): Promise<LiveCaptureResult> {
  const element = await page.$("iframe[data-scribui-live]");
  const frame = await element?.contentFrame();
  if (!element || !frame) throw new Error("the app tab isn't showing an app");
  const url = frame.url();
  if (!/^https?:/.test(url)) throw new Error("the app hasn't loaded yet");
  const pageTitle = (await frame.title().catch(() => "")).trim();
  return saveLiveCapture(store, {
    url,
    title: req.title?.trim() || pageTitle || new URL(url).pathname,
    ...(req.replace ? { replace: req.replace } : {}),
    capture: async (screen, roundDir) => {
      await page.evaluate(ISOLATE);
      try {
        return await captureLiveFrame({ frame, element, screen, roundDir });
      } finally {
        await page.evaluate(RESTORE).catch(() => {});
      }
    },
  });
}

/**
 * For the moment of the screenshot, only the app: the canvas's own interface
 * is hidden and the app is pinned to the window's top-left corner at its
 * current size, so nothing of ScribUI (toolbar, panel, toasts, or a scroll
 * area cutting the app off) ends up in the picture. The frame isn't moved in
 * the DOM, so the app doesn't reload and keeps its state.
 */
const ISOLATE = String.raw`(() => {
  const f = document.querySelector("iframe[data-scribui-live]");
  const r = f.getBoundingClientRect();
  const st = document.createElement("style");
  st.id = "scribui-capturing";
  st.textContent = "html, body, body * { visibility: hidden !important; transition: none !important; }" +
    "iframe[data-scribui-live] { visibility: visible !important; position: fixed !important; left: 0 !important; top: 0 !important;" +
    " margin: 0 !important; box-shadow: none !important; transform: none !important; z-index: 2147483647 !important;" +
    " width: " + r.width + "px !important; height: " + r.height + "px !important; }";
  document.head.appendChild(st);
})()`;
const RESTORE = `document.getElementById("scribui-capturing")?.remove()`;

/**
 * Add one hand-captured view to the open round: a new round when the latest
 * one is already sent or applied (its screens carried forward), and an entry
 * in screens.json so the agent and later rounds know about it.
 */
export async function saveLiveCapture(
  store: ReviewStore,
  opts: {
    url: string;
    title: string;
    replace?: string;
    capture: (screen: ScreenEntry, roundDir: string) => Promise<import("@scribui/core").ScreenCapture>;
  },
): Promise<LiveCaptureResult> {
  const manifest = await store.readManifest();
  const latest = await store.latestRound();
  const st = latest !== null ? await store.readStatus(latest).catch(() => null) : null;
  if (st?.status === "capturing") throw new Error("a capture is running; try again when it's done");

  let n: number;
  if (latest !== null && st?.status === "open") n = latest;
  else {
    n = await store.createRound();
    const carried = latest !== null ? await carryForward(store, latest, n) : [];
    await store.setStatus(n, "open", { screens: carried });
  }

  const starter = await store.isStarterManifest();
  const existing = starter ? [] : manifest.screens;
  const replacing = opts.replace ? existing.find((s) => s.id === opts.replace) : undefined;
  if (opts.replace && !replacing) throw new Error(`no screen "${opts.replace}"`);

  const base = manifest.app.baseUrl;
  const url = base && opts.url.startsWith(new URL(base).origin) ? opts.url.slice(new URL(base).origin.length) || "/" : opts.url;
  const id = replacing?.id ?? uniqueId(slug(opts.title), new Set(existing.map((s) => s.id)));

  const screen: ScreenEntry = {
    id,
    title: replacing?.title ?? opts.title,
    group: replacing?.group ?? "Captured",
    url,
    live: true,
  };
  const cap = await opts.capture(screen, store.roundDir(n));
  screen.viewport = { width: cap.device.width, height: cap.device.height, deviceScaleFactor: cap.device.scale };
  await store.writeCapture(n, cap);
  await store.upsertScreen({ ...(replacing ?? {}), ...screen });

  const cur = await store.readStatus(n);
  const entry = { screenId: id, ok: true, reason: "captured from the app tab" };
  const screens = (cur.screens ?? []).filter((s) => s.screenId !== id);
  await store.writeStatus(n, { ...cur, status: "open", updatedAt: new Date().toISOString(), screens: [...screens, entry] });
  return { round: n, screenId: id, title: screen.title };
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "view";

function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}
