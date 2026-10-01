import { DEFAULT_CONFIG } from "./config.js";
import { area, formatRect, intersect, isClosedPath } from "./geometry.js";
import { numberAnnotations } from "./numbering.js";
import { indexFor } from "./resolver.js";
import type {
  Annotation,
  Instruction,
  Rect,
  ReviewJson,
  RuleEntry,
  ScreenCapture,
  TargetRef,
  UIElement,
} from "./schemas.js";
import { isRealId, TreeIndex } from "./tree.js";

export type CompileInput = {
  round: number;
  appName: string;
  /** YYYY-MM-DD, used for rules.md entries. Passed in so output stays deterministic. */
  date: string;
  /** Screens in manifest order. */
  screens: { id: string; title: string }[];
  captures: Map<string, Pick<ScreenCapture, "screenId" | "root">>;
  /** Resolved annotations (run `resolveAll` first). */
  annotations: Annotation[];
};

export type CompileOutput = {
  review: ReviewJson;
  markdown: string;
  /** Text to append to rules.md ("" when there are no new rules). */
  rulesMarkdown: string;
  markers: Map<string, number>;
  /** Rule annotation id → rule number (U1, U2, …). */
  ruleNumbers: Map<string, number>;
  /** Handwritten comments that need an ink crop: annotation id → path relative to the round folder. */
  inkFiles: Map<string, string>;
};

/* ─────────────────────────── phrasing ─────────────────────────── */

const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const quote = (s: string) => `"${clip(s.replace(/\s+/g, " ").trim())}"`;

export function toTargetRef(el: UIElement): TargetRef {
  const t: TargetRef = { elementId: el.id, type: el.type, bounds: el.bounds };
  if (el.label) t.label = el.label;
  if (el.source) t.source = el.source;
  return t;
}

/** `"Pay now" button (id: payButton)`; generated ids become a description plus bounds. */
export function phraseTarget(t: TargetRef, idSource: UIElement["idSource"] = "dom"): string {
  const name = t.label ? `${quote(t.label)} ${t.type}` : t.type;
  let s: string;
  if (idSource === "generated") {
    s = `${name} at ${formatRect(t.bounds)}`;
  } else {
    const dup = /^(.*)#(\d+)$/.exec(t.elementId);
    s = dup ? `${name} (id: ${dup[1]}, occurrence ${dup[2]})` : `${name} (id: ${t.elementId})`;
  }
  if (t.source) {
    const loc = t.source.line ? `${t.source.file}:${t.source.line}` : t.source.file;
    s += t.source.component ? ` in ${t.source.component}, ${loc}` : ` in ${loc}`;
  }
  return s;
}

const joinList = (parts: string[]): string =>
  parts.length <= 1
    ? (parts[0] ?? "")
    : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const sentence = (s: string) => {
  const t = s.trim();
  if (!t) return "";
  return /[.!?…:)"]$/.test(t) ? t : `${t}.`;
};

/* ─────────────────────────── compile ─────────────────────────── */

type Ctx = {
  input: CompileInput;
  indexes: Map<string, TreeIndex>;
  titles: Map<string, string>;
  markers: Map<string, number>;
  inkFiles: Map<string, string>;
};

