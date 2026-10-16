import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pngSize, renderPage, toCapture, writePng } from "@scribui/capture";
import type { Imported, ScreenEntry } from "@scribui/core";
import type { PageRenderer, ReviewStore, ViewSaveRequest, ViewSaveResult } from "@scribui/server";
import { carryForward } from "./capture.js";

/**
 * Add one view captured by hand to the open round: a new round when the
 * latest one is already sent or applied (its screens carried forward), and an
 * entry in screens.json so the agent and later rounds know about it.
 *
 * Platform-neutral: the caller brings the PNG and the element tree. Web views
 * keep where the app was (relative to `app.baseUrl` when it is on it); mobile
 * views keep the device and orientation instead. Run it through the owner's
 * capture queue (`ServerOptions.saveView`), never directly from a second process.
 */
export async function saveCapturedView(store: ReviewStore, req: ViewSaveRequest): Promise<ViewSaveResult> {
  const manifest = await store.readManifest();
  if (!req.imported && manifest.app.platform !== req.platform) {
    throw new Error(`this project reviews a ${manifest.app.platform} app; a ${req.platform} view can't be added to it`);
  }
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
  const replacing = req.replace ? existing.find((s) => s.id === req.replace) : undefined;
  if (req.replace && !replacing) throw new Error(`no screen "${req.replace}"`);

  const imp = req.imported;
  // an import keeps where it came from in `imported`, never in `url`: it is not recaptured
  const url = !imp && req.platform === "web" && req.url ? relativeToBase(req.url, manifest.app.baseUrl) : undefined;
  const title = req.title?.trim() || (imp ? IMPORT_TITLES[imp.role] : (url ?? `${req.device.name} view`));
  const id = replacing?.id ?? uniqueId(slug(title), new Set(existing.map((s) => s.id)));

  let imported = imp;
  if (imp?.kind === "html") {
    if (!req.html) throw new Error("an HTML import needs its markup");
    const source = `imports/${id}.html`;
    await mkdir(store.path("imports"), { recursive: true });
    await writeFile(store.path(source), req.html);
    imported = { ...imp, source };
  }

  const screen: ScreenEntry = {
    id,
    title: replacing?.title ?? title,
    group: replacing?.group ?? (imp ? IMPORT_GROUPS[imp.role] : "Captured"),
    live: true,
    ...(url ? { url } : {}),
    ...(!imp && req.platform !== "web" ? { device: req.device.name, ...(req.orientation ? { orientation: req.orientation } : {}) } : {}),
    ...(req.signature ? { pageSignature: req.signature } : {}),
    ...(imported ? { imported } : {}),
  };

  const rel = `screens/${id}.png`;
  await writePng(join(store.roundDir(n), rel), req.png);
  const cap = toCapture(screen, req.platform, req.device, rel, req.raw, pngSize(req.png));
  // a whole page: recaptured whole, in a window as tall as the one it was marked in
  screen.viewport = req.fullPage
    ? { width: cap.device.width, height: Math.round(req.viewportHeight ?? cap.device.height), deviceScaleFactor: cap.device.scale, fullPage: true }
    : { width: cap.device.width, height: cap.device.height, deviceScaleFactor: cap.device.scale };
  await store.writeCapture(n, cap);
  await store.upsertScreen({ ...(replacing ?? {}), ...screen });

  const cur = await store.readStatus(n);
  const reason = imp
    ? importReason(imp)
    : req.platform === "web"
      ? req.fullPage
        ? "marked up in the app tab"
        : "captured from the app tab"
      : req.noElements
        ? "captured from the device view while the screen never stopped changing; it has no elements, so notes on it are regions"
        : req.unsettled
          ? "captured from the device view while the screen was still changing; element positions may be off"
          : "captured from the device view";
  const entry = { screenId: id, ok: true, reason };
  const screens = (cur.screens ?? []).filter((s) => s.screenId !== id);
  await store.writeStatus(n, { ...cur, status: "open", updatedAt: new Date().toISOString(), screens: [...screens, entry] });
  return { round: n, screenId: id, title: screen.title };
}

/** Renders HTML and pages from any URL for imports, with the project's Playwright (or ScribUI's shared one). */
export const pageRenderer =
  (store: ReviewStore): PageRenderer =>
  (src, width) =>
    renderPage(store.root, src, width);

const IMPORT_TITLES = { app: "Screenshot", reference: "Reference" } as const;
const IMPORT_GROUPS = { app: "Added by hand", reference: "References" } as const;

function importReason(imp: Imported): string {
  const what = imp.kind === "image" ? "a still image" : imp.kind === "html" ? "HTML" : `a page from ${imp.source ?? "a URL"}`;
  const role = imp.role === "reference" ? "as a reference" : "as a screen of this app";
  return `added by hand in the review view: ${what}, ${role}${imp.kind === "image" ? "; it has no elements, so notes on it are regions" : ""}`;
}

/** A URL on the app's own origin is kept as a path, like hand-written screens. */
function relativeToBase(url: string, base: string | undefined): string {
  if (!base) return url;
  const origin = new URL(base).origin;
  return url.startsWith(origin) ? url.slice(origin.length) || "/" : url;
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
