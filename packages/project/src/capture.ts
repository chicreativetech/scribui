import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createAdapter, CaptureError } from "@scribui/capture";
import { planCapture, ReviewJson, type CapturePlan, type Platform, type PreviousRound, type StatusFile } from "@scribui/core";
import type { ReviewStore } from "@scribui/server";
import { changedFilesSince, screenFingerprint } from "./changes.js";

export type CaptureOptions = {
  platform?: Platform;
  device?: string;
  /** Capture exactly these screens; the rest are copied forward. */
  screens?: string[];
  /** Recapture every screen. */
  all?: boolean;
  /** Only plan: report what would be captured, change nothing. */
  dryRun?: boolean;
  /** Recapture into this open round instead of creating a new one (canvas "recapture"). */
  intoRound?: number;
  log?: (event: CaptureEvent) => void;
};

export type CaptureEvent =
  | { type: "check-failed"; problems: string[] }
  | { type: "plan"; plan: CapturePlan; previous: number | null }
  | { type: "round"; round: number; reused: boolean }
  | { type: "screen-start"; screenId: string; index: number; total: number; reason: string }
  | { type: "screen-done"; screenId: string; ms: number; elements: number }
  | { type: "screen-failed"; screenId: string; error: string; detail?: string };

export type CaptureResult = {
  round: number;
  ok: string[];
  failed: { screenId: string; error: string }[];
  reused: string[];
  plan: CapturePlan;
  /** Nothing changed: no round was created. */
  skipped?: boolean;
};

const pad = (n: number) => String(n).padStart(3, "0");

/**
 * Capture a round. By default only screens that may have changed since the
 * previous round are captured; the others are copied forward. A failing
 * screen is reported and skipped.
 */