export function compile(input: CompileInput): CompileOutput {
  const screenOrder = input.screens.map((s) => s.id);
  const { markers, rules: ruleNumbers } = numberAnnotations(input.annotations, screenOrder);
  const indexes = new Map<string, TreeIndex>();
  for (const [id, cap] of input.captures) indexes.set(id, indexFor(cap.root));
  const ctx: Ctx = {
    input,
    indexes,
    titles: new Map(input.screens.map((s) => [s.id, s.title])),
    markers,
    inkFiles: new Map(),
  };

  const byId = new Map(input.annotations.map((a) => [a.id, a]));
  const attached = new Map<string, Annotation[]>();
  for (const a of input.annotations) {
    if (a.kind === "comment" && a.attachedTo && byId.has(a.attachedTo)) {
      const list = attached.get(a.attachedTo) ?? [];
      list.push(a);
      attached.set(a.attachedTo, list);
    }
  }

  const roots = input.annotations
    .filter((a) => markers.has(a.id) && !(a.kind === "comment" && a.attachedTo && byId.has(a.attachedTo)))
    .sort((a, b) => markers.get(a.id)! - markers.get(b.id)!);

  const instructions = roots.map((a) => buildInstruction(ctx, a, attached.get(a.id) ?? []));

  const rules: RuleEntry[] = input.annotations
    .filter((a) => a.kind === "rule" && ruleNumbers.has(a.id))
    .sort((a, b) => ruleNumbers.get(a.id)! - ruleNumbers.get(b.id)!)
    .map((a) => buildRule(ctx, a, ruleNumbers.get(a.id)!));

  const review: ReviewJson = {
    version: 1,
    round: input.round,
    app: input.appName,
    instructions,
    rules,
    counts: {
      instructions: instructions.length,
      unresolved: instructions.filter((i) => i.status === "unresolved").length,
      needsText: instructions.filter((i) => i.needsText).length,
      rules: rules.length,
    },
  };

  return {
    review,
    markdown: renderMarkdown(ctx, review),
    rulesMarkdown: renderRules(ctx, rules),
    markers,
    ruleNumbers,
    inkFiles: ctx.inkFiles,
  };
}

function lookup(ctx: Ctx, screenId: string, elementId: string): UIElement | undefined {
  return ctx.indexes.get(screenId)?.get(elementId);
}

function refsFor(ctx: Ctx, screenId: string, ids: string[]): { refs: TargetRef[]; phrases: string[] } {
  const refs: TargetRef[] = [];
  const phrases: string[] = [];
  for (const id of ids) {
    const el = lookup(ctx, screenId, id);
    if (!el) continue;
    const r = toTargetRef(el);
    refs.push(r);
    phrases.push(phraseTarget(r, el.idSource));
  }
  return { refs, phrases };
}

