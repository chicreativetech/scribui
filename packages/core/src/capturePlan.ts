import type { RoundState, ScreenEntry } from "./schemas.js";

/**
 * Incremental capture: decide which screens to recapture and which to copy
 * forward from the previous round. Pure; the CLI gathers the inputs.
 *
 * A screen is recaptured when any signal says it may have changed. When a
 * change can't be attributed to particular screens, everything is recaptured:
 * reviewing a stale screenshot is worse than a slower capture.
 */

export type PreviousRound = {
  round: number;
  status: RoundState;
  screens: { screenId: string; ok: boolean; fingerprint?: string; reusedFrom?: number }[];
  /** Reported by the agent when it marked the round applied. */
  changedScreens?: string[] | "all";
  /** Screens that had instructions in the round's review (including flow destinations). */
  reviewedScreens?: string[];
  /** Rules added by the round's review; rules apply everywhere. */
  newRules?: number;
};

export type PlanInput = {
  screens: ScreenEntry[];
  sharedSources?: string[];
  previous: PreviousRound | null;
  /** Current fingerprint of each screen's manifest entry and flow file. */
  fingerprints: Map<string, string>;
  /** Project files modified since the previous round, relative and with "/" separators; null when unknown. */
  changedFiles: string[] | null;
  /** --screens: capture exactly these, reuse the rest. */
  only?: string[];
  /** --all */
  all?: boolean;
};

export type PlanItem = {
  screenId: string;
  action: "capture" | "reuse";
  reason: string;
  /** For reused screens: the round whose capture is copied. */
  reusedFrom?: number;
  /** For reused screens: the round the files are copied from (the previous round). */
  copyFrom?: number;
};

export type CapturePlan = { items: PlanItem[]; full: boolean; why: string };

/** Paths that never decide what to recapture. */
export const IGNORED_CHANGES = [
  ".scribui/**",
  "AGENTS.md",
  "CLAUDE.md",
  "**/*.md",
  "docs/**",
  "**/test/**",
  "**/tests/**",
  "**/androidTest/**",
  "**/__tests__/**",
  "**/*.test.*",
  "**/*.spec.*",
  "**/*Test.kt",
  "**/*Tests.swift",
];

export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export const matchesAny = (path: string, globs: readonly string[] | undefined): boolean =>
  !!globs?.some((g) => globToRegExp(g.replace(/^\.\//, "")).test(path));

export function planCapture(input: PlanInput): CapturePlan {
  const { screens, previous } = input;
  const captureAll = (why: string): CapturePlan => ({
    items: screens.map((s) => ({ screenId: s.id, action: "capture", reason: why })),
    full: true,
    why,
  });

  if (input.all) return captureAll("--all");
  if (!previous) return captureAll("first round");

  const prev = new Map(previous.screens.map((s) => [s.screenId, s]));
  const reuse = (id: string, reason: string): PlanItem => {
    const p = prev.get(id)!;
    return { screenId: id, action: "reuse", reason, reusedFrom: p.reusedFrom ?? previous.round, copyFrom: previous.round };
  };
  const canReuse = (id: string) => prev.get(id)?.ok === true;

  if (input.only?.length) {
    const want = new Set(input.only);
    return {
      items: screens.map((s) =>
        want.has(s.id)
          ? { screenId: s.id, action: "capture", reason: "requested" }
          : canReuse(s.id)
            ? reuse(s.id, "not requested")
            : { screenId: s.id, action: "capture", reason: "not captured before" },
      ),
      full: false,
      why: "--screens",
    };
  }

  // changes that touch every screen
  if (previous.changedScreens === "all") return captureAll(`agent reported a shared change in R${pad(previous.round)}`);
  if (previous.newRules) return captureAll(`R${pad(previous.round)} added design rules`);

  const changed = (input.changedFiles ?? []).filter((f) => !matchesAny(f, IGNORED_CHANGES));
  const shared = changed.find((f) => matchesAny(f, input.sharedSources));
  if (shared) return captureAll(`shared code changed: ${shared}`);

  const mapped = screens.some((s) => s.sources?.length);
  if (mapped) {
    const unmapped = changed.find((f) => !screens.some((s) => matchesAny(f, s.sources)));
    if (unmapped) return captureAll(`changed file not mapped to a screen: ${unmapped}`);
  }

  const agent = new Set(Array.isArray(previous.changedScreens) ? previous.changedScreens : []);
  const reviewed = new Set(previous.reviewedScreens ?? []);

  const items = screens.map((s): PlanItem => {
    const p = prev.get(s.id);
    const capture = (reason: string): PlanItem => ({ screenId: s.id, action: "capture", reason });
    if (!p) return capture("new screen");
    if (!p.ok) return capture("failed last time");
    const fp = input.fingerprints.get(s.id);
    if (p.fingerprint && fp && p.fingerprint !== fp) return capture("flow or screens.json entry changed");
    if (agent.has(s.id)) return capture(`agent changed it in R${pad(previous.round)}`);
    if (reviewed.has(s.id)) return capture(`had instructions in R${pad(previous.round)}`);
    const file = changed.find((f) => matchesAny(f, s.sources));
    if (file) return capture(`source changed: ${file}`);
    return reuse(s.id, "unchanged");
  });

  // screens that load the same page (same URL path, e.g. /checkout and /checkout?error=card)
  // change together: recapture the siblings of every recaptured screen
  const pageOf = (e: ScreenEntry) => (e.url ? e.url.replace(/[?#].*$/, "").replace(/\/+$/, "") || "/" : null);
  const byId = new Map(screens.map((e) => [e.id, e]));
  const capturedPages = new Map<string, string>();
  for (const it of items) {
    const page = it.action === "capture" ? pageOf(byId.get(it.screenId)!) : null;
    if (page !== null && !capturedPages.has(page)) capturedPages.set(page, it.screenId);
  }
  for (const [i, it] of items.entries()) {
    if (it.action !== "reuse") continue;
    const page = pageOf(byId.get(it.screenId)!);
    const sibling = page !== null ? capturedPages.get(page) : undefined;
    if (sibling) items[i] = { screenId: it.screenId, action: "capture", reason: `same page as ${sibling}` };
  }

  // files changed but nothing ties them to a screen: be safe
  const anySignal = agent.size > 0 || reviewed.size > 0 || mapped;
  if (changed.length > 0 && !anySignal) {
    return captureAll(`${changed.length} file${changed.length === 1 ? "" : "s"} changed; can't tell which screens`);
  }

  const n = items.filter((i) => i.action === "capture").length;
  return { items, full: n === screens.length, why: n === 0 ? `nothing changed since R${pad(previous.round)}` : "incremental" };
}

const pad = (n: number) => String(n).padStart(3, "0");
