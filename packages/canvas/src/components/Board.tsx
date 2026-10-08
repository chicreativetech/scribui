import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ACCENT,
  bboxOf,
  classifyStrokes,
  indexFor,
  newAnnotationId,
  renderAnnotationSvg,
  renderShapeSvg,
  strokeOutlinePath,
  type Annotation,
  type InkData,
  type InkStroke,
  type UIElement,
} from "@scribui/core";
import { fitCamera, quantize, screenToWorld, type Camera, type TileLayout } from "../layout";
import { isReadOnly, tileOf, useMarkers, useStore } from "../store";
import { measureText } from "../vision";
import { Overlay } from "./Overlay";
import { Tile } from "./Tile";

type Pt = [number, number];

type Drag =
  | { kind: "pan"; sx: number; sy: number; cam: Camera; moved: boolean; clickTile?: TileLayout; clickPx?: Pt }
  | { kind: "path"; tool: "circle" | "freehand"; tile: TileLayout; pts: Pt[] }
  | { kind: "rect"; tile: TileLayout; from: Pt; to: Pt }
  | { kind: "sketch"; shape: "line" | "box" | "ellipse"; tile: TileLayout; from: Pt; to: Pt }
  | { kind: "arrow"; tile: TileLayout; from: Pt; toWorld: Pt }
  | { kind: "move"; id: string; tile: TileLayout; start: Pt; orig: Annotation; moved: boolean }
  | { kind: "pen"; tile: TileLayout; pts: [number, number, number][]; t0: number };

type PenGroup = { tile: TileLayout; strokes: InkStroke[]; timer: ReturnType<typeof setTimeout> | null };

const PEN_WAIT_MS = 450;
const HANDWRITING_WAIT_MS = 1100;

