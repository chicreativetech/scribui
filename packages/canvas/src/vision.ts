import { create } from "zustand";
import {
  a4Around,
  A4_CANVAS,
  canvasOf,
  isA4,
  itemBounds,
  TEXT_LINE,
  VISION_FONT,
  wrapCanvas,
  type Rect,
  type VisionCanvas,
  type VisionFile,
  type VisionItem,
} from "@scribui/core";
import { api } from "./api";
import { fitCamera, type Camera } from "./layout";
import { useStore } from "./store";

/**
 * The vision board: the project's visual direction, drawn on white canvases.
 * One board per project, never locked; the agent gets it as vision.md on send.
 */

type Doc = { canvases: VisionCanvas[]; items: VisionItem[] };
export type TextItem = Extract<VisionItem, { type: "text" }>;
type History = { past: Doc[]; future: Doc[] };

type VisionState = {
  doc: Doc;
  loaded: boolean;
  history: History;
  selectedId: string | null;
  /** Text being typed: a new one is added to the board only once it has words. */
  textEdit: { item: TextItem; isNew: boolean } | null;
  camera: Camera;
  /** The camera was fitted to the canvases once. */
  fitted: boolean;
  saveState: "saved" | "saving" | "error";
  importOpen: boolean;
};

type VisionActions = {
  load(): Promise<void>;
  /** Replace the document, with undo. Changes with the same `coalesce` key in quick succession are one undo step. */
  commit(doc: Doc, opts?: { select?: string | null; coalesce?: string }): void;
  /** Add a drawn item; off every canvas it gets a canvas of its own. */
  add(item: VisionItem): void;
  /** Finish typing: add, update or (when emptied) remove the text. */
  commitText(text: string): void;
  update(id: string, patch: (i: VisionItem) => VisionItem, opts?: { coalesce?: string }): void;
  remove(id: string): void;
  removeCanvas(id: string): void;
  reorder(id: string, to: "front" | "back"): void;
  undo(): void;
  redo(): void;
  set(p: Partial<VisionState>): void;
  setCamera(c: Camera | ((c: Camera) => Camera)): void;
};

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let lastCoalesce = { key: "", at: 0 };

