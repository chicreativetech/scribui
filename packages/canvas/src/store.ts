import { create } from "zustand";
import {
  compile,
  indexFor,
  numberAnnotations,
  resolveAll,
  type Annotation,
  type AnnotationKind,
  type CompileOutput,
  type ScreenCapture,
  type UIElement,
} from "@intentcue/core";
import { api, type CaptureState, type LanState, type ProjectPayload, type RoundListItem, type RoundPayload, type ScreenInfo } from "./api";
import { layoutBoard, type Camera, type GroupLayout, type TileLayout } from "./layout";

export type Tool = "select" | AnnotationKind;

export const TOOLS: { tool: Tool; key: string; label: string; hint: string }[] = [
  { tool: "select", key: "V", label: "select", hint: "click an element or annotation" },
  { tool: "comment", key: "C", label: "comment", hint: "click to pin, then type" },
  { tool: "circle", key: "O", label: "circle", hint: "drag a loop around something" },
  { tool: "arrow", key: "A", label: "arrow", hint: "drag start → end; may end on another tile" },
  { tool: "rectangle", key: "R", label: "rect", hint: "drag a box where something should go" },
  { tool: "remove", key: "X", label: "remove", hint: "click an element to strike it out" },
  { tool: "freehand", key: "P", label: "draw", hint: "draw a free path" },
  { tool: "rule", key: "U", label: "rule", hint: "shift-click elements on any screens, then ⏎ and type" },
];

export type HoverInfo = { screenId: string; stack: UIElement[]; level: number; px: [number, number] } | null;

export type EditorState = { annotationId: string; isNew: boolean } | null;
export type PickerState = { annotationId: string } | null;
export type Toast = { id: number; text: string; tone?: "ok" | "warn" | "err" | "info"; action?: { label: string; run: () => void } };

type History = { past: Annotation[][]; future: Annotation[][] };

type State = {
  project: ProjectPayload | null;
  rounds: RoundListItem[];
  round: RoundPayload | null;
  loading: boolean;
  error: string | null;
  captures: Map<string, ScreenCapture>;
  trees: Map<string, UIElement>;
  tiles: TileLayout[];
  groups: GroupLayout[];

  annotations: Annotation[];
  history: History;
  saveState: "saved" | "saving" | "error" | "idle";

  tool: Tool;
  camera: Camera;
  focusId: string | null;
  preFocusCamera: Camera | null;
  selectedId: string | null;
  selectedElement: { screenId: string; elementId: string } | null;
  ruleTargets: { screenId: string; elementId: string }[];
  hover: HoverInfo;
  showOutlines: boolean;
  flash: { screenId: string; ids: string[]; region?: { x: number; y: number; w: number; h: number }; until: number } | null;
  editor: EditorState;
  picker: PickerState;
  inspectorTab: "notes" | "review" | "tree" | "rules";
  inspectorOpen: boolean;
  helpOpen: boolean;
  sendOpen: boolean;
  sentPrompt: string | null;
  command: string | null;
  penMode: boolean;
  connected: boolean;
  capture: { round: number; screens: { screenId: string; ok: boolean; error?: string }[] } | null;
  toasts: Toast[];
  theme: "dark" | "light";
  cursorPx: { screenId: string; x: number; y: number } | null;
  /** Capture started from the canvas / by the agent (this server). */
  captureState: CaptureState;
  /** Capture running in another process (e.g. the agent ran `intentcue capture`), from status.json. */
  externalCapture: { round: number; total: number; done: number; current?: string; queue: string[] } | null;
  lan: LanState;
  lanOpen: boolean;
  /** The "applied" banner was dismissed for this round. */
  appliedDismissed: number | null;
  /** Web: the review board, or the running app embedded for capturing views by hand. */
  view: "board" | "live";
  /** Once opened, the app tab stays mounted so switching views keeps the app's state. */
  liveVisited: boolean;
  /** The tile whose remove button is asking for confirmation. */
  removeAsk: string | null;
};

