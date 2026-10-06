import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { canvasOf, itemBounds, renderVisionItemSvg, TEXT_LINE, VISION_FONT, type SketchStyle, type VisionItem } from "@scribui/core";
import { visionImageUrl } from "../api";
import { screenToWorld, type Camera } from "../layout";
import { isSketchTool, TOOLS, useStore, type Tool } from "../store";
import { fitVision, importImage, measureText, newId, translateItem, useVision, type TextItem } from "../vision";
import { boardViewport, clampZoom, zoomAt } from "./Board";
import { VISION_TOOLS } from "./Chrome";

type Pt = [number, number];
type Handle = "nw" | "ne" | "se" | "sw";
type BoxItem = Extract<VisionItem, { type: "box" | "ellipse" | "image" | "text" }>;

type Drag =
  | { kind: "pan"; sx: number; sy: number; cam: Camera; moved: boolean }
  | { kind: "stroke"; pts: [number, number, number][] }
  | { kind: "shape"; shape: "line" | "box" | "ellipse"; from: Pt; to: Pt }
  | { kind: "move"; id: string; start: Pt; orig: VisionItem; moved: boolean }
  | { kind: "resize"; id: string; handle: Handle; orig: BoxItem; fixed: Pt }
  | { kind: "rotate"; id: string; orig: BoxItem; center: Pt };

const isBox = (i: VisionItem): i is BoxItem => i.type === "box" || i.type === "ellipse" || i.type === "image" || i.type === "text";
const href = (src: string) => visionImageUrl(src);