export async function captureRound(store: ReviewStore, opts: CaptureOptions = {}): Promise<CaptureResult | null> {
  const log = opts.log ?? (() => {});
  const manifest = await store.readManifest();
  const platform = opts.platform ?? manifest.app.platform;
  const device = opts.device ?? manifest.app.device;
  // views captured by hand in the app tab can't be reproduced from their url: carried forward, never recaptured
  const screens = manifest.screens.filter((s) => !s.live);
  const live = manifest.screens.filter((s) => s.live);
  if (manifest.screens.length === 0) throw new Error("screens.json lists no screens");
  if (opts.screens?.length) {
    const unknown = opts.screens.filter((id) => !manifest.screens.some((s) => s.id === id));
    if (unknown.length) throw new Error(`unknown screen ids: ${unknown.join(", ")}`);
    const handmade = opts.screens.filter((id) => live.some((s) => s.id === id));
    if (handmade.length) throw new Error(`${handmade.join(", ")} came from the app tab: capture ${handmade.length === 1 ? "it" : "them"} again there`);
  }

  // which round we write into, and which round we compare against
  const latest = await store.latestRound();
  let target: number | null = null;
  let previousNo: number | null = latest;
  if (opts.intoRound !== undefined) {
    const st = await store.readStatus(opts.intoRound);
    if (st.status !== "open") throw new Error(`round ${opts.intoRound} is ${st.status}; only open rounds can be recaptured`);
    target = opts.intoRound;
    previousNo = opts.intoRound;
  } else if (latest !== null) {
    const st = await store.readStatus(latest).catch(() => null);
    const anns = await store.readAnnotations(latest).catch(() => []);
    // an open round nobody has annotated yet is refreshed in place
    if (st && (st.status === "open" || st.status === "capturing") && anns.length === 0) target = latest;
  }

  const previous = previousNo !== null ? await readPrevious(store, previousNo) : null;
  const fingerprints = new Map<string, string>();
  for (const s of screens) fingerprints.set(s.id, await screenFingerprint(store.dir, s));
  const since = previous ? Date.parse(previous.createdAt) : NaN;
  const changedFiles = previous && !Number.isNaN(since) ? await changedFilesSince(store.root, since) : null;

  const plan = planCapture({
    screens,
    sharedSources: manifest.app.sharedSources,
    previous: previous?.info ?? null,
    fingerprints,
    changedFiles,
    only: opts.screens,
    all: opts.all,
  });
  log({ type: "plan", plan, previous: previousNo });
  const toCapture = plan.items.filter((i) => i.action === "capture");

  if (screens.length === 0) {
    const why = "every screen came from the app tab: capture them again there";
    return { round: previousNo ?? 0, ok: [], failed: [], reused: live.map((s) => s.id), plan: { ...plan, why }, skipped: true };
  }
  if (opts.dryRun || (toCapture.length === 0 && opts.intoRound === undefined)) {
    return { round: previousNo ?? 0, ok: [], failed: [], reused: plan.items.map((i) => i.screenId), plan, skipped: true };
  }

  // pre-flight before writing anything
  const probe = createAdapter(platform, { reviewDir: store.dir, roundDir: store.dir, manifest, device });
  const check = await probe.check();
  await probe.dispose?.();
  if (!check.ok) {
    log({ type: "check-failed", problems: check.problems });
    return null;
  }

  const n = target ?? (await store.createRound());
  log({ type: "round", round: n, reused: target !== null });
  for (const sub of ["screens", "trees", "ink"]) await mkdir(join(store.roundDir(n), sub), { recursive: true });

  const prevStatus = new Map((previous?.info.screens ?? []).map((s) => [s.screenId, s]));
  const progress = new Map<string, NonNullable<StatusFile["screens"]>[number]>();
  const reused: string[] = [];

  // copy unchanged screens forward
  for (const item of plan.items) {
    if (item.action !== "reuse") continue;
    if (item.copyFrom !== undefined && item.copyFrom !== n) {
      const from = store.roundDir(item.copyFrom);
      const to = store.roundDir(n);
      await copyFile(join(from, "screens", `${item.screenId}.png`), join(to, "screens", `${item.screenId}.png`));
      await copyFile(join(from, "trees", `${item.screenId}.json`), join(to, "trees", `${item.screenId}.json`));
    }
    const p = prevStatus.get(item.screenId);
    progress.set(item.screenId, {
      screenId: item.screenId,
      ok: true,
      reason: item.reason,
      ...(item.copyFrom === n ? (p?.reusedFrom !== undefined ? { reusedFrom: p.reusedFrom } : {}) : { reusedFrom: item.reusedFrom }),
      ...(p?.fingerprint ? { fingerprint: p.fingerprint } : {}),
    });
    reused.push(item.screenId);
  }
  if (previousNo !== null) {
    for (const p of await carryForward(store, previousNo, n, live.map((s) => s.id))) progress.set(p.screenId, p);
  }
  const ordered = () => manifest.screens.map((s) => progress.get(s.id)).filter((x): x is NonNullable<typeof x> => !!x);
  const queueAfter = (i: number) => toCapture.slice(i).map((t) => t.screenId);
  await store.setStatus(n, "capturing", { screens: ordered(), progress: { total: toCapture.length, done: 0, queue: queueAfter(0) } });

  const adapter = createAdapter(platform, { reviewDir: store.dir, roundDir: store.roundDir(n), manifest, device });
  await adapter.check();
  const ok: string[] = [];
  const failed: { screenId: string; error: string }[] = [];
  const byId = new Map(screens.map((s) => [s.id, s]));

  try {
    for (const [i, item] of toCapture.entries()) {
      const screen = byId.get(item.screenId)!;
      log({ type: "screen-start", screenId: screen.id, index: i, total: toCapture.length, reason: item.reason });
      await store.setStatus(n, "capturing", {
        screens: ordered(),
        progress: { total: toCapture.length, done: i, current: screen.id, queue: queueAfter(i) },
      });
      const t0 = Date.now();
      const fingerprint = fingerprints.get(screen.id);
      try {
        await adapter.prepare(screen);
        const cap = await adapter.capture(screen);
        await store.writeCapture(n, cap);
        ok.push(screen.id);
        progress.set(screen.id, { screenId: screen.id, ok: true, reason: item.reason, ...(fingerprint ? { fingerprint } : {}) });
        log({ type: "screen-done", screenId: screen.id, ms: Date.now() - t0, elements: count(cap.root) });
      } catch (e) {
        const err = e as CaptureError;
        const msg = err.message ?? String(e);
        failed.push({ screenId: screen.id, error: msg });
        progress.set(screen.id, { screenId: screen.id, ok: false, error: msg, reason: item.reason });
        log({ type: "screen-failed", screenId: screen.id, error: msg, detail: err.detail });
      }
      await store.setStatus(n, "capturing", {
        screens: ordered(),
        progress: { total: toCapture.length, done: i + 1, queue: queueAfter(i + 1) },
      });
    }
  } finally {
    await adapter.dispose?.();
  }
  const final = await store.readStatus(n);
  delete final.progress;
  await store.writeStatus(n, { ...final, status: "open", updatedAt: new Date().toISOString(), screens: ordered() });
  return { round: n, ok, failed, reused, plan };
}