function buildInstruction(ctx: Ctx, a: Annotation, comments: Annotation[]): Instruction {
  const { round } = ctx.input;
  const n = ctx.markers.get(a.id)!;
  const id = `R${round}-${n}`;
  const res = a.resolution ?? { status: "unresolved" as const, elements: [], confirmedByUser: false };

  // typed text, verbatim, and handwritten crops
  const texts = [a.text, ...comments.map((c) => c.text)].map((t) => t?.trim()).filter(Boolean) as string[];
  const inks: string[] = [];
  for (const c of [a, ...comments]) {
    if (c.ink?.handwriting && c.kind === "comment") {
      const p = `ink/${c.id}.png`;
      ctx.inkFiles.set(c.id, p);
      inks.push(p);
    }
  }
  const text = texts.join(" ");
  const inkNote = inks.length ? `See handwritten note${inks.length > 1 ? "s" : ""} ${inks.join(", ")}.` : "";
  const comment = [sentence(text), inkNote].filter(Boolean).join(" ");
  /** The comment when it starts a new sentence. */
  const Comment = cap(comment);
  const hasComment = comment.length > 0;

  const { refs, phrases } = refsFor(ctx, a.screenId, res.elements);
  const target = joinList(phrases.map((p) => `the ${p}`));
  const bare = joinList(phrases);
  const base = {
    id,
    screenId: a.screenId,
    targets: refs,
    text,
    annotationIds: [a.id, ...comments.map((c) => c.id)],
    marker: n,
  };
  const withInk = (i: Instruction): Instruction => (inks.length ? { ...i, ink: inks } : i);

  const unresolvedInstr = (action: Instruction["action"]): Instruction =>
    withInk({
      ...base,
      targets: refs,
      action,
      instruction: `[UNRESOLVED] ${Comment.replace(/\.$/, "") || "No comment given"} (see annotated screenshot, marker ${n}); ask the user.`,
      status: "unresolved",
    });

  const done = (action: Instruction["action"], instruction: string, extra: Partial<Instruction> = {}) =>
    withInk({ ...base, action, instruction: instruction.replace(/\s+/g, " ").trim(), status: "resolved", ...extra });

  const needsText = (action: Instruction["action"]) =>
    done(action, `Review ${target}; see marker ${n}.`, { needsText: true });

  const kindAction: Record<Annotation["kind"], Instruction["action"]> = {
    remove: "remove",
    circle: "change",
    comment: "change",
    arrow: "move",
    rectangle: "add",
    freehand: "note",
    rule: "note",
  };

  if (res.status === "unresolved") return unresolvedInstr(kindAction[a.kind]);

  switch (a.kind) {
    case "remove":
      if (!refs.length) return unresolvedInstr("remove");
      return done("remove", `Remove ${target}. ${Comment}`);

    case "comment": {
      if (res.status === "region" && res.region) {
        return done("note", `In the empty area at ${formatRect(res.region)}: ${comment || "see marker " + n + "."}`, {
          destination: { region: res.region },
        });
      }
      if (!refs.length) return unresolvedInstr("change");
      if (!text && inks.length) return done("change", `Handwritten note on ${target}, see ${inks.join(", ")}.`);
      return done("change", `${cap(bare)}: ${comment}`);
    }

    case "circle":
    case "rectangle":
    case "freehand": {
      if (res.status === "region" && res.region) {
        const neighbours = describeNeighbours(ctx, a.screenId, res.region);
        const what = text ? text.replace(/[.\s]+$/, "") : "the element sketched at marker " + n;
        const instr = `Add ${what} in the empty area at ${formatRect(res.region)}${neighbours}. ${inkNote}`;
        return done("add", instr, {
          destination: { region: res.region },
          ...(hasComment ? {} : { needsText: true }),
        });
      }
      if (!refs.length) return unresolvedInstr(kindAction[a.kind]);
      // a closed freehand loop is a circle; an open one is a note
      const loop = a.kind === "freehand" && a.geometry.type === "path" && isClosedPath(a.geometry.points, DEFAULT_CONFIG.closedLoop);
      const isNote = a.kind === "freehand" && !loop;
      if (!hasComment) return needsText(isNote ? "note" : "change");
      if (isNote) return done("note", `Note on ${target}: ${comment}`);
      if (!text && inks.length) return done("change", `Handwritten note on ${target}, see ${inks.join(", ")}.`);
      return done("change", `${cap(bare)}: ${comment}`);
    }

    case "arrow": {
      if (!refs.length) return unresolvedInstr("move");
      const g = a.geometry;
      const toScreen = g.type === "arrow" ? g.toScreenId : undefined;
      if (toScreen && toScreen !== a.screenId) {
        const toIds = res.toElements ?? [];
        const dest = toIds.length ? lookup(ctx, toScreen, toIds[0]!) : undefined;
        const from = screenName(ctx, a.screenId);
        const to = screenName(ctx, toScreen);
        return done("relate", `Flow: ${from} leads to ${to} via ${target}. ${Comment}`, {
          destinationScreenId: toScreen,
          ...(dest ? { destination: toTargetRef(dest) } : {}),
        });
      }
      if (res.toElements?.length) {
        const dest = lookup(ctx, a.screenId, res.toElements[0]!);
        if (dest) {
          const ref = toTargetRef(dest);
          return done("move", `Move ${target} next to the ${phraseTarget(ref, dest.idSource)}. ${Comment}`, {
            destination: ref,
          });
        }
      }
      if (res.region) {
        return done("move", `Move ${target} to the area at ${formatRect(res.region)}. ${Comment}`, {
          destination: { region: res.region },
        });
      }
      return unresolvedInstr("move");
    }

    case "rule":
      return unresolvedInstr("note");
  }
}

function screenName(ctx: Ctx, id: string): string {
  const title = ctx.titles.get(id);
  return title ? `${title} (${id})` : id;
}