export function VisionBoard() {
  const ref = useRef<HTMLDivElement>(null);
  const view = useStore((s) => s.view);
  const tool = useStore((s) => s.tool);
  const styles = useStore((s) => s.toolStyles);
  const doc = useVision((s) => s.doc);
  const camera = useVision((s) => s.camera);
  const selectedId = useVision((s) => s.selectedId);
  const textEdit = useVision((s) => s.textEdit);
  const loaded = useVision((s) => s.loaded);
  const fitted = useVision((s) => s.fitted);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [space, setSpace] = useState(false);
  const touches = useRef(new Map<number, Pt>());
  const pinch = useRef<{ d: number; mid: Pt; cam: Camera } | null>(null);
  const shown = view === "vision";

  const setDragBoth = (d: Drag | null) => {
    dragRef.current = d;
    setDrag(d);
  };

  // load once the project is known: new canvases take the app's screen size
  const projectLoaded = useStore((s) => !!s.project);
  useEffect(() => {
    if (projectLoaded) void useVision.getState().load();
  }, [projectLoaded]);

  // fit the canvases into view the first time the board is shown
  useEffect(() => {
    if (!shown || !loaded || fitted) return;
    useVision.getState().set({ fitted: true, camera: fitVisionCamera() });
  }, [shown, loaded, fitted]);

  const local = useCallback((e: { clientX: number; clientY: number }): Pt => {
    const r = ref.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }, []);
  const toWorld = useCallback(
    (e: { clientX: number; clientY: number }): Pt => {
      const [sx, sy] = local(e);
      return screenToWorld(useVision.getState().camera, sx, sy);
    },
    [local],
  );

  /* ───────── wheel, space, paste ───────── */

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = useVision.getState();
      const [sx, sy] = local(e);
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0022));
        v.setCamera((c) => zoomAt(c, sx, sy, c.zoom * factor));
      } else {
        const k = e.deltaMode === 1 ? 16 : 1;
        v.setCamera((c) => ({ ...c, x: c.x + (e.deltaX * k) / c.zoom, y: c.y + (e.deltaY * k) / c.zoom }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    const onGesture = (e: Event) => e.preventDefault();
    el.addEventListener("gesturestart", onGesture);
    el.addEventListener("gesturechange", onGesture);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGesture);
      el.removeEventListener("gesturechange", onGesture);
    };
  }, [local]);

  useEffect(() => {
    if (!shown) return;
    const typing = (t: EventTarget | null) => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;
    const down = (e: KeyboardEvent) => {
      if (!typing(e.target) && e.code === "Space") {
        e.preventDefault();
        setSpace(true);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpace(false);
    };
    const paste = (e: ClipboardEvent) => {
      if (typing(e.target) || useVision.getState().importOpen) return;
      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/"));
      if (!file) return;
      e.preventDefault();
      void importImage(file);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("paste", paste);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("paste", paste);
    };
  }, [shown]);

  /* ───────── pointer ───────── */

  const capture = (pointerId: number) => {
    try {
      ref.current?.setPointerCapture(pointerId);
    } catch {
      /* synthetic or released pointer */
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const st = useStore.getState();
    const v = useVision.getState();
    if ((e.target as Element).closest(".vision-ui")) return;
    if (v.textEdit) {
      // a click elsewhere finishes the text (the textarea's blur commits it)
      (document.activeElement as HTMLElement | null)?.blur();
    }
    e.preventDefault();
    ref.current?.focus({ preventScroll: true });
    const w = toWorld(e);
    const [sx, sy] = local(e);

    if (e.pointerType === "touch") {
      touches.current.set(e.pointerId, [sx, sy]);
      capture(e.pointerId);
      if (touches.current.size === 2) {
        const [a, b] = [...touches.current.values()] as [Pt, Pt];
        pinch.current = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], cam: v.camera };
        setDragBoth(null);
        return;
      }
      if (st.penMode) return setDragBoth({ kind: "pan", sx, sy, cam: v.camera, moved: false });
    }
    if (e.button === 1 || e.button === 2 || space) {
      capture(e.pointerId);
      return setDragBoth({ kind: "pan", sx, sy, cam: v.camera, moved: false });
    }
    if (e.button !== 0) return;
    capture(e.pointerId);

    const itemEl = (e.target as Element).closest("[data-item-id]");
    const hit = itemEl ? v.doc.items.find((i) => i.id === itemEl.getAttribute("data-item-id")) : undefined;
    const t: Tool = st.tool;

    if (t === "select" || !isDrawTool(t)) {
      if (hit) {
        v.set({ selectedId: hit.id });
        return setDragBoth({ kind: "move", id: hit.id, start: w, orig: hit, moved: false });
      }
      v.set({ selectedId: null });
      return setDragBoth({ kind: "pan", sx, sy, cam: v.camera, moved: false });
    }
    switch (t) {
      case "freehand":
        return setDragBoth({ kind: "stroke", pts: [[w[0], w[1], e.pressure || 0.5]] });
      case "line":
      case "box":
      case "ellipse":
        return setDragBoth({ kind: "shape", shape: t, from: w, to: w });
      case "text": {
        if (hit?.type === "text") return startTextEdit(hit, false);
        const style = st.toolStyles.text;
        const size = style.size ?? 32;
        const box = measureText("", size);
        const item: TextItem = { id: newId("v"), type: "text", x: Math.round(w[0]), y: Math.round(w[1] - size * 0.62), ...box, text: "", style };
        return startTextEdit(item, true);
      }
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const v = useVision.getState();
    const [sx, sy] = local(e);
    if (e.pointerType === "touch" && touches.current.has(e.pointerId)) {
      touches.current.set(e.pointerId, [sx, sy]);
      if (touches.current.size === 2 && pinch.current) {
        const [a, b] = [...touches.current.values()] as [Pt, Pt];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const p = pinch.current;
        const zoom = clampZoom(p.cam.zoom * (d / p.d));
        const wx = p.mid[0] / p.cam.zoom + p.cam.x;
        const wy = p.mid[1] / p.cam.zoom + p.cam.y;
        v.setCamera({ zoom, x: wx - mid[0] / zoom, y: wy - mid[1] / zoom });
        return;
      }
    }
    const d = dragRef.current;
    if (!d) return;
    const w = toWorld(e);
    switch (d.kind) {
      case "pan": {
        const dx = sx - d.sx;
        const dy = sy - d.sy;
        if (!d.moved && Math.hypot(dx, dy) < 4) return;
        d.moved = true;
        v.setCamera({ ...d.cam, x: d.cam.x - dx / d.cam.zoom, y: d.cam.y - dy / d.cam.zoom });
        return;
      }
      case "stroke": {
        const events = typeof e.nativeEvent.getCoalescedEvents === "function" ? e.nativeEvent.getCoalescedEvents() : [];
        const pts = [...d.pts];
        for (const ev of events.length ? events : [e.nativeEvent]) {
          const q = toWorld(ev);
          pts.push([Math.round(q[0] * 10) / 10, Math.round(q[1] * 10) / 10, ev.pressure || 0.5]);
        }
        return setDragBoth({ ...d, pts });
      }
      case "shape":
        return setDragBoth({ ...d, to: constrain(d.shape, d.from, w, e.shiftKey) });
      case "move": {
        const dx = w[0] - d.start[0];
        const dy = w[1] - d.start[1];
        if (!d.moved && Math.hypot(dx, dy) * v.camera.zoom < 3) return;
        d.moved = true;
        // live preview without history
        v.set({ doc: { ...v.doc, items: v.doc.items.map((i) => (i.id === d.id ? translateItem(d.orig, dx, dy) : i)) } });
        return;
      }
      case "resize":
        v.set({ doc: { ...v.doc, items: v.doc.items.map((i) => (i.id === d.id ? resized(d.orig, d.handle, d.fixed, w, e.shiftKey) : i)) } });
        return;
      case "rotate": {
        let deg = (Math.atan2(w[1] - d.center[1], w[0] - d.center[0]) * 180) / Math.PI + 90;
        if (e.shiftKey) deg = Math.round(deg / 15) * 15;
        deg = Math.round(((((deg + 180) % 360) + 360) % 360) - 180);
        v.set({ doc: { ...v.doc, items: v.doc.items.map((i) => (i.id === d.id ? { ...d.orig, rotation: deg } : i)) } });
        return;
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (e.pointerType === "touch") {
      touches.current.delete(e.pointerId);
      if (touches.current.size < 2) pinch.current = null;
    }
    const d = dragRef.current;
    setDragBoth(null);
    if (!d) return;
    const v = useVision.getState();
    const st = useStore.getState();
    switch (d.kind) {
      case "stroke": {
        if (d.pts.length < 2) return;
        v.add({ id: newId("v"), type: "stroke", points: d.pts, style: st.toolStyles.freehand });
        return;
      }
      case "shape": {
        const item = shapeItem(d.shape, d.from, d.to, st.toolStyles[d.shape]);
        if (item) v.add(item);
        return;
      }
      case "move":
      case "resize":
      case "rotate": {
        if (d.kind === "move" && !d.moved) return;
        const now = v.doc.items.find((i) => i.id === d.id);
        if (!now) return;
        // put the original back so undo returns to it, then commit the change
        v.set({ doc: { ...v.doc, items: v.doc.items.map((i) => (i.id === d.id ? d.orig : i)) } });
        v.update(d.id, () => now);
        return;
      }
    }
  };

  const startHandleDrag = (e: React.PointerEvent, item: BoxItem, handle: Handle | "rotate") => {
    e.stopPropagation();
    e.preventDefault();
    capture(e.pointerId);
    const cx = item.x + item.w / 2;
    const cy = item.y + item.h / 2;
    if (handle === "rotate") return setDragBoth({ kind: "rotate", id: item.id, orig: item, center: [cx, cy] });
    const opposite: Record<Handle, Pt> = {
      nw: [item.x + item.w, item.y + item.h],
      ne: [item.x, item.y + item.h],
      se: [item.x, item.y],
      sw: [item.x + item.w, item.y],
    };
    setDragBoth({ kind: "resize", id: item.id, handle, orig: item, fixed: rotateAround(opposite[handle], [cx, cy], item.rotation ?? 0) });
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const el = (e.target as Element).closest("[data-item-id]");
    const item = el ? useVision.getState().doc.items.find((i) => i.id === el.getAttribute("data-item-id")) : undefined;
    if (item?.type === "text") startTextEdit(item, false);
  };

  const onDrop = (e: React.DragEvent) => {
    const file = [...e.dataTransfer.files].find((f) => f.type.startsWith("image/"));
    if (!file) return;
    e.preventDefault();
    void importImage(file, toWorld(e));
  };

  /* ───────── render ───────── */

  const items = useMemo(
    () =>
      doc.items.map((i) => ({
        id: i.id,
        hidden: textEdit?.item.id === i.id,
        html: renderVisionItemSvg(i, href) + (i.type === "line" ? hitLine(i, camera.zoom) : ""),
      })),
    [doc.items, textEdit, camera.zoom],
  );
  const draft = useMemo(() => draftSvg(drag, styles), [drag, styles]);
  const selected = doc.items.find((i) => i.id === selectedId);
  const drawing = isDrawTool(tool);
  const cls = ["vision", shown ? "" : "off", drawing ? "drawing" : "", space || drag?.kind === "pan" ? "panning" : "", space ? "space" : ""].join(" ");

  return (
    <div
      ref={ref}
      className={cls}
      tabIndex={0}
      aria-hidden={!shown}
      style={{
        backgroundSize: `${24 * camera.zoom}px ${24 * camera.zoom}px`,
        backgroundPosition: `${-camera.x * camera.zoom}px ${-camera.y * camera.zoom}px`,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => e.preventDefault()}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <div className="world" style={{ transform: `scale(${camera.zoom}) translate(${-camera.x}px, ${-camera.y}px)` }}>
        {doc.canvases.map((c) => (
          <div key={c.id} className="vision-canvas" style={{ left: c.x, top: c.y, width: c.w, height: c.h }} />
        ))}
        <svg className="board-svg vision-svg" width="1" height="1">
          {items.map((i) => (
            <g key={i.id} data-item-id={i.id} className="vision-item" style={i.hidden ? { display: "none" } : undefined} dangerouslySetInnerHTML={{ __html: i.html }} />
          ))}
          <g dangerouslySetInnerHTML={{ __html: draft }} />
        </svg>
      </div>

      <div className="vision-overlay">
        {doc.canvases.map((c, i) => (
          <CanvasLabel key={c.id} index={i} id={c.id} left={(c.x - camera.x) * camera.zoom} top={(c.y - camera.y) * camera.zoom} canRemove={doc.canvases.length > 1} />
        ))}
        {selected && !textEdit && drag?.kind !== "move" && <Selection item={selected} camera={camera} onHandle={startHandleDrag} />}
        {textEdit && <TextEditor key={textEdit.item.id} item={textEdit.item} camera={camera} />}
      </div>
    </div>
  );
}

/* ───────── pieces ───────── */

function CanvasLabel({ index, id, left, top, canRemove }: { index: number; id: string; left: number; top: number; canRemove: boolean }) {
  const [ask, setAsk] = useState(false);
  const count = useVision((s) => s.doc.items.filter((i) => canvasOf(i, s.doc.canvases)?.id === id).length);
  return (
    <div className="vision-ui canvas-label" style={{ left, top }}>
      <b>Canvas {index + 1}</b>
      {canRemove &&
        (ask ? (
          <span className="remove-ask">
            remove{count ? ` with ${count} item${count === 1 ? "" : "s"}` : ""}?{" "}
            <button className="yes" onClick={() => useVision.getState().removeCanvas(id)}>
              yes
            </button>{" "}
            <button onClick={() => setAsk(false)}>no</button>
          </span>
        ) : (
          <button className="remove" onClick={() => (count ? setAsk(true) : useVision.getState().removeCanvas(id))} title="remove this canvas">
            ✕
          </button>
        ))}
    </div>
  );
}

function Selection({ item, camera, onHandle }: { item: VisionItem; camera: Camera; onHandle: (e: React.PointerEvent, i: BoxItem, h: Handle | "rotate") => void }) {
  const z = camera.zoom;
  if (!isBox(item)) {
    const b = itemBounds(item);
    return <div className="vision-sel loose" style={{ left: (b.x - camera.x) * z - 4, top: (b.y - camera.y) * z - 4, width: b.w * z + 8, height: b.h * z + 8 }} />;
  }
  return (
    <div
      className="vision-sel"
      style={{
        left: (item.x - camera.x) * z,
        top: (item.y - camera.y) * z,
        width: item.w * z,
        height: item.h * z,
        transform: item.rotation ? `rotate(${item.rotation}deg)` : undefined,
      }}
    >
      {(["nw", "ne", "se", "sw"] as Handle[]).map((h) => (
        <span key={h} className={`vision-ui handle ${h}`} onPointerDown={(e) => onHandle(e, item, h)} />
      ))}
      <span className="vision-ui rotate-stem" />
      <span className="vision-ui handle rotate" title="rotate (shift snaps to 15°)" onPointerDown={(e) => onHandle(e, item, "rotate")} />
    </div>
  );
}

function TextEditor({ item, camera }: { item: TextItem; camera: Camera }) {
  const [text, setText] = useState(item.text);
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  const size = item.style.size ?? 32;
  const z = camera.zoom;
  const box = measureText(text || " ", size);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const commit = () => {
    if (done.current) return;
    done.current = true;
    useVision.getState().commitText(text);
    document.querySelector<HTMLElement>(".vision")?.focus();
  };

  return (
    <textarea
      ref={ref}
      className="vision-ui vision-text-edit"
      value={text}
      spellCheck={false}
      placeholder="Type…"
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
          e.preventDefault();
          commit();
        }
      }}
      style={{
        left: (item.x - camera.x) * z,
        top: (item.y - camera.y) * z,
        width: Math.max(box.w, size * 4) * z + 8,
        height: box.h * z + 4,
        font: `500 ${size * z}px/${TEXT_LINE} ${VISION_FONT}`,
        color: item.style.color,
        transform: item.rotation ? `rotate(${item.rotation}deg)` : undefined,
      }}
    />
  );
}

