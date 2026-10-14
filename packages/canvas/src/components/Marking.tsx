import { useEffect, useRef, useState } from "react";
import { newAnnotationId, numberAnnotations, type Annotation, type Geometry, type SketchPart } from "@scribui/core";
import { isReadOnly, useStore, type MarkTool } from "../store";
import { ICONS } from "./Chrome";

/**
 * Marking up the app directly, in the App tab (web, desktop app) and the Device
 * tab (Android and iOS). A mark becomes a note on a screen in Review, the same as
 * one made there, and can be changed there.
 *
 * Web: the page's own mark layer (desktop markLayer.ts) draws and sends marks in
 * page coordinates. The first mark on a page captures the whole page as a screen;
 * later marks on the same page, while it hasn't changed (same signature), join that
 * screen. The notes on the shown page go back to the layer, which keeps them on
 * their elements as the page scrolls, and shows them again when the page is opened.
 *
 * Mobile: picking a tool freezes the picture; the first mark captures the screen,
 * later ones join it until marking stops. The marks are shown on the frozen picture
 * only; after that they're in Review.
 */

type Pt = [number, number];
type Kind = "comment" | "circle" | "arrow" | "rectangle" | "remove" | "sketch";
type Stroke = { points: Pt[]; color: string; width: number };
/** A finished mark: `geometry` and `strokes` in page CSS pixels (web) or fractions of the screen (mobile). */
export type Mark = { kind: Kind; geometry: Geometry; text: string; strokes?: Stroke[] };
type Draft = Mark & { tempId: string; anchor?: { selector: string; x: number; y: number }; signature: string; url: string };

export const MARK_TOOLS: { tool: MarkTool; key: string; name: string; does: string }[] = [
  { tool: "comment", key: "C", name: "Comment", does: "click to pin a note" },
  { tool: "circle", key: "O", name: "Circle", does: "drag a loop around something" },
  { tool: "arrow", key: "A", name: "Arrow", does: "drag from something to where it should go" },
  { tool: "rectangle", key: "R", name: "Box", does: "drag a box where something should go" },
  { tool: "remove", key: "X", name: "Remove", does: "click something to strike it out" },
  { tool: "draw", key: "P", name: "Draw", does: "sketch freely, then Done" },
];
const BOARD_TOOL = { comment: "comment", circle: "circle", arrow: "arrow", rectangle: "rectangle", remove: "remove", draw: "freehand" } as const;

/* ─────────────────────────── the tool bar ─────────────────────────── */

/** The mark tools above the app: use the app, or pick a tool to mark it up. */
export function MarkBar({ disabled, mobile }: { disabled?: boolean; mobile?: boolean }) {
  const tool = useStore((s) => s.markTool);
  const pick = (t: MarkTool | null) => useStore.getState().set({ markTool: t });
  return (
    <div className="mark-bar" role="toolbar" aria-label="mark up the app">
      <button className={`item mark-tool ${tool === null ? "on" : ""}`} onClick={() => pick(null)} aria-pressed={tool === null} aria-label="use the app">
        {ICONS.select}
        <span className="bar-tip" role="tooltip">
          <b>Use the app</b> <kbd>V</kbd> <span className="dim">— click, type and scroll as usual</span>
        </span>
      </button>
      <span className="mark-sep" />
      {MARK_TOOLS.map((t) => (
        <button
          key={t.tool}
          className={`item mark-tool ${tool === t.tool ? "on" : ""}`}
          onClick={() => pick(tool === t.tool ? null : t.tool)}
          disabled={disabled}
          aria-pressed={tool === t.tool}
          aria-label={t.name}
        >
          {ICONS[BOARD_TOOL[t.tool]]}
          <span className="bar-tip" role="tooltip">
            <b>{t.name}</b> <kbd>{t.key}</kbd> <span className="dim">— {t.does}</span>
          </span>
        </button>
      ))}
      <span className="mark-hint faint">
        {tool === null
          ? "Pick a tool to mark up what you see. Your notes go to Review."
          : mobile
            ? "The screen holds still while you mark it up · Esc when done"
            : "Scroll as usual · Esc to stop marking"}
      </span>
    </div>
  );
}

/** The mark tools' keys in the App and Device tabs; true when the key was one. */
export function markKey(e: KeyboardEvent): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  const st = useStore.getState();
  if (e.key === "Escape" && st.markTool) {
    st.set({ markTool: null });
    return true;
  }
  const k = e.key.toUpperCase();
  if (k === "V") {
    st.set({ markTool: null });
    return true;
  }
  const t = MARK_TOOLS.find((x) => x.key === k);
  if (!t) return false;
  st.set({ markTool: t.tool });
  return true;
}

