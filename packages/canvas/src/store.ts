import { create } from "zustand";
import {
  compile,
  indexFor,
  newAnnotationId,
  numberAnnotations,
  resolveAll,
  sketchPartsBounds,
  type Annotation,
  type AnnotationKind,
  type CompileOutput,
  type ScreenCapture,
  type SketchPart,
  type SketchStyle,
  type UIElement,
} from "@scribui/core";
import { api, type CaptureState, type LanState, type ProjectPayload, type RoundListItem, type RoundPayload, type ScreenInfo } from "./api";
import { layoutBoard, type Camera, type GroupLayout, type TileLayout } from "./layout";
import { measureText } from "./vision";

/** Drawing tools: on the board they sketch on screens, on the vision board they draw anywhere. */
export type SketchTool = "line" | "box" | "ellipse" | "text" | "fill";
export type Tool = "select" | Exclude<AnnotationKind, "sketch"> | SketchTool;
/** Tools whose look the settings box can change. */
export type StyledTool = "freehand" | SketchTool;
export const SKETCH_TOOLS: SketchTool[] = ["line", "box", "ellipse", "text", "fill"];
export const isSketchTool = (t: Tool): t is SketchTool => (SKETCH_TOOLS as Tool[]).includes(t);

export const TOOLS: { tool: Tool; key: string; label: string; hint: string }[] = [
  { tool: "select", key: "V", label: "select", hint: "click an element or annotation" },
  { tool: "comment", key: "C", label: "comment", hint: "click to pin, then type" },
  { tool: "circle", key: "O", label: "circle", hint: "drag a loop around something" },
  { tool: "arrow", key: "A", label: "arrow", hint: "drag start → end; may end on another tile" },
  { tool: "rectangle", key: "R", label: "rect", hint: "drag a box where something should go" },
  { tool: "remove", key: "X", label: "remove", hint: "click an element to strike it out" },
  { tool: "freehand", key: "P", label: "draw", hint: "draw freely, in as many strokes as you like" },
  { tool: "rule", key: "U", label: "rule", hint: "shift-click elements on any screens, then ⏎ and type" },
  { tool: "line", key: "I", label: "line", hint: "drag a straight line" },
  { tool: "box", key: "B", label: "box", hint: "drag a box; shift for a square" },
  { tool: "ellipse", key: "Q", label: "ellipse", hint: "drag an ellipse; shift for a circle" },
  { tool: "text", key: "T", label: "text", hint: "click where the text goes, then type" },
  { tool: "fill", key: "G", label: "fill", hint: "click inside a closed area to fill it; click a line to recolour it" },
];

/** Hints that differ on the vision board. */
export const VISION_HINTS: Partial<Record<Tool, string>> = {
  select: "click to select; drag to move; corners resize, the top handle rotates",
  freehand: "draw freely; outside a canvas it starts a new one",
};

export const DEFAULT_STYLES: Record<StyledTool, SketchStyle> = {
  freehand: { color: "#262626", width: 4 },
  line: { color: "#262626", width: 3 },
  box: { color: "#262626", width: 3 },
  ellipse: { color: "#262626", width: 3 },
  text: { color: "#262626", width: 1, size: 32 },
  fill: { color: "#3E63DD", width: 1 },
};

function loadStyles(): Record<StyledTool, SketchStyle> {
  try {
    const saved = JSON.parse(localStorage.getItem("scribui:tool-styles") ?? "{}") as Partial<Record<StyledTool, SketchStyle>>;
    return { ...DEFAULT_STYLES, ...saved };
  } catch {
    return { ...DEFAULT_STYLES };
  }
}

export type HoverInfo = { screenId: string; stack: UIElement[]; level: number; px: [number, number] } | null;

/**
 * The sketch the sketch tools are adding to: strokes, lines, boxes, ellipses and text, in
 * screenshot pixels. `typing` is the index of a text part whose words are being typed.
 */
export type OpenDrawing = { screenId: string; parts: SketchPart[]; typing?: number };

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
  /** Capture running in another process (e.g. the agent ran `scribui capture`), from status.json. */
  externalCapture: { round: number; total: number; done: number; current?: string; queue: string[] } | null;
  lan: LanState;
  lanOpen: boolean;
  /** The "applied" banner was dismissed for this round. */
  appliedDismissed: number | null;
  /** The vision board (visual direction), the running app (web) or the review board. */
  view: "vision" | "board" | "live";
  /** Look of new drawings, per tool. */
  toolStyles: Record<StyledTool, SketchStyle>;
  /** Once opened, the app tab stays mounted so switching views keeps the app's state. */
  liveVisited: boolean;
  /** The tile whose remove button is asking for confirmation. */
  removeAsk: string | null;
  /**
   * The sketch in progress: everything the sketch tools draw on a screen joins it, whatever
   * the tool, until it's finished (⏎, Ready, a tool that isn't a sketch tool, another screen).
   */
  drawing: OpenDrawing | null;
  /** Undo and redo within the open sketch: what it was before each change, and after each undo. */
  sketchHistory: { past: (OpenDrawing | null)[]; future: (OpenDrawing | null)[] };
};

