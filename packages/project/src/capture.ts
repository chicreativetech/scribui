import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createAdapter, CaptureError } from "@scribui/capture";
import { BY_HAND, capturedByHand, planCapture, recapturable, ReviewJson, type CapturePlan, type Platform, type PreviousRound, type StatusFile } from "@scribui/core";
import type { ReviewStore } from "@scribui/server";
import { changedFilesSince, screenFingerprint } from "./changes.js";

export type CaptureOptions = {
  platform?: Platform;
  device?: string;
  /** Capture exactly these screens. */
  screens?: string[];
  /** Recapture every screen. */
  all?: boolean;
  /** Only plan: report what would be captured, change nothing. */
  dryRun?: boolean;
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
 * previous round are captured, and the round holds just those: earlier rounds
 * keep the rest as they were. A failing screen is reported and skipped.
 */
export async function captureRound(store: ReviewStore, opts: CaptureOptions = {}): Promise<CaptureResult | null> {
  const log = opts.log ?? (() => {});
  const manifest = await store.readManifest();
  const platform = opts.platform ?? manifest.app.platform;
  // Android and iOS: every screen is captured by hand in the desktop app
  if (capturedByHand(platform)) throw new Error(BY_HAND);
  const device = opts.device ?? manifest.app.device;
  // only screens with a url (or a setup script) can be captured here; the rest are added by hand
  const screens = manifest.screens.filter(recapturable);
  const live = manifest.screens.filter((s) => !recapturable(s));
  if (manifest.screens.length === 0) throw new Error("screens.json lists no screens");
  if (opts.screens?.length) {
    const unknown = opts.screens.filter((id) => !manifest.screens.some((s) => s.id === id));
    if (unknown.length) throw new Error(`unknown screen ids: ${unknown.join(", ")}`);
    const imported = opts.screens.filter((id) => live.some((s) => s.id === id && s.imported));
    if (imported.length) throw new Error(`${imported.join(", ")} ${imported.length === 1 ? "was" : "were"} added by hand in the review view and ${imported.length === 1 ? "is" : "are"} kept as ${imported.length === 1 ? "it is" : "they are"}: nothing to recapture`);
    const handmade = opts.screens.filter((id) => live.some((s) => s.id === id));
    if (handmade.length) throw new Error(`${handmade.join(", ")} ${handmade.length === 1 ? "was" : "were"} captured by hand without a url: add ${handmade.length === 1 ? "it" : "them"} again by hand`);
  }

  // which round we write into, and which round we compare against: an open round nobody
  // has annotated yet (the empty one started when the agent applied the last) is filled in
  // place, compared with the round before it while it has no screens
  const latest = await store.latestRound();
  let target: number | null = null;
  let previousNo: number | null = latest;
  if (latest !== null) {
    const st = await store.readStatus(latest).catch(() => null);
    const anns = await store.readAnnotations(latest).catch(() => []);
    if (st && (st.status === "open" || st.status === "capturing") && anns.length === 0) {
      target = latest;
      if (!st.screens?.length) previousNo = (await store.listRounds()).filter((r) => r < latest).pop() ?? null;
    }
  }
  const kept = target !== null ? ((await store.readStatus(target)).screens ?? []) : [];

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
    const why = live.every((s) => s.imported)
      ? "every screen was added by hand in the review view: nothing to recapture"
      : "every screen was captured by hand without a url: add them again by hand";
    return { round: previousNo ?? 0, ok: [], failed: [], reused: live.map((s) => s.id), plan: { ...plan, why }, skipped: true };
  }
  if (opts.dryRun || toCapture.length === 0) {
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

  // a round holds what was captured into it; unchanged screens stay in the rounds they were captured in
  const progress = new Map<string, NonNullable<StatusFile["screens"]>[number]>(kept.map((p) => [p.screenId, p]));
  const reused = plan.items.filter((i) => i.action === "reuse").map((i) => i.screenId);
  const ordered = () => [
    ...manifest.screens.map((s) => progress.get(s.id)).filter((x): x is NonNullable<typeof x> => !!x),
    ...[...progress.values()].filter((p) => !manifest.screens.some((s) => s.id === p.screenId)),
  ];
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
  return `capturing ${n} of ${plan.items.length} screens; the rest haven't changed since R${pad(previous ?? 0)}`;
}

function count(e: { children: unknown[] }): number {
  let n = 1;
  for (const c of e.children as { children: unknown[] }[]) n += count(c);
  return n;
}
