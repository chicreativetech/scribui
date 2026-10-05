import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  compile,
  DEFAULT_CONFIG,
  indexFor,
  renderAnnotatedScreenSvg,
  renderInkSvg,
  resolveAll,
  type Annotation,
  type CompileOutput,
  type ScreenCapture,
  type UIElement,
} from "@scribui/core";
import { ReviewStore, RoundLockedError, writeJson } from "./store.js";

export type SendResult = {
  round: number;
  prompt: string;
  counts: CompileOutput["review"]["counts"];
};

type ResvgModule = { renderAsync(svg: string, opts?: object): Promise<{ asPng(): Uint8Array }> };
let resvg: ResvgModule | null = null;

/** Prefer one known Helvetica file: loading every system font costs ~0.5 s per render. */
const FONT_CANDIDATES = [
  "/System/Library/Fonts/Helvetica.ttc",
  "/System/Library/Fonts/HelveticaNeue.ttc",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
  "/usr/share/fonts/liberation-sans/LiberationSans-Bold.ttf",
  "C:\\Windows\\Fonts\\arialbd.ttf",
];
const fontFile = FONT_CANDIDATES.find((f) => existsSync(f));

export async function renderSvgToPng(svg: string, width?: number): Promise<Uint8Array> {
  resvg ??= (await import("@resvg/resvg-js")) as unknown as ResvgModule;
  const img = await resvg.renderAsync(svg, {
    font: fontFile
      ? { loadSystemFonts: false, fontFiles: [fontFile], defaultFontFamily: "Helvetica", sansSerifFamily: "Helvetica" }
      : { loadSystemFonts: true, defaultFontFamily: "Helvetica" },
    ...(width ? { fitTo: { mode: "width", value: width } } : {}),
  });
  return img.asPng();
}

export async function loadRoundInputs(store: ReviewStore, n: number) {
  const manifest = await store.readManifest();
  const captures = await store.readCaptures(n);
  const trees = new Map<string, UIElement>([...captures].map(([id, c]) => [id, c.root]));
  const annotations = await store.readAnnotations(n);
  return { manifest, captures, trees, annotations };
}

/** Re-run the resolver (confirmed resolutions are kept) and save. */
export async function resolveRound(store: ReviewStore, n: number): Promise<Annotation[]> {
  const { trees, annotations } = await loadRoundInputs(store, n);
  const resolved = resolveAll(annotations, trees, DEFAULT_CONFIG);
  await store.writeAnnotations(n, resolved);
  return resolved;
}

export function compileRound(
  n: number,
  inputs: Awaited<ReturnType<typeof loadRoundInputs>>,
  annotations: Annotation[],
  date = new Date().toISOString().slice(0, 10),
): CompileOutput {
  const { manifest, captures } = inputs;
  const known = new Set(manifest.screens.map((s) => s.id));
  const screens = [
    ...manifest.screens.map((s) => ({ id: s.id, title: s.title })),
    ...[...captures.keys()].filter((id) => !known.has(id)).map((id) => ({ id, title: id })),
  ];
  return compile({ round: n, appName: manifest.app.name, date, screens, captures, annotations });
}

/**
 * Send: resolve unconfirmed annotations, compile, write review.md / review.json /
 * annotated PNGs / ink crops, append rules, set status to `sent`.
 */
export async function sendRound(store: ReviewStore, n: number): Promise<SendResult> {
  const status = await store.readStatus(n);
  if (status.status === "sent" || status.status === "applied") throw new RoundLockedError(n, status.status);
  if (status.status === "capturing") throw new Error(`round ${n} is still capturing`);

  const inputs = await loadRoundInputs(store, n);
  const annotations = resolveAll(inputs.annotations, inputs.trees, DEFAULT_CONFIG);
  await store.writeAnnotations(n, annotations);
  const date = new Date().toISOString().slice(0, 10);
  const out = compileRound(n, inputs, annotations, date);
  const dir = store.roundDir(n);

  await writeFile(join(dir, "review.md"), out.markdown);
  await writeJson(join(dir, "review.json"), out.review);

  // annotated screenshots, for every screen that has annotations
  const titles = new Map(inputs.manifest.screens.map((s) => [s.id, s.title]));
  await Promise.all(
    [...inputs.captures]
      .filter(([screenId]) => annotations.some((a) => a.screenId === screenId))
      .map(async ([screenId, cap]) => {
        const list = annotations.filter((a) => a.screenId === screenId);
        const png = await renderAnnotated(store, n, cap, list, out.markers, out.ruleNumbers, (id) => titles.get(id));
        await writeFile(join(dir, "screens", `${screenId}.annotated.png`), png);
      }),
  );

  // handwriting crops
  for (const [id, rel] of out.inkFiles) {
    const a = annotations.find((x) => x.id === id);
    if (!a?.ink) continue;
    const scale = inputs.captures.get(a.screenId)?.device.scale ?? 1;
    const { svg } = renderInkSvg(a.ink, DEFAULT_CONFIG.inkPadding, scale / 2);
    await writeFile(join(dir, rel), await renderSvgToPng(svg));
  }

  await store.appendRules(out.rulesMarkdown, `Round ${n} · ${date}`);
  await store.setStatus(n, "sent");
  return {
    round: n,
    prompt: "Implement .scribui/latest/review.md",
    counts: out.review.counts,
  };
}

export async function renderAnnotated(
  store: ReviewStore,
  n: number,
  cap: ScreenCapture,
  annotations: Annotation[],
  markers: Map<string, number>,
  ruleNumbers: Map<string, number>,
  screenTitle: (id: string) => string | undefined,
): Promise<Uint8Array> {
  const png = await readFile(join(store.roundDir(n), cap.screenshot));
  const href = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
  const idx = indexFor(cap.root);
  const labels = new Map<string, string>();
  for (const a of annotations) {
    const m = markers.get(a.id);
    if (m !== undefined) labels.set(a.id, String(m));
  }
  for (const a of annotations) {
    const r = ruleNumbers.get(a.id);
    if (r !== undefined) labels.set(a.id, `U${r}`);
  }
  const width = Math.round(cap.root.bounds.w);
  const height = Math.round(cap.root.bounds.h);
  const svg = renderAnnotatedScreenSvg({
    width,
    height,
    href,
    annotations,
    labels,
    unit: Math.max(1, cap.device.scale),
    boundsFor: (id) => idx.get(id)?.bounds,
    screenTitle,
  });
  return renderSvgToPng(svg);
}