type ScreenStatus = NonNullable<StatusFile["screens"]>[number];

/**
 * Copy screens from round `from` into round `to` as reused, keeping where
 * they were first captured. Only screens whose files exist are carried.
 * Returns their status entries.
 */
export async function carryForward(store: ReviewStore, from: number, to: number, ids?: string[]): Promise<ScreenStatus[]> {
  const st = await store.readStatus(from).catch(() => null);
  const out: ScreenStatus[] = [];
  for (const p of st?.screens ?? []) {
    if (!p.ok || (ids && !ids.includes(p.screenId))) continue;
    const src = store.roundDir(from);
    const png = join(src, "screens", `${p.screenId}.png`);
    const tree = join(src, "trees", `${p.screenId}.json`);
    if (!existsSync(png) || !existsSync(tree)) continue;
    if (from !== to) {
      const dst = store.roundDir(to);
      await mkdir(join(dst, "screens"), { recursive: true });
      await mkdir(join(dst, "trees"), { recursive: true });
      await copyFile(png, join(dst, "screens", `${p.screenId}.png`));
      await copyFile(tree, join(dst, "trees", `${p.screenId}.json`));
    }
    const reusedFrom = from === to ? p.reusedFrom : (p.reusedFrom ?? from);
    out.push({
      screenId: p.screenId,
      ok: true,
      reason: from === to ? (p.reason ?? "kept") : `copied from R${pad(from)}`,
      ...(reusedFrom !== undefined ? { reusedFrom } : {}),
      ...(p.fingerprint ? { fingerprint: p.fingerprint } : {}),
    });
  }
  return out;
}

async function readPrevious(store: ReviewStore, n: number): Promise<{ info: PreviousRound; createdAt: string } | null> {
  const st = await store.readStatus(n).catch(() => null);
  if (!st) return null;
  const captured = new Set((await store.readCaptures(n)).keys());
  const info: PreviousRound = {
    round: n,
    status: st.status,
    // a screen only counts as reusable when its files are really there
    screens: (st.screens ?? []).map((s) => ({ ...s, ok: s.ok && captured.has(s.screenId) })),
    ...(st.changedScreens ? { changedScreens: st.changedScreens } : {}),
  };
  const reviewPath = join(store.roundDir(n), "review.json");
  if (existsSync(reviewPath)) {
    try {
      const review = ReviewJson.parse(JSON.parse(await readFile(reviewPath, "utf8")));
      info.reviewedScreens = [
        ...new Set(review.instructions.flatMap((i) => [i.screenId, ...(i.destinationScreenId ? [i.destinationScreenId] : [])])),
      ];
      info.newRules = review.counts.rules;
    } catch {
      /* unreadable review: rely on the other signals */
    }
  }
  return { info, createdAt: st.createdAt };
}

export function describePlan(plan: CapturePlan, previous: number | null): string {
  const n = plan.items.filter((i) => i.action === "capture").length;
  if (plan.full) return `capturing all ${n} screens (${plan.why})`;
  if (n === 0) return plan.why;
  return `capturing ${n} of ${plan.items.length} screens; reusing the rest from R${pad(previous ?? 0)}`;
}

function count(e: { children: unknown[] }): number {
  let n = 1;
  for (const c of e.children as { children: unknown[] }[]) n += count(c);
  return n;
}