/* ─────────────────────────── marks → notes ─────────────────────────── */

const scalePt = (p: Pt, k: number): Pt => [Math.round(p[0] * k * 10) / 10, Math.round(p[1] * k * 10) / 10];

function scaleGeometry(g: Geometry, kx: number, ky = kx): Geometry {
  const s = (p: Pt): Pt => [Math.round(p[0] * kx * 10) / 10, Math.round(p[1] * ky * 10) / 10];
  switch (g.type) {
    case "point":
      return { type: "point", x: s([g.x, g.y])[0], y: s([g.x, g.y])[1] };
    case "path":
      return { type: "path", points: g.points.map(s) };
    case "rect": {
      const [x, y] = s([g.x, g.y]);
      const [w, h] = s([g.w, g.h]);
      return { type: "rect", x, y, w, h };
    }
    case "arrow":
      return { type: "arrow", from: s(g.from), to: s(g.to) };
  }
}

/** A mark as a note on a screen; `kx`, `ky` turn its coordinates into the screenshot's pixels. */
function toAnnotation(m: Mark, screenId: string, kx: number, ky = kx): Annotation {
  const geometry = scaleGeometry(m.geometry, kx, ky);
  const text = m.text.trim();
  const base = { id: newAnnotationId(), screenId, geometry, ...(text ? { text } : {}) };
  if (m.kind === "sketch" && m.strokes?.length) {
    const k = (kx + ky) / 2;
    const parts: SketchPart[] = m.strokes.map((s) => ({
      type: "stroke",
      points: s.points.map((p) => [Math.round(p[0] * kx * 10) / 10, Math.round(p[1] * ky * 10) / 10, 0.5] as [number, number, number]),
      style: { color: s.color, width: Math.max(1, s.width * k) },
    }));
    return { ...base, kind: "sketch", sketch: { shape: "drawing", style: parts[0]!.style, parts } };
  }
  return { ...base, kind: m.kind };
}

const KINDS = new Set<Kind>(["comment", "circle", "arrow", "rectangle", "remove", "sketch"]);
const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const pt = (v: unknown) => Array.isArray(v) && v.length >= 2 && num(v[0]) && num(v[1]);

function validGeometry(g: unknown): g is Geometry {
  const x = g as Record<string, unknown> | null;
  if (!x) return false;
  if (x.type === "point") return num(x.x) && num(x.y);
  if (x.type === "path") return Array.isArray(x.points) && x.points.length > 0 && x.points.length < 20_000 && x.points.every(pt);
  if (x.type === "rect") return num(x.x) && num(x.y) && num(x.w) && num(x.h);
  if (x.type === "arrow") return pt(x.from) && pt(x.to);
  return false;
}

function validDraft(d: unknown): d is Draft {
  const x = d as Record<string, unknown> | null;
  if (!x || typeof x.tempId !== "string" || typeof x.url !== "string" || typeof x.signature !== "string" || typeof x.text !== "string") return false;
  if (!KINDS.has(x.kind as Kind) || !validGeometry(x.geometry)) return false;
  if (x.strokes !== undefined && !(Array.isArray(x.strokes) && x.strokes.every((s) => Array.isArray(s?.points) && s.points.every(pt)))) return false;
  const a = x.anchor as Record<string, unknown> | undefined;
  if (a !== undefined && !(typeof a.selector === "string" && a.selector.length < 2000 && num(a.x) && num(a.y))) return false;
  return true;
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
  const replies = new Map(st.annotations.filter((a) => a.kind === "comment" && a.attachedTo).map((a) => [a.attachedTo!, a.text] as const));
  return st.annotations
    .filter((a) => scale.has(a.screenId) && a.kind !== "rule" && !(a.kind === "comment" && a.attachedTo))
    .map((a) => {
      const k = 1 / scale.get(a.screenId)!;
      const strokes = a.sketch?.parts
        ?.map((p) =>
          p.type === "stroke"
            ? { points: p.points.map((q) => scalePt([q[0], q[1]], k)), color: p.style.color, width: p.style.width * k }
            : p.type === "line"
              ? { points: [scalePt(p.from, k), scalePt(p.to, k)], color: p.style.color, width: p.style.width * k }
              : p.type === "box" || p.type === "ellipse"
                ? {
                    points: [
                      [p.x, p.y],
                      [p.x + p.w, p.y],
                      [p.x + p.w, p.y + p.h],
                      [p.x, p.y + p.h],
                      [p.x, p.y],
                    ].map((q) => scalePt(q as Pt, k)),
                    color: p.style.color,
                    width: p.style.width * k,
                  }
                : null,
        )
        .filter((s): s is Stroke => !!s);
      return {
        id: a.id,
        n: markers.get(a.id) ?? 0,
        kind: a.kind,
        geometry: scaleGeometry(a.geometry, k),
        ...(a.text || replies.get(a.id) ? { text: a.text || replies.get(a.id) } : {}),
        ...(a.anchor ? { anchor: a.anchor } : {}),
        ...(strokes?.length ? { strokes } : {}),
      };
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
      st.add({ ...toAnnotation(d, screenId, scale), ...(d.anchor ? { anchor: d.anchor } : {}) });
      done(d.tempId);
    })
    .catch((e: Error) => {
      useStore.getState().toast({ text: e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""), tone: "err" });
      done(d.tempId);
    });
}