export function Board() {
  const ref = useRef<HTMLDivElement>(null);
  const tiles = useStore((s) => s.tiles);
  const groups = useStore((s) => s.groups);
  const camera = useStore((s) => s.camera);
  const tool = useStore((s) => s.tool);
  const round = useStore((s) => s.round);
  const annotations = useStore((s) => s.annotations);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [space, setSpace] = useState(false);
  const touches = useRef(new Map<number, Pt>());
  const pinch = useRef<{ d: number; mid: Pt; cam: Camera } | null>(null);
  const penActive = useRef(false);
  const penGroup = useRef<PenGroup | null>(null);
  const [penDraft, setPenDraft] = useState<{ tile: TileLayout; strokes: [number, number, number][][] } | null>(null);
  const didInitialFit = useRef<number | null>(null);

  const setDragBoth = (d: Drag | null) => {
    dragRef.current = d;
    setDrag(d);
  };

  /* ───────── coordinates ───────── */

  const local = useCallback((e: { clientX: number; clientY: number }): Pt => {
    const r = ref.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }, []);

  const toWorld = useCallback(
    (e: { clientX: number; clientY: number }): Pt => {
      const [sx, sy] = local(e);
      return screenToWorld(useStore.getState().camera, sx, sy);
    },
    [local],
  );

  const tileAt = (w: Pt): TileLayout | undefined =>
    useStore
      .getState()
      .tiles.find((t) => w[0] >= t.x && w[0] <= t.x + t.w && w[1] >= t.y && w[1] <= t.y + t.h);

  /** The tile under a point, or the nearest one within `margin` world units (strokes may start just outside). */
  const tileNear = (w: Pt, margin = 40): TileLayout | undefined => {
    const hit = tileAt(w);
    if (hit) return hit;
    let best: { t: TileLayout; d: number } | undefined;
    for (const t of useStore.getState().tiles) {
      const dx = Math.max(t.x - w[0], 0, w[0] - (t.x + t.w));
      const dy = Math.max(t.y - w[1], 0, w[1] - (t.y + t.h));
      const d = Math.hypot(dx, dy);
      if (d <= margin && (!best || d < best.d)) best = { t, d };
    }
    return best?.t;
  };

  const toPx = (t: TileLayout, w: Pt): Pt => [
    Math.round((w[0] - t.x) * t.scale * 10) / 10,
    Math.round((w[1] - t.y) * t.scale * 10) / 10,
  ];

  /* ───────── initial fit ───────── */

  useEffect(() => {
    if (!round || !ref.current || tiles.length === 0) return;
    if (didInitialFit.current === round.round) return;
    didInitialFit.current = round.round;
    useStore.getState().setCamera(fitAll(tiles, groups, boardViewport()));
  }, [round, tiles, groups]);

  /* ───────── wheel: pan, ctrl/⌘ + wheel or pinch: zoom ───────── */

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const st = useStore.getState();
      const [sx, sy] = local(e);
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0022));
        st.setCamera((c) => zoomAt(c, sx, sy, c.zoom * factor));
      } else {
        const k = e.deltaMode === 1 ? 16 : 1;
        st.setCamera((c) => ({ ...c, x: c.x + (e.deltaX * k) / c.zoom, y: c.y + (e.deltaY * k) / c.zoom }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    // Safari trackpad pinch
    const onGesture = (e: Event) => e.preventDefault();
    el.addEventListener("gesturestart", onGesture);
    el.addEventListener("gesturechange", onGesture);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGesture);
      el.removeEventListener("gesturechange", onGesture);
    };
  }, [local]);

  /* ───────── space to pan, alt to cycle ───────── */

  useEffect(() => {
    const typing = (e: KeyboardEvent) =>
      e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    const down = (e: KeyboardEvent) => {
      if (typing(e)) return;
      if (e.code === "Space") {
        e.preventDefault();
        setSpace(true);
      }
      if (e.key === "Alt") {
        e.preventDefault();
        const st = useStore.getState();
        if (st.hover) {
          const next = (st.hover.level + 1) % st.hover.stack.length;
          st.set({ hover: { ...st.hover, level: next } });
        }
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpace(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  /* ───────── hover ───────── */

  const updateHover = (w: Pt) => {
    const st = useStore.getState();
    const t = tileAt(w);
    if (!t) {
      if (st.hover || st.cursorPx) st.set({ hover: null, cursorPx: null });
      return;
    }
    const px = toPx(t, w);
    const cursorPx = { screenId: t.id, x: Math.round(px[0]), y: Math.round(px[1]) };
    const wantsHover = ["select", "comment", "remove", "rule"].includes(st.tool);
    const tree = st.trees.get(t.id);
    if (!wantsHover || !tree) {
      st.set({ hover: null, cursorPx });
      return;
    }
    const idx = indexFor(tree);
    const stack = idx
      .stackAt(px[0], px[1])
      .map((f) => f.el)
      .filter((el) => el !== tree);
    const prev = st.hover;
    const sameDeepest = prev && prev.screenId === t.id && prev.stack[0] === stack[0];
    st.set({
      cursorPx,
      hover: stack.length ? { screenId: t.id, stack, level: sameDeepest ? Math.min(prev.level, stack.length - 1) : 0, px } : null,
    });
  };

  const hoveredElement = (screenId: string): UIElement | null => {
    const h = useStore.getState().hover;
    if (!h || h.screenId !== screenId) return null;
    return h.stack[h.level] ?? null;
  };

  /* ───────── pointer handling ───────── */

  const onPointerDown = (e: React.PointerEvent) => {
    const st = useStore.getState();
    if (st.editor || st.picker) {
      // clicking the board closes popovers (commit happens in the editor's blur)
      st.set({ picker: null });
    }
    const target = e.target as Element;
    if (target.closest(".overlay > *")) return;
    // we manage focus ourselves; the default would steal it from a just-opened editor
    e.preventDefault();
    ref.current?.focus({ preventScroll: true });
    const w = toWorld(e);
    const [sx, sy] = local(e);

    // touch: pans/zooms in pen mode, pinch always
    if (e.pointerType === "touch") {
      if (penActive.current) return; // palm rejection
      touches.current.set(e.pointerId, [sx, sy]);
      capture(e);
      if (touches.current.size === 2) {
        const [a, b] = [...touches.current.values()] as [Pt, Pt];
        pinch.current = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], cam: st.camera };
        setDragBoth(null);
        return;
      }
      if (st.penMode) {
        setDragBoth({ kind: "pan", sx, sy, cam: st.camera, moved: false });
        return;
      }
    }

    if (e.pointerType === "pen" && !isReadOnly()) {
      if (!st.penMode) {
        st.set({ penMode: true });
        st.toast({ text: "pen mode on: pen draws, fingers pan and zoom", tone: "info" });
      }
      const t = tileNear(w);
      if (!t) return;
      penActive.current = true;
      capture(e);
      const p = toPx(t, w);
      setDragBoth({ kind: "pen", tile: t, pts: [[p[0], p[1], e.pressure || 0.5]], t0: performance.now() });
      if (penGroup.current?.timer) clearTimeout(penGroup.current.timer);
      return;
    }

    if (e.button === 1 || space || e.button === 2) {
      setDragBoth({ kind: "pan", sx, sy, cam: st.camera, moved: false });
      capture(e);
      return;
    }
    if (e.button !== 0) return;

    const drawsFreely = st.tool === "circle" || st.tool === "freehand" || st.tool === "rectangle" || st.tool === "arrow";
    const t = drawsFreely ? tileNear(w) : tileAt(w);
    const annEl = target.closest("[data-ann-id]");
    const ro = isReadOnly();
    capture(e);

    if (st.tool === "select" || ro) {
      if (annEl) {
        const id = annEl.getAttribute("data-ann-id")!;
        const a = st.annotations.find((x) => x.id === id);
        st.select(id);
        if (a && t && !ro) setDragBoth({ kind: "move", id, tile: tileOf(a.screenId) ?? t, start: w, orig: a, moved: false });
        return;
      }
      setDragBoth({ kind: "pan", sx, sy, cam: st.camera, moved: false, clickTile: t, clickPx: t ? toPx(t, w) : undefined });
      return;
    }
    if (!t) {
      setDragBoth({ kind: "pan", sx, sy, cam: st.camera, moved: false });
      return;
    }
    const px = toPx(t, w);
    switch (st.tool) {
      case "comment": {
        const a: Annotation = { id: newAnnotationId(), screenId: t.id, kind: "comment", geometry: { type: "point", x: px[0], y: px[1] } };
        if (annEl) a.attachedTo = annEl.getAttribute("data-ann-id")!;
        st.add(a, { edit: true });
        break;
      }
      case "remove": {
        const el = hoveredElement(t.id);
        const a: Annotation = { id: newAnnotationId(), screenId: t.id, kind: "remove", geometry: { type: "point", x: px[0], y: px[1] } };
        const h = st.hover;
        if (el && h && h.level > 0) a.resolution = { status: "resolved", elements: [el.id], confirmedByUser: true };
        st.add(a);
        break;
      }
      case "rule": {
        const el = hoveredElement(t.id);
        if (!el) break;
        const key = { screenId: t.id, elementId: el.id };
        const has = st.ruleTargets.some((r) => r.screenId === key.screenId && r.elementId === key.elementId);
        const next = e.shiftKey || st.ruleTargets.length > 0
          ? has
            ? st.ruleTargets.filter((r) => !(r.screenId === key.screenId && r.elementId === key.elementId))
            : [...st.ruleTargets, key]
          : [key];
        st.set({ ruleTargets: next });
        break;
      }
      case "circle":
      case "freehand":
        setDragBoth({ kind: "path", tool: st.tool, tile: t, pts: [px] });
        break;
      case "rectangle":
        setDragBoth({ kind: "rect", tile: t, from: px, to: px });
        break;
      case "arrow":
        setDragBoth({ kind: "arrow", tile: t, from: px, toWorld: w });
        break;
      case "line":
      case "box":
      case "ellipse":
        setDragBoth({ kind: "sketch", shape: st.tool, tile: t, from: px, to: px });
        break;
      case "text": {
        // sketch styles are set in points; annotations live in screenshot pixels
        const style = st.toolStyles.text;
        const size = (style.size ?? 32) * t.scale;
        const box = measureText("", size);
        st.add(
          {
            id: newAnnotationId(),
            screenId: t.id,
            kind: "sketch",
            geometry: { type: "rect", x: px[0], y: Math.round(px[1] - size * 0.62), w: box.w, h: box.h },
            sketch: { shape: "text", style: { ...style, size } },
          },
          { edit: true },
        );
        break;
      }
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const st = useStore.getState();
    const [sx, sy] = local(e);
    const w = toWorld(e);

    if (e.pointerType === "touch" && touches.current.has(e.pointerId)) {
      touches.current.set(e.pointerId, [sx, sy]);
      if (touches.current.size === 2 && pinch.current) {
        const [a, b] = [...touches.current.values()] as [Pt, Pt];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const p = pinch.current;
        const zoom = clampZoom(p.cam.zoom * (d / p.d));
        // keep the world point under the initial midpoint under the current midpoint
        const wx = p.mid[0] / p.cam.zoom + p.cam.x;
        const wy = p.mid[1] / p.cam.zoom + p.cam.y;
        st.setCamera({ zoom, x: wx - mid[0] / zoom, y: wy - mid[1] / zoom });
        return;
      }
    }

    const d = dragRef.current;
    if (!d) {
      if (e.pointerType !== "touch") updateHover(w);
      return;
    }
    switch (d.kind) {
      case "pan": {
        const dx = sx - d.sx;
        const dy = sy - d.sy;
        if (!d.moved && Math.hypot(dx, dy) < 4) return;
        d.moved = true;
        st.setCamera({ ...d.cam, x: d.cam.x - dx / d.cam.zoom, y: d.cam.y - dy / d.cam.zoom });
        setDrag({ ...d });
        return;
      }
      case "path": {
        const p = toPx(d.tile, w);
        const last = d.pts[d.pts.length - 1]!;
        if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 1.5 * d.tile.scale) return;
        const next = { ...d, pts: [...d.pts, p] };
        setDragBoth(next);
        return;
      }
      case "pen": {
        const p = toPx(d.tile, w);
        const events = typeof e.nativeEvent.getCoalescedEvents === "function" ? e.nativeEvent.getCoalescedEvents() : [e.nativeEvent];
        const pts = [...d.pts];
        for (const ev of events.length ? events : [e.nativeEvent]) {
          const q = toPx(d.tile, toWorld(ev));
          pts.push([q[0], q[1], ev.pressure || 0.5]);
        }
        if (!events.length) pts.push([p[0], p[1], e.pressure || 0.5]);
        setDragBoth({ ...d, pts });
        return;
      }
      case "rect":
        setDragBoth({ ...d, to: toPx(d.tile, w) });
        return;
      case "sketch":
        setDragBoth({ ...d, to: constrainPx(d.shape, d.from, toPx(d.tile, w), e.shiftKey) });
        return;
      case "arrow":
        setDragBoth({ ...d, toWorld: w });
        return;
      case "move": {
        const dx = (w[0] - d.start[0]) * d.tile.scale;
        const dy = (w[1] - d.start[1]) * d.tile.scale;
        if (!d.moved && Math.hypot(dx, dy) < 3 * d.tile.scale) return;
        d.moved = true;
        // live preview without history: mutate a transient copy in store
        const moved = translate(d.orig, dx, dy);
        st.set({ annotations: st.annotations.map((a) => (a.id === d.id ? moved : a)) });
        return;
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const st = useStore.getState();
    if (e.pointerType === "touch") {
      touches.current.delete(e.pointerId);
      if (touches.current.size < 2) pinch.current = null;
    }
    const d = dragRef.current;
    setDragBoth(null);
    if (!d) return;
    const w = toWorld(e);

    switch (d.kind) {
      case "pan": {
        if (!d.moved && d.clickTile && d.clickPx && e.pointerType !== "touch") {
          // a click in select mode picks an element
          const el = hoveredElement(d.clickTile.id);
          st.set({ selectedElement: el ? { screenId: d.clickTile.id, elementId: el.id } : null, selectedId: null });
          if (el && st.inspectorTab !== "tree" && st.inspectorOpen && st.selectedId === null) {
            /* keep current tab; tree tab shows it */
          }
        } else if (!d.moved) {
          st.set({ selectedId: null, selectedElement: null });
        }
        return;
      }
      case "path": {
        if (d.pts.length < 3) return;
        const pts = d.pts;
        const a: Annotation = { id: newAnnotationId(), screenId: d.tile.id, kind: d.tool, geometry: { type: "path", points: pts } };
        st.add(a, { edit: true });
        return;
      }
      case "rect": {
        const r = normRect(d.from, d.to);
        if (r.w < 6 * d.tile.scale || r.h < 6 * d.tile.scale) return;
        st.add({ id: newAnnotationId(), screenId: d.tile.id, kind: "rectangle", geometry: { type: "rect", ...r } }, { edit: true });
        return;
      }
      case "sketch": {
        const t = d.tile;
        const style = st.toolStyles[d.shape];
        const sketch = { shape: d.shape, style: { ...style, width: style.width * t.scale } };
        if (d.shape === "line") {
          if (Math.hypot(d.to[0] - d.from[0], d.to[1] - d.from[1]) < 6 * t.scale) return;
          st.add({ id: newAnnotationId(), screenId: t.id, kind: "sketch", geometry: { type: "path", points: [d.from, d.to] }, sketch }, { edit: true });
          return;
        }
        const r = normRect(d.from, d.to);
        if (r.w < 6 * t.scale || r.h < 6 * t.scale) return;
        st.add({ id: newAnnotationId(), screenId: t.id, kind: "sketch", geometry: { type: "rect", ...r }, sketch }, { edit: true });
        return;
      }
      case "arrow": {
        const endTile = tileAt(w) ?? d.tile;
        const to = toPx(endTile, w);
        const len = endTile.id === d.tile.id ? Math.hypot(to[0] - d.from[0], to[1] - d.from[1]) : Infinity;
        if (len < 12 * d.tile.scale) return;
        const geometry: Annotation["geometry"] = { type: "arrow", from: d.from, to };
        if (endTile.id !== d.tile.id) geometry.toScreenId = endTile.id;
        st.add({ id: newAnnotationId(), screenId: d.tile.id, kind: "arrow", geometry }, { edit: true });
        return;
      }
      case "move": {
        if (!d.moved) return;
        const dx = (w[0] - d.start[0]) * d.tile.scale;
        const dy = (w[1] - d.start[1]) * d.tile.scale;
        const moved = translate(d.orig, dx, dy);
        if (moved.kind === "comment") delete moved.attachedTo;
        if (moved.resolution && !moved.resolution.confirmedByUser) delete moved.resolution;
        // restore the original before committing so history holds the pre-move state
        st.set({ annotations: st.annotations.map((a) => (a.id === d.id ? d.orig : a)) });
        st.commit(st.annotations.map((a) => (a.id === d.id ? moved : a)));
        return;
      }
      case "pen": {
        penActive.current = false;
        if (d.pts.length < 2) return;
        const stroke: InkStroke = { points: d.pts, t0: d.t0, t1: performance.now() };
        let g = penGroup.current;
        if (!g || g.tile.id !== d.tile.id) {
          if (g) finishPenGroup();
          g = penGroup.current = { tile: d.tile, strokes: [], timer: null };
        }
        g.strokes.push(stroke);
        setPenDraft({ tile: g.tile, strokes: g.strokes.map((s) => s.points) });
        const short = g.strokes.every((s) => {
          const b = bboxOf(s.points);
          return Math.hypot(b.w, b.h) / g.tile.scale < 45;
        });
        g.timer = setTimeout(finishPenGroup, short ? HANDWRITING_WAIT_MS : PEN_WAIT_MS);
        return;
      }
    }
  };

  const finishPenGroup = () => {
    const g = penGroup.current;
    penGroup.current = null;
    setPenDraft(null);
    if (!g || g.strokes.length === 0) return;
    if (g.timer) clearTimeout(g.timer);
    const st = useStore.getState();
    // classify in point units so thresholds don't depend on device scale
    const s = g.tile.scale;
    const scaled = g.strokes.map((k) => ({ ...k, points: k.points.map(([x, y, p]) => [x / s, y / s, p] as [number, number, number]) }));
    const cls = classifyStrokes(scaled);
    const ink: InkData = {
      strokes: g.strokes.map((k) => ({ points: k.points })),
      pointerType: "pen",
      handwriting: cls.kind === "handwriting",
    };
    st.add(annotationFromInk(g.tile.id, cls.kind, ink, cls.from && cls.to ? { from: [cls.from[0] * s, cls.from[1] * s], to: [cls.to[0] * s, cls.to[1] * s] } : undefined));
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const st = useStore.getState();
    if (st.tool !== "select" && !isReadOnly()) return;
    const t = tileAt(toWorld(e));
    if (t) focusTile(t.id);
  };

  /* ───────── render ───────── */

  const toolStyles = useStore((s) => s.toolStyles);
  const draftSvg = useMemo(() => renderDraft(drag, camera, toolStyles), [drag, camera, toolStyles]);
  const { markers } = useMarkers();
  const zq = quantize(camera.zoom);
  const crossArrows = useMemo(() => renderCrossArrows(annotations, tiles, zq, markers), [annotations, tiles, zq, markers]);
  const drawing = !["select"].includes(tool) && !isReadOnly();
  const cls = [
    "board",
    `tool-${tool}`,
    drawing ? "drawing" : "",
    space || drag?.kind === "pan" ? "panning" : "",
    space ? "space" : "",
    isReadOnly() ? "readonly" : "",
  ].join(" ");

  return (
    <div
      ref={ref}
      className={cls}
      tabIndex={0}
      style={{
        backgroundSize: `${24 * camera.zoom}px ${24 * camera.zoom}px`,
        backgroundPosition: `${-camera.x * camera.zoom}px ${-camera.y * camera.zoom}px`,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => useStore.getState().set({ hover: null, cursorPx: null })}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        className="world"
        style={{ transform: `scale(${camera.zoom}) translate(${-camera.x}px, ${-camera.y}px)` }}
      >
        {groups.map((g) => (
          <div key={g.name} className="group-head" style={{ left: g.x, top: g.y, width: Math.max(g.w, 420) }}>
            <div className="idx">
              {String(g.index).padStart(2, "0")} — {g.count} screen{g.count === 1 ? "" : "s"}
            </div>
            <div className="name">{g.name}</div>
            <div className="rule" />
          </div>
        ))}
        {tiles.map((t) => (
          <Tile key={t.id} tile={t} />
        ))}
        <svg className="board-svg" width="1" height="1">
          <g dangerouslySetInnerHTML={{ __html: crossArrows }} />
          {penDraft && (
            <g transform={`translate(${penDraft.tile.x} ${penDraft.tile.y}) scale(${1 / penDraft.tile.scale})`}>
              {penDraft.strokes.map((s, i) => (
                <path key={i} d={strokeOutlinePath(s, 3.2 * penDraft.tile.scale)} fill={ACCENT} opacity={0.7} />
              ))}
            </g>
          )}
          <g dangerouslySetInnerHTML={{ __html: draftSvg }} />
        </svg>
      </div>
      <Overlay boardRef={ref} />
    </div>
  );
}

/* ───────── helpers ───────── */

function capture(e: React.PointerEvent) {
  try {
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  } catch {
    /* synthetic or already-released pointer */
  }
}

export function clampZoom(z: number) {
  return Math.min(8, Math.max(0.03, z));
}

export function zoomAt(c: Camera, sx: number, sy: number, zoom: number): Camera {
  const z = clampZoom(zoom);
  const wx = sx / c.zoom + c.x;
  const wy = sy / c.zoom + c.y;
  return { zoom: z, x: wx - sx / z, y: wy - sy / z };
}

export function fitAll(tiles: TileLayout[], groups: { y: number }[], vp: Viewport): Camera {
  if (!tiles.length) return { x: -80, y: -80, zoom: 0.5 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const t of tiles) {
    minX = Math.min(minX, t.x);
    minY = Math.min(minY, t.y);
    maxX = Math.max(maxX, t.x + t.w);
    maxY = Math.max(maxY, t.y + t.h);
  }
  for (const g of groups) minY = Math.min(minY, g.y);
  return fitCamera({ x: minX, y: minY, w: maxX - minX, h: maxY - minY }, vp, 72, 1);
}

let anim: number | null = null;
export function animateCamera(to: Camera, ms = 240) {
  const st = useStore.getState();
  const from = st.camera;
  const t0 = performance.now();
  if (anim) cancelAnimationFrame(anim);
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (reduce) {
    st.setCamera(to);
    return;
  }
  const step = (now: number) => {
    const k = Math.min(1, (now - t0) / ms);
    const e = 1 - Math.pow(1 - k, 3);
    // interpolate zoom geometrically, position linearly in screen space
    const zoom = from.zoom * Math.pow(to.zoom / from.zoom, e);
    st.setCamera({ zoom, x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e });
    if (k < 1) anim = requestAnimationFrame(step);
  };
  anim = requestAnimationFrame(step);
}

type Viewport = { x: number; y: number; w: number; h: number };

/** The part of the board not covered by the floating panels, relative to the board. */
export function boardViewport(): Viewport {
  const r = document.querySelector(".board")?.getBoundingClientRect();
  if (!r) return { x: 0, y: 0, w: 1000, h: 700 };
  const edge = (sel: string) => document.querySelector(sel)?.getBoundingClientRect();
  const tools = edge(".rail");
  // the leftmost of the panels on the right: the chat, the inspector, or the action buttons
  const side = [edge(".chat"), edge(".inspector:not(.closed)"), edge(".actions-float")]
    .filter((b): b is DOMRect => !!b)
    .sort((a, b) => a.left - b.left)[0];
  const top = edge(".bar");
  const left = tools && tools.right < r.left + r.width / 2 ? tools.right - r.left : 0;
  const right = side && side.left > r.left + r.width / 2 ? r.right - side.left : 0;
  const y = top ? Math.max(0, top.bottom - r.top) : 0;
  return { x: left, y, w: Math.max(200, r.width - left - right), h: Math.max(200, r.height - y) };
}

export function focusTile(id: string) {
  const st = useStore.getState();
  const t = st.tiles.find((x) => x.id === id);
  if (!t) return;
  st.set({ focusId: id, preFocusCamera: st.focusId ? st.preFocusCamera : st.camera });
  animateCamera(fitCamera({ x: t.x, y: t.y, w: t.w, h: t.h }, boardViewport(), 56, 3));
}

export function unfocus() {
  const st = useStore.getState();
  if (!st.focusId) return;
  const back = st.preFocusCamera;
  st.set({ focusId: null, preFocusCamera: null });
  if (back) animateCamera(back);
}

export function panToAnnotation(a: Annotation) {
  const st = useStore.getState();
  const t = st.tiles.find((x) => x.id === a.screenId);
  if (!t) return;
  const g = a.geometry;
  const b =
    g.type === "point" ? { x: g.x, y: g.y, w: 0, h: 0 } : g.type === "rect" ? g : g.type === "arrow" ? bboxOf([g.from, g.to]) : bboxOf(g.points);
  const vp = boardViewport();
  const cx = t.x + (b.x + b.w / 2) / t.scale;
  const cy = t.y + (b.y + b.h / 2) / t.scale;
  const zoom = Math.max(st.camera.zoom, Math.min(1, (vp.h * 0.7) / t.h));
  animateCamera({ zoom, x: cx - (vp.x + vp.w / 2) / zoom, y: cy - (vp.y + vp.h / 2) / zoom });
}

/** Shift: lines snap to 45°, boxes and ellipses become square. */
function constrainPx(shape: "line" | "box" | "ellipse", from: Pt, to: Pt, shift: boolean): Pt {
  if (!shift) return to;
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  if (shape === "line") {
    const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    const len = Math.hypot(dx, dy);
    return [from[0] + Math.cos(ang) * len, from[1] + Math.sin(ang) * len];
  }
  const m = Math.max(Math.abs(dx), Math.abs(dy));
  return [from[0] + Math.sign(dx || 1) * m, from[1] + Math.sign(dy || 1) * m];
}

function normRect(a: Pt, b: Pt) {
  return {
    x: Math.min(a[0], b[0]),
    y: Math.min(a[1], b[1]),
    w: Math.abs(a[0] - b[0]),
    h: Math.abs(a[1] - b[1]),
  };
}

export function translate(a: Annotation, dx: number, dy: number): Annotation {
  const g = a.geometry;
  const r = (n: number) => Math.round(n * 10) / 10;
  let geometry: Annotation["geometry"];
  switch (g.type) {
    case "point":
      geometry = { ...g, x: r(g.x + dx), y: r(g.y + dy) };
      break;
    case "rect":
      geometry = { ...g, x: r(g.x + dx), y: r(g.y + dy) };
      break;
    case "arrow":
      geometry = { ...g, from: [r(g.from[0] + dx), r(g.from[1] + dy)], to: g.toScreenId ? g.to : [r(g.to[0] + dx), r(g.to[1] + dy)] };
      break;
    case "path":
      geometry = { ...g, points: g.points.map(([x, y]) => [r(x + dx), r(y + dy)] as [number, number]) };
      break;
  }
  const out: Annotation = { ...a, geometry };
  if (a.ink) out.ink = { ...a.ink, strokes: a.ink.strokes.map((s) => ({ points: s.points.map(([x, y, p]) => [r(x + dx), r(y + dy), p] as [number, number, number]) })) };
  return out;
}

/** Build an annotation of the given kind from pen ink (also used when the user reclassifies). */
export function annotationFromInk(
  screenId: string,
  kind: "circle" | "arrow" | "remove" | "handwriting" | "freehand",
  ink: InkData,
  arrow?: { from: Pt; to: Pt },
  id = newAnnotationId(),
): Annotation {
  const all = ink.strokes.flatMap((s) => s.points.map(([x, y]) => [x, y] as Pt));
  const first = (ink.strokes[0]?.points ?? []).map(([x, y]) => [x, y] as Pt);
  const bb = bboxOf(all);
  const handwriting = kind === "handwriting";
  const inkData: InkData = { ...ink, handwriting };
  switch (kind) {
    case "circle":
      return { id, screenId, kind: "circle", geometry: { type: "path", points: first.length > 2 ? first : all }, ink: inkData };
    case "arrow": {
      const from = arrow?.from ?? first[0] ?? [bb.x, bb.y];
      const to = arrow?.to ?? first[first.length - 1] ?? [bb.x + bb.w, bb.y + bb.h];
      return { id, screenId, kind: "arrow", geometry: { type: "arrow", from, to }, ink: inkData };
    }
    case "remove":
      return { id, screenId, kind: "remove", geometry: { type: "path", points: all }, ink: inkData };
    case "handwriting":
      return { id, screenId, kind: "comment", geometry: { type: "point", x: Math.round(bb.x + bb.w / 2), y: Math.round(bb.y + bb.h / 2) }, ink: inkData };
    case "freehand":
      return { id, screenId, kind: "freehand", geometry: { type: "path", points: first.length > 1 ? first : all }, ink: inkData };
  }
}

function renderDraft(d: Drag | null, cam: Camera, styles: ReturnType<typeof useStore.getState>["toolStyles"]): string {
  if (!d) return "";
  const sw = 2 / cam.zoom;
  const style = `fill="none" stroke="${ACCENT}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"`;
  const W = (t: TileLayout, p: Pt) => `${t.x + p[0] / t.scale} ${t.y + p[1] / t.scale}`;
  switch (d.kind) {
    case "path":
      return `<path d="M ${d.pts.map((p) => W(d.tile, p)).join(" L ")}" ${style}/>`;
    case "rect": {
      const r = normRect(d.from, d.to);
      const t = d.tile;
      return `<rect x="${t.x + r.x / t.scale}" y="${t.y + r.y / t.scale}" width="${r.w / t.scale}" height="${r.h / t.scale}" ${style} stroke-dasharray="${7 / cam.zoom} ${5 / cam.zoom}" fill="${ACCENT}" fill-opacity="0.08"/>`;
    }
    case "arrow": {
      const [x1, y1] = W(d.tile, d.from).split(" ").map(Number) as [number, number];
      const [x2, y2] = d.toWorld;
      const ang = Math.atan2(y2 - y1, x2 - x1);
      const L = 12 / cam.zoom;
      const a = [x2 - L * Math.cos(ang - 0.45), y2 - L * Math.sin(ang - 0.45)];
      const b = [x2 - L * Math.cos(ang + 0.45), y2 - L * Math.sin(ang + 0.45)];
      return `<path d="M ${x1} ${y1} L ${x2} ${y2} M ${a[0]} ${a[1]} L ${x2} ${y2} L ${b[0]} ${b[1]}" ${style}/>`;
    }
    case "sketch": {
      // world units are points, the unit sketch styles are set in
      const t = d.tile;
      const toW = (p: Pt): Pt => [t.x + p[0] / t.scale, t.y + p[1] / t.scale];
      const style = styles[d.shape];
      if (d.shape === "line") return renderShapeSvg({ shape: "line", from: toW(d.from), to: toW(d.to), style });
      const r = normRect(toW(d.from), toW(d.to));
      return renderShapeSvg({ shape: d.shape, rect: r, style });
    }
    case "pen": {
      const t = d.tile;
      const path = strokeOutlinePath(d.pts, 3.2 * t.scale);
      return `<g transform="translate(${t.x} ${t.y}) scale(${1 / t.scale})"><path d="${path}" fill="${ACCENT}"/></g>`;
    }
    default:
      return "";
  }
}

/** Arrows that end on another tile, drawn in world space across tiles. */
function renderCrossArrows(annotations: Annotation[], tiles: TileLayout[], zoom: number, markers: Map<string, number>): string {
  const byId = new Map(tiles.map((t) => [t.id, t]));
  const out: string[] = [];
  for (const a of annotations) {
    const g = a.geometry;
    if (a.kind !== "arrow" || g.type !== "arrow" || !g.toScreenId || g.toScreenId === a.screenId) continue;
    const t1 = byId.get(a.screenId);
    const t2 = byId.get(g.toScreenId);
    if (!t1 || !t2) continue;
    const from: Pt = [t1.x + g.from[0] / t1.scale, t1.y + g.from[1] / t1.scale];
    const to: Pt = [t2.x + g.to[0] / t2.scale, t2.y + g.to[1] / t2.scale];
    const world: Annotation = { ...a, geometry: { type: "arrow", from, to }, ink: undefined };
    out.push(renderAnnotationSvg(world, { unit: Math.max(1, 1 / zoom), label: markers.has(a.id) ? String(markers.get(a.id)) : undefined }).replace("<g ", `<g data-ann-id="${a.id}" class="ann" style="pointer-events:visiblePainted" `));
  }
  return out.join("");
}