type Actions = {
  load(round?: number): Promise<void>;
  refreshRounds(): Promise<void>;
  setTool(t: Tool): void;
  setCamera(c: Camera | ((c: Camera) => Camera)): void;
  commit(next: Annotation[], opts?: { select?: string | null }): void;
  add(a: Annotation, opts?: { edit?: boolean }): void;
  update(id: string, patch: Partial<Annotation> | ((a: Annotation) => Annotation)): void;
  remove(id: string): void;
  undo(): void;
  redo(): void;
  select(id: string | null): void;
  toast(t: Omit<Toast, "id">): void;
  dismissToast(id: number): void;
  set(p: Partial<State>): void;
  recapture(screenIds: string[]): Promise<void>;
  captureNext(opts?: { build?: boolean; all?: boolean }): Promise<void>;
  removeScreen(id: string): Promise<void>;
};

export type Store = State & Actions;

const readOnly = (r: RoundPayload | null) => !r || r.status.status === "sent" || r.status.status === "applied";

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let toastSeq = 0;

function loadTheme(): "dark" | "light" {
  try {
    return (localStorage.getItem("intentcue:theme") as "dark" | "light") || "dark";
  } catch {
    return "dark";
  }
}

export const useStore = create<Store>((set, get) => ({
  project: null,
  rounds: [],
  round: null,
  loading: true,
  error: null,
  captures: new Map(),
  trees: new Map(),
  tiles: [],
  groups: [],
  annotations: [],
  history: { past: [], future: [] },
  saveState: "idle",
  tool: "select",
  camera: { x: -80, y: -80, zoom: 0.5 },
  focusId: null,
  preFocusCamera: null,
  selectedId: null,
  selectedElement: null,
  ruleTargets: [],
  hover: null,
  showOutlines: false,
  flash: null,
  editor: null,
  picker: null,
  inspectorTab: "notes",
  // on tablets the panel overlays the board, so it starts closed there
  inspectorOpen: typeof window === "undefined" || window.innerWidth >= 1000,
  helpOpen: false,
  sendOpen: false,
  sentPrompt: null,
  command: null,
  penMode: false,
  connected: false,
  capture: null,
  toasts: [],
  theme: loadTheme(),
  cursorPx: null,
  captureState: { running: false, phase: "idle" },
  externalCapture: null,
  lan: { enabled: false, paired: 0 },
  lanOpen: false,
  appliedDismissed: null,
  view: "board",
  liveVisited: false,
  removeAsk: null,

  /** Recapture some screens into the current open round. */
  async recapture(ids) {
    const s = get();
    const round = s.round;
    if (!round || ids.length === 0) return;
    if (!round.canRecapture) {
      s.toast({ text: "capturing from the canvas needs intentcue started with `intentcue`", tone: "warn" });
      return;
    }
    if (readOnly(round)) return get().captureNext();
    try {
      set({ captureState: await api.recapture(round.round, ids) });
    } catch (e) {
      get().toast({ text: (e as Error).message, tone: "err" });
    }
  },

  /** Remove a screen (and the notes on it) from the open round. */
  async removeScreen(id) {
    const round = get().round;
    set({ removeAsk: null });
    if (!round || readOnly(round)) return;
    const title = round.screens.find((s) => s.id === id)?.title ?? id;
    try {
      const r = await api.removeScreen(round.round, id);
      if (get().focusId === id) set({ focusId: null, preFocusCamera: null });
      await get().load(round.round);
      get().toast({ text: `removed "${title}"${r.notes ? ` and ${r.notes} note${r.notes === 1 ? "" : "s"}` : ""}`, tone: "ok" });
    } catch (e) {
      get().toast({ text: (e as Error).message, tone: "err" });
    }
  },

  /** Capture the next round (only screens that changed), optionally rebuilding the app first. */
  async captureNext(opts = {}) {
    try {
      set({ captureState: await api.capture(opts) });
    } catch (e) {
      get().toast({ text: (e as Error).message, tone: "err" });
    }
  },

  async load(roundNo) {
    set({ loading: true, error: null });
    try {
      const project = await api.project();
      const rounds = await api.rounds();
      set({ captureState: project.capture ?? get().captureState, lan: project.lan ?? get().lan });
      const n = roundNo ?? project.latest;
      if (n === null || n === undefined) {
        set({ project, rounds, round: null, loading: false, tiles: [], groups: [], annotations: [] });
        return;
      }
      const round = await api.round(n);
      const caps = await Promise.all(
        round.screens.filter((s) => s.captured).map((s) => api.screen(n, s.id).catch(() => null)),
      );
      const captures = new Map<string, ScreenCapture>();
      for (const c of caps) if (c) captures.set(c.screenId, c);
      const trees = new Map([...captures].map(([id, c]) => [id, c.root] as const));
      const { tiles, groups } = layoutBoard(round.screens);
      const annotations = readOnly(round) ? round.annotations : resolveAll(round.annotations, trees);
      const same = get().round?.round === n;
      set({
        project,
        rounds,
        round,
        captures,
        trees,
        tiles,
        groups,
        annotations,
        loading: false,
        history: same ? get().history : { past: [], future: [] },
        selectedId: same ? get().selectedId : null,
        focusId: same ? get().focusId : null,
        editor: null,
        picker: null,
        saveState: "saved",
      });
    } catch (e) {
      set({ loading: false, error: (e as Error).message });
    }
  },

  async refreshRounds() {
    try {
      set({ rounds: await api.rounds() });
    } catch {
      /* offline */
    }
  },

  setTool(tool) {
    set({ tool, ruleTargets: tool === "rule" ? get().ruleTargets : [], picker: null });
  },

  setCamera(c) {
    set({ camera: typeof c === "function" ? c(get().camera) : c });
  },

  commit(next, opts) {
    const s = get();
    if (readOnly(s.round)) {
      get().toast({ text: `round ${s.round?.round} is ${s.round?.status.status}; read-only`, tone: "warn" });
      return;
    }
    const resolved = resolveAll(next, s.trees);
    set({
      annotations: resolved,
      history: { past: [...s.history.past.slice(-199), s.annotations], future: [] },
      ...(opts && "select" in opts ? { selectedId: opts.select ?? null } : {}),
    });
    scheduleSave();
  },

  add(a, opts) {
    get().commit([...get().annotations, a], { select: a.id });
    const after = get().annotations.find((x) => x.id === a.id);
    if (after?.resolution) {
      set({
        flash: {
          screenId: a.screenId,
          ids: after.resolution.elements,
          region: after.resolution.region,
          until: Date.now() + 1500,
        },
      });
    }
    if (opts?.edit) set({ editor: { annotationId: a.id, isNew: true } });
  },

  update(id, patch) {
    const next = get().annotations.map((a) =>
      a.id === id ? (typeof patch === "function" ? patch(a) : { ...a, ...patch }) : a,
    );
    get().commit(next);
  },

  remove(id) {
    const s = get();
    const next = s.annotations.filter((a) => a.id !== id && a.attachedTo !== id);
    s.commit(next, { select: null });
    set({ editor: null, picker: null });
  },

  undo() {
    const s = get();
    const prev = s.history.past[s.history.past.length - 1];
    if (!prev || readOnly(s.round)) return;
    set({
      annotations: prev,
      history: { past: s.history.past.slice(0, -1), future: [s.annotations, ...s.history.future] },
      editor: null,
      picker: null,
    });
    scheduleSave();
  },

  redo() {
    const s = get();
    const next = s.history.future[0];
    if (!next || readOnly(s.round)) return;
    set({
      annotations: next,
      history: { past: [...s.history.past, s.annotations], future: s.history.future.slice(1) },
      editor: null,
      picker: null,
    });
    scheduleSave();
  },

  select(id) {
    set({ selectedId: id, picker: null });
  },

  toast(t) {
    const id = ++toastSeq;
    set({ toasts: [...get().toasts.slice(-3), { ...t, id }] });
    if (!t.action) setTimeout(() => get().dismissToast(id), 3800);
  },

  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },

  set(p) {
    set(p);
  },
}));