/* ─────────────────────────── mobile: marking the frozen screen ─────────────────────────── */

/**
 * Add a mark made on the device's frozen picture (fractions of the screen) to its
 * screen, whose screenshot is `px` pixels. The screen is the one `capture` saved.
 */
export function addDeviceMark(m: Mark, screenId: string) {
  const st = useStore.getState();
  const cap = st.captures.get(screenId);
  if (!cap) throw new Error("the captured screen didn't load");
  const { w, h } = cap.root.bounds;
  st.add(toAnnotation(m, screenId, w, h));
}

const MARK = "#ff5a36";
const bbox = (pts: Pt[]) => {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
};

/** Where a mark's number goes (fractions of the pad). */
const badgeAt = (g: Geometry): Pt =>
  g.type === "point" ? [g.x, g.y] : g.type === "arrow" ? g.from : g.type === "rect" ? [g.x, g.y] : [bbox(g.points).x, bbox(g.points).y];

/** One mark in SVG, in fractions of the pad (the SVG's viewBox is 0..1, so lines keep their width with `vector-effect`). */
function MarkShape({ m, faint }: { m: Mark; faint?: boolean }) {
  const g = m.geometry;
  return (
    <g className={faint ? "faint" : undefined}>
      {g.type === "path" && <polyline className="mk-loop" points={g.points.map((p) => p.join(",")).join(" ")} />}
      {g.type === "rect" && m.kind !== "sketch" && <rect className="mk-box" x={g.x} y={g.y} width={g.w} height={g.h} />}
      {g.type === "arrow" && <line className="mk-loop" x1={g.from[0]} y1={g.from[1]} x2={g.to[0]} y2={g.to[1]} />}
      {m.kind === "remove" && g.type === "point" && <circle className="mk-loop" cx={g.x} cy={g.y} r={0.012} />}
      {m.strokes?.map((s, i) => (
        <polyline key={i} className="mk-ink" stroke={s.color} points={s.points.map((p) => p.join(",")).join(" ")} />
      ))}
    </g>
  );
}

/**
 * Drawing marks over the device's frozen picture. `onMark` gets each finished mark
 * in fractions of the screen; `marks` are the ones made in this session (shown faint
 * until they're saved).
 */