/** ", between X and Y" for an empty region, using the nearest meaningful elements above and below. */
function describeNeighbours(ctx: Ctx, screenId: string, region: Rect): string {
  const idx = ctx.indexes.get(screenId);
  if (!idx) return "";
  const meaningful = idx.all
    .map((f) => f.el)
    .filter(
      (el) =>
        !idx.isHuge(el, 0.5) &&
        (el.label || isRealId(el)) &&
        !(intersect(el.bounds, region) && area(intersect(el.bounds, region)!) > 0.2 * area(el.bounds)),
    );
  const overlapsX = (el: UIElement) => el.bounds.x < region.x + region.w && el.bounds.x + el.bounds.w > region.x;
  const pick = (list: UIElement[], key: (el: UIElement) => number) =>
    list.sort((a, b) => key(a) - key(b) || area(a.bounds) - area(b.bounds))[0];

  const above = pick(
    meaningful.filter((el) => overlapsX(el) && el.bounds.y + el.bounds.h <= region.y + 4),
    (el) => region.y - (el.bounds.y + el.bounds.h),
  );
  const below = pick(
    meaningful.filter((el) => overlapsX(el) && el.bounds.y >= region.y + region.h - 4),
    (el) => el.bounds.y - (region.y + region.h),
  );
  const p = (el: UIElement) => `the ${phraseTarget(toTargetRef(el), el.idSource)}`;
  if (above && below) return `, between ${p(above)} and ${p(below)}`;
  if (above) return `, below ${p(above)}`;
  if (below) return `, above ${p(below)}`;
  return "";
}

function buildRule(ctx: Ctx, a: Annotation, n: number): RuleEntry {
  const examples: RuleEntry["examples"] = [];
  for (const t of a.resolution?.elements ?? a.targets ?? []) {
    const [screenId, elementId] = t.includes("#") && ctx.indexes.has(t.split("#")[0]!)
      ? [t.slice(0, t.indexOf("#")), t.slice(t.indexOf("#") + 1)]
      : [a.screenId, t];
    const el = lookup(ctx, screenId, elementId);
    if (el) examples.push({ screenId, target: toTargetRef(el) });
  }
  return { id: `R${ctx.input.round}-U${n}`, text: (a.text ?? "").trim(), examples, annotationId: a.id };
}

/* ─────────────────────────── markdown ─────────────────────────── */

function renderMarkdown(ctx: Ctx, review: ReviewJson): string {
  const L: string[] = [];
  L.push(`# Design review, round ${review.round}`, "");
  L.push(`New rules added to rules.md: ${review.counts.rules}. Unresolved: ${review.counts.unresolved}.`, "");
  L.push(
    `App: ${review.app}. Implement every instruction below, in order. Ids are accessibility identifiers, testIDs or DOM ids you can search the code for; bounds are screenshot pixels. Instructions marked [UNRESOLVED] need a question to the user first.`,
    "",
  );

  if (review.rules.length) {
    L.push("## New rules", "");
    for (const r of review.rules) L.push(`- [${r.id}] ${sentence(r.text)} (see rules.md)`);
    L.push("");
  }

  const byScreen = new Map<string, Instruction[]>();
  for (const i of review.instructions) {
    const list = byScreen.get(i.screenId) ?? [];
    list.push(i);
    byScreen.set(i.screenId, list);
  }
  const order = [...ctx.input.screens.map((s) => s.id), ...[...byScreen.keys()].sort()];
  const seen = new Set<string>();
  for (const sid of order) {
    if (seen.has(sid) || !byScreen.has(sid)) continue;
    seen.add(sid);
    L.push(`## ${ctx.titles.get(sid) ?? sid} (${sid})`);
    L.push(`Screenshot: screens/${sid}.annotated.png`, "");
    for (const i of byScreen.get(sid)!) {
      L.push(`${i.marker}. [${i.id}] ${i.instruction}`);
      for (const ink of i.ink ?? []) L.push(`   ![handwritten note ${i.id}](${ink})`);
    }
    L.push("");
  }
  if (review.instructions.length === 0) L.push("No instructions in this round.", "");
  L.push(
    'When done, set `"status": "applied"` in `.intentcue/latest/status.json` and add `"changedScreens"`: the ids of every screen whose UI you changed, or `"all"` if you changed shared styles or components. intentcue then recaptures those screens.',
    "",
  );
  return L.join("\n");
}

function renderRules(ctx: Ctx, rules: RuleEntry[]): string {
  if (!rules.length) return "";
  const L: string[] = [];
  for (const r of rules) {
    L.push(`- ${sentence(r.text)}`);
    L.push(`  <!-- ${r.id}, added ${ctx.input.date} -->`);
    for (const e of r.examples) {
      const el = lookup(ctx, e.screenId, e.target.elementId);
      L.push(`  - Example: ${phraseTarget(e.target, el?.idSource)} on ${e.screenId}`);
    }
  }
  return L.join("\n") + "\n";
}