function scheduleSave() {
  const { set } = { set: useStore.setState };
  set({ saveState: "saving" });
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const s = useStore.getState();
    if (!s.round) return;
    try {
      await api.saveAnnotations(s.round.round, s.annotations);
      set({ saveState: "saved" });
    } catch (e) {
      set({ saveState: "error" });
      s.toast({ text: `autosave failed: ${(e as Error).message}`, tone: "err" });
    }
  }, 250);
}

export const isReadOnly = () => readOnly(useStore.getState().round);

/* ─────────────────────────── derived ─────────────────────────── */

export function useMarkers() {
  const annotations = useStore((s) => s.annotations);
  const round = useStore((s) => s.round);
  return useMemoOnce(annotations, round, () => {
    const order = round?.screens.map((s) => s.id) ?? [];
    return numberAnnotations(annotations, order);
  });
}

// tiny memo keyed on identity of two values
const memoCache = new WeakMap<object, { k2: unknown; v: unknown }>();
function useMemoOnce<T>(k1: object, k2: unknown, fn: () => T): T {
  const hit = memoCache.get(k1);
  if (hit && hit.k2 === k2) return hit.v as T;
  const v = fn();
  memoCache.set(k1, { k2, v });
  return v;
}

export function compileCurrent(): CompileOutput | null {
  const s = useStore.getState();
  if (!s.round) return null;
  const titles = new Map(s.round.screens.map((x) => [x.id, x.title]));
  return compile({
    round: s.round.round,
    appName: s.round.app?.name ?? "app",
    date: new Date().toISOString().slice(0, 10),
    screens: s.round.screens.map((x) => ({ id: x.id, title: titles.get(x.id) ?? x.id })),
    captures: s.captures,
    annotations: s.annotations,
  });
}