type Actions = {
  load(round?: number): Promise<void>;
  refreshRounds(): Promise<void>;
  setTool(t: Tool): void;
  setCamera(c: Camera | ((c: Camera) => Camera)): void;
  commit(next: Annotation[], opts?: { select?: string | null; coalesce?: string }): void;
  add(a: Annotation, opts?: { edit?: boolean }): void;
  update(id: string, patch: Partial<Annotation> | ((a: Annotation) => Annotation), opts?: { coalesce?: string }): void;
  remove(id: string): void;
  undo(): void;
  redo(): void;
  select(id: string | null): void;
  toast(t: Omit<Toast, "id">): void;
  dismissToast(id: number): void;
  set(p: Partial<State>): void;
  setToolStyle(tool: StyledTool, patch: Partial<SketchStyle>): void;
  /** Add a part to the open sketch; one on another screen finishes that sketch first. `typing`: a text part to type into. */
  addPart(screenId: string, part: SketchPart, opts?: { typing?: boolean }): void;
  /** Set the words of the text part being typed; the typing ends with `done`, and empty text is dropped. */
  typePart(text: string, done?: boolean): void;
  /** Turn the open sketch into one annotation and open its note (unless `note` is false). */
  finishDrawing(note?: boolean): void;
  /** Replace part `i` of the open sketch (the fill tool recolours and fills parts). */
  setOpenPart(i: number, part: SketchPart): void;

  recapture(screenIds: string[]): Promise<void>;
  captureNext(opts?: { build?: boolean; all?: boolean }): Promise<void>;
  removeScreen(id: string): Promise<void>;
};

export type Store = State & Actions;

const readOnly = (r: RoundPayload | null) => !r || r.status.status === "sent" || r.status.status === "applied";

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let lastCoalesce = { key: "", at: 0 };
let toastSeq = 0;

let startViewChosen = false;
/** True the first time this project is opened here (remembered per browser or app). */
function firstOpen(root: string): boolean {
  const key = `scribui:opened:${root}`;
  try {
    if (localStorage.getItem(key)) return false;
    localStorage.setItem(key, "1");
    return true;
  } catch {
    return false;
  }
}

