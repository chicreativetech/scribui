import { memo, useEffect, useMemo, useState } from "react";
import { bboxOf, indexFor, renderAnnotationSvg, type Annotation, type Rect, type UIElement } from "@intentcue/core";
import { quantize, type TileLayout } from "../layout";
import { screenInfo, useCapturingScreens, useMarkers, useStore } from "../store";

/** One screen: screenshot + SVG layer in screenshot pixels. */
export const Tile = memo(function Tile({ tile }: { tile: TileLayout }) {
  const info = useStore((s) => s.round?.screens.find((x) => x.id === tile.id));
  const tree = useStore((s) => s.trees.get(tile.id));
  const zoom = useStore((s) => quantize(s.camera.zoom));
  const focusId = useStore((s) => s.focusId);
  const annotations = useStore((s) => s.annotations);
  const selectedId = useStore((s) => s.selectedId);
  const showOutlines = useStore((s) => s.showOutlines);
  const hover = useStore((s) => (s.hover?.screenId === tile.id ? s.hover : null));
  const selectedElement = useStore((s) => (s.selectedElement?.screenId === tile.id ? s.selectedElement.elementId : null));
  const ruleTargets = useStore((s) => s.ruleTargets);
  const flash = useStore((s) => (s.flash?.screenId === tile.id ? s.flash : null));
  const titles = useStore((s) => s.round?.screens);
  const { markers, rules } = useMarkers();
  const capturing = useCapturingScreens().has(tile.id);

  const W = info?.size?.width ?? tile.w * tile.scale;
  const H = info?.size?.height ?? tile.h * tile.scale;
  const unit = tile.scale * Math.max(1, 1 / zoom);
  const idx = useMemo(() => (tree ? indexFor(tree) : null), [tree]);

  const mine = useMemo(() => annotations.filter((a) => a.screenId === tile.id), [annotations, tile.id]);

  const annSvgs = useMemo(
    () =>
      mine
        .filter((a) => !(a.kind === "arrow" && a.geometry.type === "arrow" && a.geometry.toScreenId && a.geometry.toScreenId !== a.screenId))
        .map((a) => {
          const label = a.kind === "rule" ? (rules.has(a.id) ? `U${rules.get(a.id)}` : undefined) : markers.has(a.id) ? String(markers.get(a.id)) : undefined;
          return {
            a,
            html: renderAnnotationSvg(a, {
              unit,
              label,
              boundsFor: (id) => idx?.get(id)?.bounds,
              screen: { width: W, height: H },
              toScreenTitle: titles?.find((s) => a.geometry.type === "arrow" && s.id === a.geometry.toScreenId)?.title,
              warn: a.resolution?.status === "unresolved" && a.kind !== "rule",
            }),
          };
        }),
    [mine, unit, markers, rules, idx, W, H, titles],
  );

  // clear the flash highlight after it plays
  const [flashKey, setFlashKey] = useState(0);
  useEffect(() => {
    if (!flash) return;
    setFlashKey((k) => k + 1);
    const t = setTimeout(() => {
      const s = useStore.getState();
      if (s.flash === flash) s.set({ flash: null });
    }, Math.max(0, flash.until - Date.now()));
    return () => clearTimeout(t);
  }, [flash]);

  if (!info?.captured || !info.screenshot) {
    return (
      <div
        className={`tile ${capturing || !info?.error ? "placeholder" : "failed"}`}
        style={{ left: tile.x, top: tile.y, width: tile.w, height: tile.h }}
      >
        {capturing || !info?.error ? <div className="skeleton">capturing…</div> : <div className="msg">{`✗ capture failed\n\n${info.error}`}</div>}
      </div>
    );
  }

  const hoverEl = hover ? hover.stack[hover.level] : null;
  const selectedAnn = selectedId ? mine.find((a) => a.id === selectedId) : undefined;
  const dimmed = focusId !== null && focusId !== tile.id;

  return (
    <div
      className={`tile${dimmed ? " dimmed" : ""}${focusId === tile.id ? " focused" : ""}`}
      style={{ left: tile.x, top: tile.y, width: tile.w, height: tile.h }}
      data-tile={tile.id}
    >
      <img src={info.screenshot} alt={info.title} draggable={false} />
      {capturing && <div className="skeleton">capturing…</div>}
      <svg className="tile-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        {showOutlines && idx && (
          <g>
            {idx.all.slice(1).map((f) => (
              <ElRect key={f.el.id} r={f.el.bounds} cls="all" />
            ))}
          </g>
        )}
        {selectedElement && idx?.get(selectedElement) && <ElRect r={idx.get(selectedElement)!.bounds} cls="selected" />}
        {ruleTargets
          .filter((r) => r.screenId === tile.id)
          .map((r) => {
            const el = idx?.get(r.elementId);
            return el ? <ElRect key={r.elementId} r={el.bounds} cls="rule" /> : null;
          })}
        {flash && (
          <g key={flashKey}>
            {flash.ids.map((id) => {
              const el = idx?.get(id);
              return el ? <ElRect key={id} r={el.bounds} cls="flash" /> : null;
            })}
            {flash.region && flash.region.w > 1 && <ElRect r={flash.region} cls="flash" />}
          </g>
        )}
        {annSvgs.map(({ a, html }) => (
          <g key={a.id} className="ann" data-ann-id={a.id} dangerouslySetInnerHTML={{ __html: html }} />
        ))}
        {selectedAnn && <SelBox a={selectedAnn} pad={6 * unit} />}
        {hoverEl && <ElRect r={hoverEl.bounds} cls="hover" />}
      </svg>
    </div>
  );
});

function ElRect({ r, cls }: { r: Rect; cls: string }) {
  return <rect className={`el-outline ${cls}`} x={r.x} y={r.y} width={Math.max(1, r.w)} height={Math.max(1, r.h)} />;
}

function SelBox({ a, pad }: { a: Annotation; pad: number }) {
  const g = a.geometry;
  let b: Rect;
  if (g.type === "point") b = { x: g.x - 2 * pad, y: g.y - 5 * pad, w: 6 * pad, h: 5 * pad };
  else if (g.type === "rect") b = g;
  else if (g.type === "arrow") b = bboxOf([g.from, g.to]);
  else b = bboxOf(g.points);
  if (a.ink) b = bboxOf([[b.x, b.y], [b.x + b.w, b.y + b.h], ...a.ink.strokes.flatMap((s) => s.points)]);
  return <rect className="ann-sel-box" x={b.x - pad} y={b.y - pad} width={b.w + 2 * pad} height={b.h + 2 * pad} />;
}

export function elementLabel(el: UIElement): string {
  return el.label ?? el.type;
}

export { screenInfo };
