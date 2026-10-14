import { useEffect, useLayoutEffect, useRef } from "react";
import { newAnnotationId, numberAnnotations, type Annotation, type Geometry, type SketchPart } from "@scribui/core";
import { MarkSurface, type ShownMark, type Styles, type SurfaceMark, type SurfaceTool } from "../markSurface";
import { isReadOnly, TOOLS, useStore, type Tool } from "../store";

/**
 * Marking up the app directly, in the App tab (web, desktop app) and the Device
 * tab (Android and iOS), with Review's own tool rail. A mark becomes a note on a
 * screen in Review, the same as one made there, and can be changed there. The
 * drawing itself is MarkSurface (markSurface.ts), shared with the page layer.
 *
 * Web: the page's own mark layer (desktop markLayer.ts) sends marks in page
 * coordinates. The first mark on a page captures the whole page as a screen;
 * later marks on the same page, while it hasn't changed (same signature), join
 * that screen. The notes on the shown page go back to the layer, which keeps
 * them on their elements as the page scrolls, and shows them again when the
 * page is opened.
 *
 * Mobile: a tool freezes the picture; the first mark captures the screen, later
 * ones join it until marking stops. The marks show on the frozen picture only;
 * after that they're in Review.
 */

type Pt = [number, number];
type Draft = { tempId: string; annotation: SurfaceMark["annotation"]; anchor?: { selector: string; x: number; y: number }; signature: string; url: string };

const SURFACE_TOOLS = new Set<Tool>(["comment", "circle", "arrow", "rectangle", "remove", "freehand", "line", "box", "ellipse", "text", "fill"]);
/** The rail's tool as a mark tool in the App and Device tabs; select (use the app) and rule are none. */
export const liveTool = (t: Tool): SurfaceTool | null => (SURFACE_TOOLS.has(t) ? (t as SurfaceTool) : null);
/** Rules point at elements across screens: made in Review. */
export const LIVE_UNSUPPORTED = new Set<Tool>(["rule"]);

/** The rail's keys in the App and Device tabs (undo and redo included); true when the key was one. */
export function liveKey(e: KeyboardEvent): boolean {
  const st = useStore.getState();
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === "z") {
    if (e.shiftKey) st.redo();
    else st.undo();
    return true;
  }
  if (mod || e.altKey) return false;
  if (e.key === "Escape" && st.tool !== "select") {
    st.setTool("select");
    return true;
  }
  const t = TOOLS.find((x) => x.key === e.key.toUpperCase());
  if (!t || LIVE_UNSUPPORTED.has(t.tool)) return false;
  st.setTool(t.tool);
  return true;
}

/* ─────────────────────────── coordinates ─────────────────────────── */

/** An annotation moved into another space: `kx`, `ky` per unit (widths and text sizes too). */
export function scaleAnnotation<A extends Omit<Annotation, "id" | "screenId">>(a: A, kx: number, ky = kx): A {
  const r = (v: number) => Math.round(v * 10) / 10;
  const s = (p: readonly number[]): Pt => [r(p[0]! * kx), r(p[1]! * ky)];
  const k = (kx + ky) / 2;
  const geo = (g: Geometry): Geometry => {
    switch (g.type) {
      case "point":
        return { type: "point", x: r(g.x * kx), y: r(g.y * ky) };
      case "path":
        return { type: "path", points: g.points.map(s) };
      case "rect":
        return { type: "rect", x: r(g.x * kx), y: r(g.y * ky), w: r(g.w * kx), h: r(g.h * ky) };
      case "arrow":
        return { ...g, from: s(g.from), to: s(g.to) };
    }
  };
  const style = <T extends { width: number; size?: number }>(st: T): T => ({ ...st, width: Math.max(0.5, r(st.width * k)), ...(st.size ? { size: r(st.size * k) } : {}) });
  const part = (p: SketchPart): SketchPart => {
    switch (p.type) {
      case "stroke":
        return { ...p, points: p.points.map((q) => [...s(q), q[2]] as [number, number, number]), style: style(p.style) };
      case "line":
        return { ...p, from: s(p.from), to: s(p.to), style: style(p.style) };
      case "fill":
        return { ...p, loops: p.loops.map((l) => l.map(s)), style: p.style };
      default:
        return { ...p, x: r(p.x * kx), y: r(p.y * ky), w: r(p.w * kx), h: r(p.h * ky), style: style(p.style) };
    }
  };
  return {
    ...a,
    geometry: geo(a.geometry),
    ...(a.sketch ? { sketch: { ...a.sketch, style: style(a.sketch.style), ...(a.sketch.parts ? { parts: a.sketch.parts.map(part) } : {}) } } : {}),
  };
}

/** The rail's sketch styles, as the surface takes them. */
export const surfaceStyles = (): Styles => {
  const s = useStore.getState().toolStyles;
  return { freehand: s.freehand, line: s.line, box: s.box, ellipse: s.ellipse, text: s.text, fill: s.fill };
};

const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
function validDraft(d: unknown): d is Draft {
  const x = d as Record<string, unknown> | null;
  if (!x || typeof x.tempId !== "string" || typeof x.url !== "string" || typeof x.signature !== "string") return false;
  const a = x.annotation as Record<string, unknown> | null;
  if (!a || typeof a.kind !== "string" || !a.geometry || typeof a.geometry !== "object") return false;
  if (!["comment", "circle", "arrow", "rectangle", "remove", "sketch"].includes(a.kind)) return false;
  const an = x.anchor as Record<string, unknown> | undefined;
  if (an !== undefined && !(typeof an.selector === "string" && an.selector.length < 2000 && num(an.x) && num(an.y))) return false;
  return JSON.stringify(a).length < 300_000;
}

