import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { bboxOf, indexFor, type Annotation, type Rect } from "@intentcue/core";
import { worldToScreen, type TileLayout } from "../layout";
import { describeElement, elementOf, isReadOnly, useCapturingScreens, useMarkers, useStore } from "../store";
import { annotationFromInk, focusTile } from "./Board";

type Pt = [number, number];

/** Everything drawn in screen space at a constant size: labels, chips, popovers. */
export function Overlay({ boardRef }: { boardRef: RefObject<HTMLDivElement | null> }) {
  const tiles = useStore((s) => s.tiles);
  const camera = useStore((s) => s.camera);
  const round = useStore((s) => s.round);
  const annotations = useStore((s) => s.annotations);
  const selectedId = useStore((s) => s.selectedId);
  const hover = useStore((s) => s.hover);
  const editor = useStore((s) => s.editor);
  const picker = useStore((s) => s.picker);
  const focusId = useStore((s) => s.focusId);
  const tool = useStore((s) => s.tool);
  const removeAsk = useStore((s) => s.removeAsk);
  const ro = !round || round.status.status === "sent" || round.status.status === "applied";
  const capturing = useCapturingScreens();
  const { markers, rules } = useMarkers();
  const byTile = new Map(tiles.map((t) => [t.id, t]));
  const S = (t: TileLayout, p: Pt): Pt => worldToScreen(camera, t.x + p[0] / t.scale, t.y + p[1] / t.scale);
  const vp = boardRef.current?.getBoundingClientRect();
  const vw = vp?.width ?? 2000;
  const vh = vp?.height ?? 2000;
  const counts = new Map<string, number>();
  for (const a of annotations) if (a.kind !== "comment" || !a.attachedTo) counts.set(a.screenId, (counts.get(a.screenId) ?? 0) + 1);

  return (
    <div className="overlay">
      {tiles.map((t) => {
        const info = round?.screens.find((s) => s.id === t.id);
        const [x, y] = worldToScreen(camera, t.x, t.y);
        const w = t.w * camera.zoom;
        if (x > vw || y > vh + 40 || x + w < 0 || y < -2000 || w < 56) return null;
        const n = counts.get(t.id) ?? 0;
        return (
          <div
            key={t.id}
            className="tile-label"
            style={{ left: x, top: y, ["--w" as string]: `${w}px` }}
            onClick={() => focusTile(t.id)}
            title="focus (double-click the tile)"
          >
            <span className="t">{info?.title ?? t.id}</span>
            {w > 170 && removeAsk !== t.id && (
              <span className="m">
                {info?.platform ?? "—"} · {info?.device ? `${info.device.width}×${info.device.height}` : ""}
              </span>
            )}
            {n > 0 && removeAsk !== t.id && <span className="n">{n}●</span>}
            {!ro &&
              w > 90 &&
              (removeAsk === t.id ? (
                <span className="remove-ask" onClick={(e) => e.stopPropagation()}>
                  {n > 0 ? `remove with ${n} note${n === 1 ? "" : "s"}?` : "remove?"}
                  <span role="button" className="yes" onClick={() => void useStore.getState().removeScreen(t.id)}>
                    remove ⏎
                  </span>
                  <span role="button" onClick={() => useStore.getState().set({ removeAsk: null })}>
                    cancel
                  </span>
                </span>
              ) : (
                <span
                  role="button"
                  className="remove"
                  title="remove this view from the round (Delete on a focused view)"
                  onClick={(e) => {
                    e.stopPropagation();
                    useStore.getState().set({ removeAsk: t.id });
                  }}
                >
                  ✕
                </span>
              ))}
            {capturing.has(t.id) ? (
              <span className="stale busy">capturing…</span>
            ) : (
              info?.reusedFrom !== undefined &&
              w > 90 && (
                <span className="stale" title={`Not recaptured: copied unchanged from round ${pad(info.reusedFrom)}. Click to recapture.`}>
                  <span
                    role="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void useStore.getState().recapture([t.id]);
                    }}
                  >
                    ↺ R{pad(info.reusedFrom)}
                  </span>
                </span>
              )
            )}
          </div>
        );
      })}

      {annotations.map((a) => {
        const t = byTile.get(a.screenId);
        if (!t) return null;
        if (a.kind === "comment" && a.attachedTo) return null;
        const tileW = t.w * camera.zoom;
        const res = a.resolution;
        const unresolved = res?.status === "unresolved" && a.kind !== "rule";
        const show = unresolved || a.id === selectedId || (tileW > 230 && (!focusId || focusId === a.screenId));
        if (!show) return null;
        const b = annBounds(a);
        const [sx, sy] = S(t, [b.x, b.y + b.h]);
        if (sx > vw || sy > vh || sx < -300 || sy < -40) return null;
        const label = chipText(a);
        const num = a.kind === "rule" ? `U${rules.get(a.id) ?? "?"}` : String(markers.get(a.id) ?? "");
        return (
          <div
            key={a.id}
            className={tool === "select" ? "" : "passive"}
            style={{ position: "absolute", left: sx, top: sy + 6, display: "flex", gap: 4 }}
          >
            <button
              className={`chip ${unresolved ? "warn" : res?.status === "region" ? "region" : ""} ${res?.confirmedByUser ? "confirmed" : ""}`}
              style={{ position: "static" }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => {
                const st = useStore.getState();
                st.select(a.id);
                if (!isReadOnly() && a.kind !== "rule") st.set({ picker: { annotationId: a.id } });
              }}
              title="change target"
            >
              <span className="arrow">{num}</span>
              {label}
            </button>
            {a.ink && !isReadOnly() && (
              <KindChip a={a} />
            )}
          </div>
        );
      })}

      {hover && byTile.get(hover.screenId) && (() => {
        const t = byTile.get(hover.screenId)!;
        const el = hover.stack[hover.level];
        if (!el) return null;
        const [x, y] = S(t, [el.bounds.x, el.bounds.y]);
        return (
          <div className="hover-label" style={{ left: Math.max(0, x), top: Math.max(18, y) }}>
            {describeElement(el)}
            <span className="lv">
              {Math.round(el.bounds.w / t.scale)}×{Math.round(el.bounds.h / t.scale)}
              {hover.stack.length > 1 ? ` · alt ↑ ${hover.level + 1}/${hover.stack.length}` : ""}
            </span>
          </div>
        );
      })()}

      {editor && <Editor key={editor.annotationId} id={editor.annotationId} isNew={editor.isNew} toScreen={S} tiles={byTile} />}
      {picker && <Picker key={picker.annotationId} id={picker.annotationId} toScreen={S} tiles={byTile} />}
    </div>
  );
}