export const useVision = create<VisionState & VisionActions>((set, get) => ({
  doc: { canvases: [], items: [] },
  loaded: false,
  history: { past: [], future: [] },
  selectedId: null,
  textEdit: null,
  camera: { x: -80, y: -80, zoom: 0.5 },
  fitted: false,
  saveState: "saved",
  importOpen: false,

  async load() {
    try {
      const v = await api.vision();
      // canvases are A4: older boards' canvases grow to the A4 around them, so nothing drawn falls off
      const reshaped = v.canvases.some((c) => !isA4(c));
      const doc = { canvases: v.canvases.map((c) => (isA4(c) ? c : { id: c.id, ...a4Around(c) })), items: v.items };
      if (doc.canvases.length === 0) doc.canvases = [{ id: newId("c"), x: 0, y: 0, ...defaultCanvasSize() }];
      const sel = get().selectedId;
      set({ doc, loaded: true, selectedId: sel && doc.items.some((i) => i.id === sel) ? sel : null });
      if (reshaped) scheduleSave();
    } catch (e) {
      set({ loaded: true });
      useStore.getState().toast({ text: `vision board: ${(e as Error).message}`, tone: "err" });
    }
  },

  commit(doc, opts) {
    const s = get();
    const merge = !!opts?.coalesce && lastCoalesce.key === opts.coalesce && Date.now() - lastCoalesce.at < 800;
    lastCoalesce = { key: opts?.coalesce ?? "", at: Date.now() };
    set({
      doc,
      history: merge ? { ...s.history, future: [] } : { past: [...s.history.past.slice(-199), s.doc], future: [] },
      ...(opts && "select" in opts ? { selectedId: opts.select ?? null } : {}),
    });
    scheduleSave();
  },

  add(item) {
    const doc = get().doc;
    get().commit(placeItem({ ...doc, items: [...doc.items, item] }, item.id), { select: item.id });
  },

  commitText(text) {
    const edit = get().textEdit;
    set({ textEdit: null });
    if (!edit) return;
    const words = text.replace(/\s+$/, "");
    const size = edit.item.style.size ?? 32;
    if (edit.isNew) {
      if (words.trim()) get().add({ ...edit.item, text: words, ...measureText(words, size) });
      return;
    }
    if (!words.trim()) return get().remove(edit.item.id);
    if (words !== edit.item.text) get().update(edit.item.id, (i) => ({ ...i, text: words, ...measureText(words, size) }) as VisionItem);
  },

  update(id, patch, opts) {
    const doc = get().doc;
    get().commit(placeItem({ ...doc, items: doc.items.map((i) => (i.id === id ? patch(i) : i)) }, id), opts);
  },

  remove(id) {
    const doc = get().doc;
    get().commit({ ...doc, items: doc.items.filter((i) => i.id !== id) }, { select: null });
  },

  removeCanvas(id) {
    const doc = get().doc;
    if (doc.canvases.length <= 1) return;
    const canvases = doc.canvases.filter((c) => c.id !== id);
    const items = doc.items.filter((i) => canvasOf(i, doc.canvases)?.id !== id);
    get().commit({ canvases, items }, { select: null });
  },

  reorder(id, to) {
    const doc = get().doc;
    const item = doc.items.find((i) => i.id === id);
    if (!item) return;
    const rest = doc.items.filter((i) => i.id !== id);
    get().commit({ ...doc, items: to === "front" ? [...rest, item] : [item, ...rest] });
  },

  undo() {
    const s = get();
    const prev = s.history.past[s.history.past.length - 1];
    if (!prev) return;
    set({ doc: prev, history: { past: s.history.past.slice(0, -1), future: [s.doc, ...s.history.future] }, textEdit: null });
    scheduleSave();
  },

  redo() {
    const s = get();
    const next = s.history.future[0];
    if (!next) return;
    set({ doc: next, history: { past: [...s.history.past, s.doc], future: s.history.future.slice(1) }, textEdit: null });
    scheduleSave();
  },

  set(p) {
    set(p);
  },

  setCamera(c) {
    set({ camera: typeof c === "function" ? c(get().camera) : c });
  },
}));

function scheduleSave() {
  useVision.setState({ saveState: "saving" });
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const { doc } = useVision.getState();
    const file: VisionFile = { version: 1, canvases: doc.canvases, items: doc.items };
    try {
      await api.saveVision(file);
      useVision.setState({ saveState: "saved" });
    } catch (e) {
      useVision.setState({ saveState: "error" });
      useStore.getState().toast({ text: `vision autosave failed: ${(e as Error).message}`, tone: "err" });
    }
  }, 300);
}

/* ─────────────────────────── helpers ─────────────────────────── */

export const newId = (prefix: string) => prefix + Math.random().toString(36).slice(2, 8).padEnd(6, "0");

/** Canvas size for new canvases: A4 portrait. */
export function defaultCanvasSize(): { w: number; h: number } {
  return { ...A4_CANVAS };
}

/** An item drawn off every canvas gets a new canvas around it. */
function placeItem(doc: Doc, id: string): Doc {
  const item = doc.items.find((i) => i.id === id);
  if (!item || canvasOf(item, doc.canvases)) return doc;
  const r = a4Around(wrapCanvas(itemBounds(item), doc.canvases, defaultCanvasSize()));
  return { ...doc, canvases: [...doc.canvases, { id: newId("c"), ...r }] };
}

export function translateItem(i: VisionItem, dx: number, dy: number): VisionItem {
  const r = (v: number) => Math.round(v * 10) / 10;
  switch (i.type) {
    case "stroke":
      return { ...i, points: i.points.map(([x, y, p]) => [r(x + dx), r(y + dy), p] as [number, number, number]) };
    case "line":
      return { ...i, from: [r(i.from[0] + dx), r(i.from[1] + dy)], to: [r(i.to[0] + dx), r(i.to[1] + dy)] };
    default:
      return { ...i, x: r(i.x + dx), y: r(i.y + dy) };
  }
}