/* ─────────────────────────── web: the page's marks ─────────────────────────── */

const manifestOf = () => {
  const p = useStore.getState().project;
  return p && "app" in p.manifest ? p.manifest : null;
};

/** A page address as screens.json keeps it: a path when it's on the app's own origin, without the #fragment. */
export function pagePath(url: string, base?: string): string {
  let u = url.split("#")[0]!;
  try {
    if (base) u = new URL(u, base).href;
    const origin = base ? new URL(base).origin : "";
    return origin && u.startsWith(origin) ? u.slice(origin.length) || "/" : u;
  } catch {
    return u;
  }
}

/** Screens of the shown round marked up on this page (captured whole). */
function pageScreens(url: string) {
  const st = useStore.getState();
  const m = manifestOf();
  if (!m || !st.round) return [];
  const path = pagePath(url, m.app.baseUrl);
  const shown = new Set(st.round.screens.filter((s) => s.captured).map((s) => s.id));
  return m.screens.filter((s) => s.live && s.viewport?.fullPage && s.url && shown.has(s.id) && pagePath(s.url, m.app.baseUrl) === path);
}

/** Notes made on a whole-page screen, for the page's mark layer: page CSS pixels, numbered as in Review. */
export function layerMarks(url: string) {
  const st = useStore.getState();
  const screens = pageScreens(url);
  if (!screens.length || !st.round) return [];
  const scale = new Map(screens.map((s) => [s.id, st.captures.get(s.id)?.device.scale ?? 1] as const));
  const { markers } = numberAnnotations(st.annotations, st.round.screens.map((s) => s.id));
  return st.annotations
    .filter((a) => scale.has(a.screenId) && a.kind !== "rule" && !(a.kind === "comment" && a.attachedTo))
    .map((a) => {
      const { anchor, ...rest } = a;
      const n = markers.get(a.id);
      return { annotation: scaleAnnotation(rest, 1 / scale.get(a.screenId)!), ...(n ? { label: String(n) } : {}), ...(anchor ? { anchor } : {}) };
    });
}

/** Marks waiting for their screen (a capture): one at a time, so two marks on a new page make one screen. */
let queue: Promise<void> = Promise.resolve();

/** A mark from the page's layer: onto the page's screen (captured first when there's none, or the page changed). */
export function addWebMark(d: unknown, done: (tempId: string) => void) {
  if (!validDraft(d)) return;
  queue = queue
    .then(async () => {
      let st = useStore.getState();
      const same = !isReadOnly() ? pageScreens(d.url).find((s) => s.pageSignature === d.signature) : undefined;
      let screenId = same?.id;
      if (!screenId) {
        if (!window.__scribuiCapture) throw new Error("marking up the app needs the ScribUI app");
        const r = await window.__scribuiCapture({ fullPage: true, signature: d.signature });
        await st.refreshRounds();
        await st.load(r.round);
        screenId = r.screenId;
      }
      st = useStore.getState();
      const scale = st.captures.get(screenId)?.device.scale ?? 1;
      st.add({ ...scaleAnnotation(d.annotation, scale), id: newAnnotationId(), screenId, ...(d.anchor ? { anchor: d.anchor } : {}) } as Annotation);
      done(d.tempId);
    })
    .catch((e: Error) => {
      useStore.getState().toast({ text: e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""), tone: "err" });
      done(d.tempId);
    });
}

/* ─────────────────────────── mobile: marking the frozen screen ─────────────────────────── */

/** A mark made on the device's frozen picture (pixels of the shown screen, `shown` wide and high) onto its screen. */
export function addDeviceMark(m: SurfaceMark, screenId: string, shown: { w: number; h: number }) {
  const st = useStore.getState();
  const cap = st.captures.get(screenId);
  if (!cap) throw new Error("the captured screen didn't load");
  const { w, h } = cap.root.bounds;
  st.add({ ...scaleAnnotation(m.annotation, w / shown.w, h / shown.h), id: newAnnotationId(), screenId } as Annotation);
}

/**
 * The rail's tools over the device's frozen picture. `marks` are the ones made in
 * this session (shown until marking stops); `onMark` gets each finished one in
 * pixels of the shown screen, with its size.
 */
export function MarkPad({ tool, marks, onMark }: { tool: SurfaceTool; marks: SurfaceMark[]; onMark: (m: SurfaceMark, shown: { w: number; h: number }) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const surface = useRef<MarkSurface | null>(null);
  const styles = useStore((s) => s.toolStyles);
  const cb = useRef(onMark);
  cb.current = onMark;

  useLayoutEffect(() => {
    const el = ref.current!;
    const s = new MarkSurface(
      el,
      {
        toSurface: (x, y) => {
          const r = el.getBoundingClientRect();
          return [x - r.left, y - r.top];
        },
        origin: () => [0, 0],
        onMark: (m) => cb.current(m, { w: el.clientWidth, h: el.clientHeight }),
        onExit: () => useStore.getState().setTool("select"),
        say: (text) => useStore.getState().toast({ text, tone: "info" }),
      },
      surfaceStyles(),
    );
    surface.current = s;
    const key = (e: KeyboardEvent) => {
      if (s.key(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      s.destroy();
      surface.current = null;
    };
  }, []);
  useEffect(() => surface.current?.setTool(tool, surfaceStyles()), [tool, styles]);
  useEffect(() => {
    const list: ShownMark[] = marks.map((m, i) => ({ annotation: { id: `m${i}`, screenId: "", ...m.annotation }, label: String(i + 1) }));
    surface.current?.setShown(list);
  }, [marks]);

  return <div ref={ref} className="mark-pad" />;
}