export function annBounds(a: Annotation): Rect {
  const g = a.geometry;
  let b: Rect =
    g.type === "point" ? { x: g.x, y: g.y, w: 0, h: 0 } : g.type === "rect" ? g : g.type === "arrow" ? bboxOf([g.from, g.to]) : bboxOf(g.points);
  if (a.ink) b = bboxOf([[b.x, b.y], [b.x + b.w, b.y + b.h], ...a.ink.strokes.flatMap((s) => s.points)]);
  if (g.type === "arrow" && g.toScreenId && g.toScreenId !== a.screenId) b = { x: g.from[0], y: g.from[1], w: 0, h: 0 };
  return b;
}

function chipText(a: Annotation): string {
  const res = a.resolution;
  if (!res || res.status === "unresolved") return a.kind === "rule" ? "no targets" : "unresolved: pick a target";
  if (a.kind === "rule") return `${res.elements.length} example${res.elements.length === 1 ? "" : "s"}`;
  const first = res.elements[0];
  let s = "";
  if (first) {
    const el = elementOf(a.screenId, first);
    s = el ? describeElement(el) : first;
    if (res.elements.length > 1) s += ` +${res.elements.length - 1}`;
  } else if (res.region) {
    s = res.region.w > 1 ? `area ${res.region.w}×${res.region.h}` : `point ${res.region.x},${res.region.y}`;
  }
  const g = a.geometry;
  if (a.kind === "arrow" && g.type === "arrow") {
    const toScreen = g.toScreenId ?? a.screenId;
    const dest = res.toElements?.[0] ? elementOf(toScreen, res.toElements[0]) : null;
    const tail = dest ? describeElement(dest) : res.region ? `area ${res.region.x},${res.region.y}` : "";
    const other = g.toScreenId && g.toScreenId !== a.screenId ? `${g.toScreenId}:` : "";
    return `${s} → ${other}${tail}`;
  }
  return s;
}