export function elementOf(screenId: string, elementId: string): UIElement | undefined {
  const t = useStore.getState().trees.get(screenId);
  return t ? indexFor(t).get(elementId) : undefined;
}

export function screenInfo(id: string): ScreenInfo | undefined {
  return useStore.getState().round?.screens.find((s) => s.id === id);
}

export function tileOf(id: string): TileLayout | undefined {
  return useStore.getState().tiles.find((t) => t.id === id);
}

/** Label for a resolution chip: `button "Pay now"`. */
export function describeElement(el: UIElement): string {
  const label = el.label ? ` "${el.label.length > 28 ? el.label.slice(0, 27) + "…" : el.label}"` : "";
  const id = el.idSource !== "generated" ? `#${el.id}` : "";
  // unnamed elements are told apart by size
  const size = !id && !label ? ` ${el.bounds.w}×${el.bounds.h}` : "";
  return `${el.type}${id}${label}${size}`;
}

export function unresolvedCount(annotations: Annotation[]): number {
  return annotations.filter(
    (a) => a.kind !== "rule" && !(a.kind === "comment" && a.attachedTo) && a.resolution?.status === "unresolved",
  ).length;
}

/** Screens waiting for or in capture right now (from this server or another process). */
export function useCapturingScreens(): Set<string> {
  const cs = useStore((s) => s.captureState);
  const ext = useStore((s) => s.externalCapture);
  const ids = new Set<string>();
  if (cs.running) {
    for (const id of cs.queue ?? []) ids.add(id);
    if (cs.current) ids.add(cs.current);
  }
  if (ext) {
    for (const id of ext.queue) ids.add(id);
    if (ext.current) ids.add(ext.current);
  }
  return ids;
}