function loadTheme(): "dark" | "light" {
  const system = window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  try {
    return (localStorage.getItem("scribui:theme") as "dark" | "light") || system;
  } catch {
    return system;
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
  // the vision board is where a review starts
  // the first load picks the starting view (see load)
  view: "board",
  toolStyles: loadStyles(),
  liveVisited: false,
  removeAsk: null,
  drawing: null,
  sketchHistory: { past: [], future: [] },

  /** Recapture some screens into the current open round. */
  async recapture(ids) {
    const s = get();
    const round = s.round;
    if (!round || ids.length === 0) return;
    if (!round.canRecapture || !ids.some((id) => round.screens.find((x) => x.id === id)?.recapturable)) {
      const byHand = round.app?.platform !== "web" || ids.every((id) => round.screens.find((x) => x.id === id)?.recapturable === false);
      s.toast({
        text: byHand ? "captured by hand: capture it again in the App tab" : "capturing from the canvas needs ScribUI started with `scribui`",
        tone: "warn",
      });
      return;
    }
    ids = ids.filter((id) => round.screens.find((x) => x.id === id)?.recapturable);
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
      if (!startViewChosen) {
        startViewChosen = true;
        // a new project starts on the vision board, once; after that the board is the place to start
        if (firstOpen(project.root) && (project.latest ?? 0) <= 1) set({ view: "vision" });
      }
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
        drawing: same && !readOnly(round) ? get().drawing : null,
        sketchHistory: same && !readOnly(round) ? get().sketchHistory : { past: [], future: [] },
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
    if (tool !== "freehand" && !isSketchTool(tool)) get().finishDrawing();
    else get().typePart(textOfTyping(get().drawing), true);
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
    // a change outside a sketch: undone sketch steps can't be redone any more
    if (!s.drawing && (s.sketchHistory.past.length || s.sketchHistory.future.length)) set({ sketchHistory: { past: [], future: [] } });
    // a run of changes with the same key (a slider being dragged) is one undo step
    const merge = !!opts?.coalesce && lastCoalesce.key === opts.coalesce && Date.now() - lastCoalesce.at < 800;
    lastCoalesce = { key: opts?.coalesce ?? "", at: Date.now() };
    set({
      annotations: resolved,
      history: merge ? { ...s.history, future: [] } : { past: [...s.history.past.slice(-199), s.annotations], future: [] },
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

  update(id, patch, opts) {
    const next = get().annotations.map((a) =>
      a.id === id ? (typeof patch === "function" ? patch(a) : { ...a, ...patch }) : a,
    );
    get().commit(next, opts);
  },

  remove(id) {
    const s = get();
    const next = s.annotations.filter((a) => a.id !== id && a.attachedTo !== id);
    s.commit(next, { select: null });
    set({ editor: null, picker: null });
  },

  undo() {
    // in a sketch, its own steps first
    get().typePart(textOfTyping(get().drawing), true);
    const h = get().sketchHistory;
    if (h.past.length) {
      const prev = h.past[h.past.length - 1]!;
      return set({ drawing: prev, sketchHistory: { past: h.past.slice(0, -1), future: [get().drawing, ...h.future] } });
    }
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
    get().typePart(textOfTyping(get().drawing), true);
    const h = get().sketchHistory;
    if (h.future.length) {
      const next = h.future[0]!;
      return set({ drawing: next, sketchHistory: { past: [...h.past, get().drawing], future: h.future.slice(1) } });
    }
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

  addPart(screenId, part, opts) {
    if (get().drawing?.typing !== undefined) get().typePart(textOfTyping(get().drawing), true);
    if (get().drawing && get().drawing!.screenId !== screenId) get().finishDrawing();
    const parts = [...(get().drawing?.parts ?? []), part];
    changeDrawing({ screenId, parts, ...(opts?.typing ? { typing: parts.length - 1 } : {}) });
    set({ selectedId: null });
  },

  typePart(text, done) {
    const d = get().drawing;
    if (!d || d.typing === undefined) return;
    const i = d.typing;
    const part = d.parts[i];
    if (part?.type !== "text") return;
    const size = part.style.size ?? 32;
    const parts = d.parts.slice();
    parts[i] = { ...part, text, ...measureText(text, size) };
    if (!done) return set({ drawing: { ...d, parts } });
    // typing ends; a text part without words goes, and so does the undo step that added it
    if (text.trim()) return set({ drawing: { screenId: d.screenId, parts } });
    const kept = parts.filter((_, j) => j !== i);
    const h = get().sketchHistory;
    set({ drawing: kept.length ? { screenId: d.screenId, parts: kept } : null, sketchHistory: { ...h, past: h.past.slice(0, -1) } });
  },

  finishDrawing(note = true) {
    if (get().drawing?.typing !== undefined) get().typePart(textOfTyping(get().drawing), true);
    const d = get().drawing;
    if (!d) return;
    set({ drawing: null, sketchHistory: { past: [], future: [] } });
    if (!d.parts.length || !get().tiles.some((t) => t.id === d.screenId) || readOnly(get().round)) return;
    get().add(
      {
        id: newAnnotationId(),
        screenId: d.screenId,
        kind: "sketch",
        geometry: { type: "rect", ...sketchPartsBounds(d.parts) },
        sketch: { shape: "drawing", style: d.parts[0]!.style, parts: d.parts },
      },
      { edit: note },
    );
  },

  setOpenPart(i, part) {
    const d = get().drawing;
    if (!d?.parts[i]) return;
    changeDrawing({ ...d, parts: d.parts.map((p, j) => (j === i ? part : p)) });
  },

  setToolStyle(tool, patch) {
    const toolStyles = { ...get().toolStyles, [tool]: { ...get().toolStyles[tool], ...patch } };
    set({ toolStyles });
    try {
      localStorage.setItem("scribui:tool-styles", JSON.stringify(toolStyles));
    } catch {
      /* storage blocked */
    }
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

/** The words of the open sketch's text part being typed. */
export function textOfTyping(d: OpenDrawing | null): string {
  const p = d?.typing !== undefined ? d.parts[d.typing] : undefined;
  return p?.type === "text" ? p.text : "";
}

/** Change the open sketch as one undo step. */
function changeDrawing(next: OpenDrawing | null) {
  const { drawing: cur, sketchHistory: h } = useStore.getState();
  const snap = cur ? { screenId: cur.screenId, parts: cur.parts } : null;
  useStore.setState({ drawing: next, sketchHistory: { past: [...h.past.slice(-199), snap], future: [] } });
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