/* ───────── helpers ───────── */

const isDrawTool = (t: Tool) => t === "freehand" || isSketchTool(t);

function startTextEdit(item: TextItem, isNew: boolean) {
  useVision.getState().set({ textEdit: { item, isNew }, selectedId: isNew ? null : item.id });
}

export const fitVisionCamera = (): Camera => fitVision(boardViewport());

function rotateAround(p: Pt, c: Pt, deg: number): Pt {
  if (!deg) return p;
  const a = (deg * Math.PI) / 180;
  const dx = p[0] - c[0];
  const dy = p[1] - c[1];
  return [c[0] + dx * Math.cos(a) - dy * Math.sin(a), c[1] + dx * Math.sin(a) + dy * Math.cos(a)];
}

/** Resize from a corner, the opposite corner staying put. Images and text keep their proportions (shift frees images). */
function resized(o: BoxItem, handle: Handle, fixed: Pt, p: Pt, shift: boolean): BoxItem {
  const deg = o.rotation ?? 0;
  const local = rotateAround(p, fixed, -deg);
  const sx = handle === "ne" || handle === "se" ? 1 : -1;
  const sy = handle === "se" || handle === "sw" ? 1 : -1;
  let w = Math.max(8, (local[0] - fixed[0]) * sx);
  let h = Math.max(8, (local[1] - fixed[1]) * sy);
  const keep = o.type === "text" || (o.type === "image" && !shift) || ((o.type === "box" || o.type === "ellipse") && shift);
  if (keep) {
    const k = Math.max(w / o.w, h / o.h);
    w = o.w * k;
    h = o.h * k;
  }
  const centreLocal: Pt = [fixed[0] + (sx * w) / 2, fixed[1] + (sy * h) / 2];
  const [cx, cy] = rotateAround(centreLocal, fixed, deg);
  const r = (v: number) => Math.round(v * 10) / 10;
  const next = { ...o, x: r(cx - w / 2), y: r(cy - h / 2), w: r(w), h: r(h) };
  if (o.type === "text") {
    const size = Math.max(6, Math.round((o.style.size ?? 32) * (w / o.w)));
    return { ...(next as TextItem), style: { ...o.style, size } };
  }
  return next;
}