export function MarkPad({ tool, marks, onMark, drawColor }: { tool: MarkTool; marks: Mark[]; onMark: (m: Mark) => void; drawColor: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [cur, setCur] = useState<Pt[] | null>(null);
  const [held, setHeld] = useState<Omit<Mark, "text"> | null>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);

  const frac = (e: { clientX: number; clientY: number }): Pt => {
    const r = ref.current!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };

  // another tool: what was being drawn is dropped
  useEffect(() => {
    setCur(null);
    setHeld(null);
    setStrokes([]);
  }, [tool]);
  useEffect(() => {
    if (held) setTimeout(() => input.current?.focus(), 0);
  }, [held]);

  const finish = (pts: Pt[]) => {
    const a = pts[0]!, b = pts[pts.length - 1]!;
    const bb = bbox(pts);
    const big = Math.max(bb.w, bb.h) > 0.01;
    setText("");
    if (tool === "comment" || tool === "remove") return setHeld({ kind: tool, geometry: { type: "point", x: b[0], y: b[1] } });
    if (!big) return;
    if (tool === "circle") return setHeld({ kind: "circle", geometry: { type: "path", points: pts } });
    if (tool === "arrow") return setHeld({ kind: "arrow", geometry: { type: "arrow", from: a, to: b } });
    if (tool === "rectangle") return setHeld({ kind: "rectangle", geometry: { type: "rect", ...bbox([a, b]) } });
    if (tool === "draw") setStrokes((s) => [...s, { points: pts, color: drawColor, width: 4 }]);
  };
  const finishDrawing = () => {
    if (!strokes.length) return;
    const b = bbox(strokes.flatMap((s) => s.points));
    setHeld({ kind: "sketch", geometry: { type: "rect", ...b }, strokes });
    setStrokes([]);
    setText("");
  };
  const commit = () => {
    if (!held) return;
    if (held.kind === "comment" && !text.trim()) return setHeld(null);
    onMark({ ...held, text: text.trim() });
    setHeld(null);
  };

  const notePos = (() => {
    if (!held) return null;
    const g = held.geometry;
    const p: Pt = g.type === "point" ? [g.x, g.y] : g.type === "arrow" ? g.to : g.type === "rect" ? [g.x + g.w, g.y + g.h] : (() => {
      const b = bbox(g.points);
      return [b.x + b.w, b.y + b.h] as Pt;
    })();
    return { left: `${Math.min(70, p[0] * 100)}%`, top: `${Math.min(90, p[1] * 100 + 2)}%` };
  })();
  const lastStroke = strokes[strokes.length - 1]?.points.at(-1);

  return (
    <div
      ref={ref}
      className="mark-pad"
      tabIndex={-1}
      onPointerDown={(e) => {
        if (e.button !== 0 || held) return;
        (e.target as Element).setPointerCapture(e.pointerId);
        setCur([frac(e)]);
      }}
      onPointerMove={(e) => {
        if (!cur) return;
        const p = frac(e);
        setCur(tool === "circle" || tool === "draw" ? [...cur, p] : [cur[0]!, p]);
      }}
      onPointerUp={(e) => {
        if (!cur) return;
        const pts = tool === "circle" || tool === "draw" ? cur : [cur[0]!, frac(e)];
        setCur(null);
        finish(pts);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && strokes.length && !held) {
          e.stopPropagation();
          finishDrawing();
        }
      }}
    >
      <svg viewBox="0 0 1 1" preserveAspectRatio="none">
        {marks.map((m, i) => (
          <MarkShape key={i} m={m} />
        ))}
        {held && <MarkShape m={{ ...held, text: "" }} faint />}
        {strokes.map((s, i) => (
          <polyline key={`s${i}`} className="mk-ink" stroke={s.color} points={s.points.map((p) => p.join(",")).join(" ")} />
        ))}
        {cur &&
          (tool === "rectangle" ? (
            <rect className="mk-box" {...(() => { const b = bbox([cur[0]!, cur[cur.length - 1]!]); return { x: b.x, y: b.y, width: b.w, height: b.h }; })()} />
          ) : tool === "arrow" ? (
            <line className="mk-loop" x1={cur[0]![0]} y1={cur[0]![1]} x2={cur[cur.length - 1]![0]} y2={cur[cur.length - 1]![1]} />
          ) : (
            <polyline className={tool === "draw" ? "mk-ink" : "mk-loop"} stroke={tool === "draw" ? drawColor : MARK} points={cur.map((p) => p.join(",")).join(" ")} />
          ))}
      </svg>
      {[...marks, ...(held ? [held] : [])].map((m, i) => {
        const [x, y] = badgeAt(m.geometry);
        return (
          <span key={`b${i}`} className={`mk-badge ${i === marks.length ? "faint" : ""}`} style={{ left: `${x * 100}%`, top: `${y * 100}%` }}>
            {i + 1}
          </span>
        );
      })}
      {lastStroke && !held && (
        <button className="mark-done" style={{ left: `${Math.min(80, lastStroke[0] * 100)}%`, top: `${Math.min(92, lastStroke[1] * 100 + 2)}%` }} onClick={finishDrawing}>
          Done ⏎
        </button>
      )}
      {held && notePos && (
        <div className="mark-note" style={notePos} onPointerDown={(e) => e.stopPropagation()}>
          <input
            ref={input}
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={held.kind === "comment" ? "Type your note, then ⏎" : "Add a note (optional), then ⏎"}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" && !e.nativeEvent.isComposing) commit();
              else if (e.key === "Escape") setHeld(null);
            }}
          />
          <button onClick={commit}>Add</button>
        </div>
      )}
    </div>
  );
}