let measureCtx: CanvasRenderingContext2D | null = null;
/** Size of a text item's box, measured with the canvas font. */
export function measureText(text: string, size: number): { w: number; h: number } {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  const lines = text.split("\n");
  let w = size * 0.6;
  if (measureCtx) {
    measureCtx.font = `500 ${size}px ${VISION_FONT}`;
    for (const l of lines) w = Math.max(w, measureCtx.measureText(l).width);
  }
  return { w: Math.ceil(w + 2), h: Math.ceil(lines.length * size * TEXT_LINE) };
}

/** Bounds of every canvas together. */
export function canvasesBounds(canvases: VisionCanvas[]): Rect {
  const x = Math.min(...canvases.map((c) => c.x));
  const y = Math.min(...canvases.map((c) => c.y));
  const r = Math.max(...canvases.map((c) => c.x + c.w));
  const b = Math.max(...canvases.map((c) => c.y + c.h));
  return { x, y, w: r - x, h: b - y };
}

export function fitVision(vp: { x: number; y: number; w: number; h: number }): Camera {
  const { canvases } = useVision.getState().doc;
  if (!canvases.length) return { x: -80, y: -80, zoom: 0.5 };
  return fitCamera(canvasesBounds(canvases), vp, 64, 1);
}

/** Upload an image and place it, fitted into the canvas in view (or at `at`, a world point). */
export async function importImage(file: Blob, at?: [number, number]): Promise<void> {
  const st = useStore.getState();
  try {
    const blob = await normaliseImage(file);
    const { src } = await api.uploadVisionImage(blob);
    const natural = await imageSize(blob);
    const v = useVision.getState();
    const center = at ?? viewCenter();
    const host = v.doc.canvases.find((c) => center[0] >= c.x && center[0] <= c.x + c.w && center[1] >= c.y && center[1] <= c.y + c.h) ?? v.doc.canvases[0];
    const maxW = (host?.w ?? 800) * 0.6;
    const maxH = (host?.h ?? 600) * 0.6;
    const k = Math.min(1, maxW / natural.w, maxH / natural.h);
    const w = Math.round(natural.w * k);
    const h = Math.round(natural.h * k);
    const item: VisionItem = { id: newId("v"), type: "image", x: Math.round(center[0] - w / 2), y: Math.round(center[1] - h / 2), w, h, src };
    v.add(item);
    useStore.getState().setTool("select");
  } catch (e) {
    st.toast({ text: `image import failed: ${(e as Error).message}`, tone: "err" });
  }
}

/** The world point at the centre of the uncovered part of the screen. */
function viewCenter(): [number, number] {
  const cam = useVision.getState().camera;
  const el = document.querySelector(".vision")?.getBoundingClientRect();
  const side = document.querySelector(".inspector:not(.closed)")?.getBoundingClientRect();
  const rail = document.querySelector(".rail")?.getBoundingClientRect();
  if (!el) return [0, 0];
  const left = rail ? rail.right - el.left : 0;
  const right = side ? side.left - el.left : el.width;
  return [cam.x + (left + right) / 2 / cam.zoom, cam.y + el.height / 2 / cam.zoom];
}

const KEEP = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** PNG/JPEG/GIF/WebP pass through (scaled down when huge); anything else the browser can draw becomes PNG. */
async function normaliseImage(file: Blob): Promise<Blob> {
  const size = await imageSize(file);
  const max = 4096;
  if (KEEP.includes(file.type) && size.w <= max && size.h <= max) return file;
  const k = Math.min(1, max / size.w, max / size.h);
  const c = document.createElement("canvas");
  c.width = Math.round(size.w * k);
  c.height = Math.round(size.h * k);
  const img = await loadImage(file);
  c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("could not convert the image"))), "image/png"));
}

async function imageSize(blob: Blob): Promise<{ w: number; h: number }> {
  const img = await loadImage(blob);
  return { w: img.naturalWidth || 400, h: img.naturalHeight || 300 };
}

function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      res(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      rej(new Error("not an image the browser can read"));
    };
    img.src = url;
  });
}