function constrain(shape: "line" | "box" | "ellipse", from: Pt, to: Pt, shift: boolean): Pt {
  if (!shift) return to;
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  if (shape === "line") {
    const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    const len = Math.hypot(dx, dy);
    return [from[0] + Math.cos(ang) * len, from[1] + Math.sin(ang) * len];
  }
  const s = Math.max(Math.abs(dx), Math.abs(dy));
  return [from[0] + Math.sign(dx || 1) * s, from[1] + Math.sign(dy || 1) * s];
}

function shapeItem(shape: "line" | "box" | "ellipse", from: Pt, to: Pt, style: SketchStyle): VisionItem | null {
  const r = (v: number) => Math.round(v * 10) / 10;
  if (shape === "line") {
    if (Math.hypot(to[0] - from[0], to[1] - from[1]) < 4) return null;
    return { id: newId("v"), type: "line", from: [r(from[0]), r(from[1])], to: [r(to[0]), r(to[1])], style };
  }
  const x = Math.min(from[0], to[0]);
  const y = Math.min(from[1], to[1]);
  const w = Math.abs(to[0] - from[0]);
  const h = Math.abs(to[1] - from[1]);
  if (w < 4 || h < 4) return null;
  return { id: newId("v"), type: shape, x: r(x), y: r(y), w: r(w), h: r(h), style };
}