const KINDS = [
  ["circle", "◯ circle"],
  ["arrow", "→ arrow"],
  ["remove", "✕ remove"],
  ["handwriting", "✎ note"],
  ["freehand", "∿ draw"],
] as const;

function KindChip({ a }: { a: Annotation }) {
  const [open, setOpen] = useState(false);
  const cur = a.kind === "comment" ? "handwriting" : a.kind;
  return (
    <div style={{ position: "relative" }}>
      <button
        className="chip kind"
        style={{ position: "static" }}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => setOpen((o) => !o)}
        title="change what this stroke is"
      >
        {KINDS.find((k) => k[0] === cur)?.[1] ?? cur} ▾
      </button>
      {open && (
        <div className="popover menu" style={{ top: "100%", left: 0, minWidth: 140 }} onPointerDown={(e) => e.stopPropagation()}>
          {KINDS.map(([k, label]) => (
            <button
              key={k}
              className={k === cur ? "cur" : ""}
              onClick={() => {
                setOpen(false);
                if (!a.ink) return;
                const st = useStore.getState();
                const rebuilt = annotationFromInk(a.screenId, k, a.ink, undefined, a.id);
                if (a.text) rebuilt.text = a.text;
                st.commit(st.annotations.map((x) => (x.id === a.id ? rebuilt : x)), { select: a.id });
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ───────── text editor ───────── */

function Editor({
  id,
  isNew,
  toScreen,
  tiles,
}: {
  id: string;
  isNew: boolean;
  toScreen: (t: TileLayout, p: Pt) => Pt;
  tiles: Map<string, TileLayout>;
}) {
  const a = useStore((s) => s.annotations.find((x) => x.id === id));
  const { markers, rules } = useMarkers();
  const [text, setText] = useState(a?.text ?? "");
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });

  const t = a ? tiles.get(a.screenId) : undefined;
  const b = a ? annBounds(a) : { x: 0, y: 0, w: 0, h: 0 };
  const anchor = t ? toScreen(t, [b.x + b.w, b.y]) : ([0, 0] as Pt);

  useLayoutEffect(() => {
    const parent = boxRef.current?.parentElement?.getBoundingClientRect();
    const w = boxRef.current?.offsetWidth ?? 300;
    const h = boxRef.current?.offsetHeight ?? 120;
    let left = anchor[0] + 14;
    let top = anchor[1] - 8;
    if (parent) {
      if (left + w > parent.width - 8) left = Math.max(8, anchor[0] - w - 30);
      top = Math.min(Math.max(8, top), parent.height - h - 8);
    }
    setPos({ left, top });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor[0], anchor[1]]);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  if (!a || !t) return null;

  const commit = (cancel = false) => {
    if (done.current) return;
    done.current = true;
    const st = useStore.getState();
    const trimmed = text.trim();
    const needsText = a.kind === "comment" || a.kind === "rule";
    if ((cancel && isNew && needsText && !a.ink) || (needsText && !trimmed && !a.ink)) {
      st.remove(a.id);
    } else if ((a.text ?? "") !== trimmed) {
      st.update(a.id, (x) => {
        const n = { ...x };
        if (trimmed) n.text = trimmed;
        else delete n.text;
        return n;
      });
    }
    st.set({ editor: null });
    document.querySelector<HTMLElement>(".board")?.focus();
  };

  const target = chipText(a);
  const num = a.kind === "rule" ? `U${rules.get(a.id) ?? ""}` : String(markers.get(a.id) ?? "");

  return (
    <div
      ref={boxRef}
      className="popover"
      style={{ left: pos.left, top: pos.top }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="head">
        <span>
          <b>{num}</b> {a.kind === "rule" ? "rule for all screens" : a.kind}
        </span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 200 }}>{target}</span>
      </div>
      <textarea
        ref={ref}
        value={text}
        placeholder={
          a.kind === "rule"
            ? "e.g. Primary buttons are full width, 48pt tall"
            : a.kind === "comment"
              ? "What should change?"
              : "Optional: what should change?"
        }
        onChange={(e) => setText(e.target.value)}
        onBlur={() => commit()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            commit(true);
          }
        }}
      />
      <div className="foot">
        <span>
          <kbd>⏎</kbd> save
        </span>
        <span>
          <kbd>⇧⏎</kbd> newline
        </span>
        <span>
          <kbd>esc</kbd> {isNew && (a.kind === "comment" || a.kind === "rule") ? "discard" : "close"}
        </span>
      </div>
    </div>
  );
}

/* ───────── target picker ───────── */

function Picker({ id, toScreen, tiles }: { id: string; toScreen: (t: TileLayout, p: Pt) => Pt; tiles: Map<string, TileLayout> }) {
  const a = useStore((s) => s.annotations.find((x) => x.id === id));
  const tree = useStore((s) => (a ? s.trees.get(a.screenId) : undefined));
  if (!a || !tree) return null;
  const t = tiles.get(a.screenId);
  if (!t) return null;
  const idx = indexFor(tree);
  const b = annBounds(a);
  const [x, y] = toScreen(t, [b.x, b.y + b.h]);
  const cur = a.resolution?.elements[0] ? idx.get(a.resolution.elements[0]) : undefined;
  const parents = cur ? idx.ancestors(cur.id).filter((e) => e !== tree).slice(0, 5) : [];
  const children = cur ? cur.children.slice(0, 12) : [];
  // no target yet: offer what is under the annotation
  const under = !cur
    ? idx
        .stackAt(b.x + b.w / 2, b.y + b.h / 2)
        .map((f) => f.el)
        .filter((e) => e !== tree)
        .slice(0, 8)
    : [];

  const pick = (elementId: string | null) => {
    const st = useStore.getState();
    const res =
      elementId === null
        ? { status: "region" as const, elements: [], region: roundRect(b.w > 1 ? b : { x: b.x - 20, y: b.y - 20, w: 40, h: 40 }), confirmedByUser: true }
        : { status: "resolved" as const, elements: [elementId], confirmedByUser: true, ...(a.resolution?.toElements ? { toElements: a.resolution.toElements } : {}) };
    st.update(a.id, { resolution: res });
    st.set({ picker: null, flash: { screenId: a.screenId, ids: elementId ? [elementId] : [], region: res.region, until: Date.now() + 1500 } });
  };
  const reset = () => {
    const st = useStore.getState();
    st.update(a.id, (x) => {
      const n = { ...x };
      delete n.resolution;
      return n;
    });
    st.set({ picker: null });
  };

  return (
    <div className="popover" style={{ left: x, top: y + 30 }} onPointerDown={(e) => e.stopPropagation()}>
      <div className="head">
        <span>
          <b>target</b> for {a.kind}
        </span>
        <span>
          <kbd>esc</kbd>
        </span>
      </div>
      <div className="menu">
        {cur && (
          <>
            <div className="label">current</div>
            <button className="cur" onClick={() => pick(cur.id)}>
              <span className="g">●</span>
              {describeElement(cur)}
            </button>
          </>
        )}
        {parents.length > 0 && <div className="label">parent</div>}
        {parents.map((p, i) => (
          <button key={p.id} onClick={() => pick(p.id)}>
            <span className="g">{"↑".repeat(Math.min(i + 1, 3))}</span>
            {describeElement(p)}
          </button>
        ))}
        {children.length > 0 && <div className="label">children</div>}
        {children.map((c) => (
          <button key={c.id} onClick={() => pick(c.id)}>
            <span className="g">↓</span>
            {describeElement(c)}
          </button>
        ))}
        {under.length > 0 && <div className="label">under the mark</div>}
        {under.map((c) => (
          <button key={c.id} onClick={() => pick(c.id)}>
            <span className="g">·</span>
            {describeElement(c)}
          </button>
        ))}
        <div className="label">other</div>
        <button onClick={() => pick(null)}>
          <span className="g">□</span>empty area
        </button>
        {a.resolution?.confirmedByUser && (
          <button onClick={reset}>
            <span className="g">↺</span>auto (re-resolve)
          </button>
        )}
      </div>
    </div>
  );
}

const pad = (n: number) => String(n).padStart(3, "0");

const roundRect = (r: Rect): Rect => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) });