function draftSvg(d: Drag | null, styles: ReturnType<typeof useStore.getState>["toolStyles"]): string {
  if (!d) return "";
  if (d.kind === "stroke" && d.pts.length > 1) return renderVisionItemSvg({ id: "draft", type: "stroke", points: d.pts, style: styles.freehand }, href);
  if (d.kind === "shape") {
    const item = shapeItem(d.shape, d.from, d.to, styles[d.shape]);
    return item ? renderVisionItemSvg(item, href) : "";
  }
  return "";
}

/** A wide transparent stroke over a line, so thin lines are easy to pick. */
function hitLine(i: Extract<VisionItem, { type: "line" }>, zoom: number): string {
  return `<path d="M ${i.from[0]} ${i.from[1]} L ${i.to[0]} ${i.to[1]}" stroke="transparent" stroke-width="${Math.max(i.style.width, 14 / zoom)}" stroke-linecap="round"/>`;
}

/* ───────── image import ───────── */

/** Popup for adding an image: drop it, paste it or pick a file. */
export function ImageImportDialog() {
  const open = useVision((s) => s.importOpen);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const close = () => useVision.getState().set({ importOpen: false });

  const take = async (files: FileList | File[] | null | undefined) => {
    const file = [...(files ?? [])].find((f) => f.type.startsWith("image/"));
    if (!file) return useStore.getState().toast({ text: "that isn't an image", tone: "warn" });
    setBusy(true);
    await importImage(file);
    setBusy(false);
    close();
  };

  useEffect(() => {
    if (!open) return;
    const paste = (e: ClipboardEvent) => {
      if (!e.clipboardData?.files.length) return;
      e.preventDefault();
      void take(e.clipboardData.files);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("paste", paste);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("paste", paste);
      window.removeEventListener("keydown", key);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;
  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal image-import" role="dialog" aria-label="Import image">
        <div className="mh">
          <span>Import image</span>
          <button onClick={close} aria-label="close">
            esc
          </button>
        </div>
        <div className="mb">
          <div
            className={`drop-zone ${over ? "over" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              void take(e.dataTransfer.files);
            }}
            onClick={() => input.current?.click()}
          >
            <b>{busy ? "Adding…" : "Drop an image here"}</b>
            <span className="dim">or paste it (⌘V), or click to choose a file</span>
            <span className="faint">PNG, JPEG, GIF, WebP or SVG. You can move, resize and rotate it on the canvas.</span>
          </div>
          <input ref={input} type="file" accept="image/*" hidden onChange={(e) => void take(e.target.files)} />
        </div>
      </div>
    </div>
  );
}

/* ───────── keys ───────── */

/** Keys on the vision board; returns true when the key was handled. */
export function visionKey(e: KeyboardEvent): boolean {
  const v = useVision.getState();
  const st = useStore.getState();
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (mod && k === "z") {
    e.preventDefault();
    if (e.shiftKey) v.redo();
    else v.undo();
    return true;
  }
  if (mod && k === "y") {
    e.preventDefault();
    v.redo();
    return true;
  }
  if (mod && (e.key === "=" || e.key === "+" || e.key === "-")) {
    e.preventDefault();
    zoomVision(v.camera.zoom * (e.key === "-" ? 0.8 : 1.25));
    return true;
  }
  if (mod || e.altKey) return false;
  if (e.key === "Escape") {
    if (v.selectedId) v.set({ selectedId: null });
    else if (st.tool !== "select") st.setTool("select");
    return true;
  }
  if ((e.key === "Backspace" || e.key === "Delete") && v.selectedId) {
    e.preventDefault();
    v.remove(v.selectedId);
    return true;
  }
  const arrows: Record<string, Pt> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (arrows[e.key] && v.selectedId) {
    e.preventDefault();
    const [dx, dy] = arrows[e.key]!;
    const step = e.shiftKey ? 10 : 1;
    v.update(v.selectedId, (i) => translateItem(i, dx * step, dy * step), { coalesce: `${v.selectedId}:nudge` });
    return true;
  }
  if (k === "m") {
    v.set({ importOpen: true });
    return true;
  }
  if (k === "f" || e.key === "0") {
    v.setCamera(fitVisionCamera());
    return true;
  }
  if (e.key === "1") {
    zoomVision(1);
    return true;
  }
  const tool = TOOLS.find((x) => x.key === e.key.toUpperCase() && VISION_TOOLS.includes(x.tool));
  if (tool) {
    st.setTool(tool.tool);
    return true;
  }
  return false;
}

/** Zoom the vision board around the middle of the uncovered area. */
export function zoomVision(zoom: number) {
  const vp = boardViewport();
  useVision.getState().setCamera((c) => zoomAt(c, vp.x + vp.w / 2, vp.y + vp.h / 2, zoom));
}
