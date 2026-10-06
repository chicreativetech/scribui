import { useState, type ReactNode } from "react";
import type { Annotation, SketchStyle, VisionItem } from "@scribui/core";
import { isSketchTool, tileOf, TOOLS, useStore, VISION_HINTS, type StyledTool } from "../store";
import { measureText, useVision } from "../vision";

/**
 * The settings / info box for the current tool, or for what is selected:
 * colour, stroke width, fill and text size, plus rotation and order for vision items.
 */

const SWATCHES = ["#262626", "#8A8A8A", "#FFFFFF", "#FC9803", "#F2D100", "#E5484D", "#30A46C", "#3E63DD", "#8E4EC6"];

type Shape = "freehand" | "line" | "box" | "ellipse" | "text" | "image";

export function ToolSettings() {
  const view = useStore((s) => s.view);
  const tool = useStore((s) => s.tool);
  const styles = useStore((s) => s.toolStyles);
  const selectedAnn = useStore((s) => (s.selectedId ? s.annotations.find((a) => a.id === s.selectedId) : undefined));
  const item = useVision((s) => (s.selectedId ? s.doc.items.find((i) => i.id === s.selectedId) : undefined));
  if (view === "live") return null;
  const vision = view === "vision";

  // something selected with the select tool: edit it
  if (tool === "select" && vision && item) return <ItemSettings item={item} />;
  if (tool === "select" && !vision && selectedAnn?.kind === "sketch" && selectedAnn.sketch) return <SketchSettings a={selectedAnn} />;
  if (tool === "select") return null;

  const info = TOOLS.find((t) => t.tool === tool);
  const styled = (isSketchTool(tool) || (tool === "freehand" && vision)) as boolean;
  return (
    <Box title={info?.label ?? tool} keyHint={info?.key} hint={(vision && VISION_HINTS[tool]) || info?.hint}>
      {!vision && isSketchTool(tool) && <p className="ts-note">Draws on screens only. Use Vision to draw anywhere.</p>}
      {!vision && tool === "freehand" && <p className="ts-note">On screens, a loop circles something and a line is a note.</p>}
      {styled && (
        <StyleControls
          shape={tool as StyledTool}
          style={styles[tool as StyledTool]}
          onChange={(patch) => useStore.getState().setToolStyle(tool as StyledTool, patch)}
        />
      )}
    </Box>
  );
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem("scribui:settings-collapsed") === "1";
  } catch {
    return false;
  }
}

function Box({ title, keyHint, hint, children }: { title: string; keyHint?: string; hint?: string; children?: ReactNode }) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = () => {
    setCollapsed(!collapsed);
    try {
      localStorage.setItem("scribui:settings-collapsed", collapsed ? "0" : "1");
    } catch {
      /* storage blocked */
    }
  };
  return (
    <aside className={`float tool-settings ${collapsed ? "collapsed" : ""}`} aria-label={`${title} settings`} onPointerDown={(e) => e.stopPropagation()}>
      <div className="ts-head">
        <b>{title}</b>
        {keyHint && <kbd>{keyHint}</kbd>}
        <button className="ts-collapse" onClick={toggle} aria-expanded={!collapsed} title={collapsed ? "show settings" : "hide settings"}>
          {collapsed ? "+" : "–"}
        </button>
      </div>
      {!collapsed && hint && <p className="ts-hint">{hint}</p>}
      {!collapsed && children}
    </aside>
  );
}

function StyleControls({ shape, style, onChange }: { shape: Shape; style: SketchStyle; onChange: (p: Partial<SketchStyle>) => void }) {
  return (
    <div className="ts-controls">
      <Row label="Colour">
        <Swatches label="colour" value={style.color} onPick={(color) => onChange({ color })} />
      </Row>
      {shape !== "text" && (
        <Row label="Stroke" value={`${style.width}px`}>
          <input type="range" min={1} max={40} step={1} value={style.width} onChange={(e) => onChange({ width: Number(e.target.value) })} aria-label="stroke width" />
        </Row>
      )}
      {(shape === "box" || shape === "ellipse") && (
        <Row label="Fill">
          <Swatches label="fill" value={style.fill} none onPick={(fill) => onChange({ fill })} />
        </Row>
      )}
      {shape === "text" && (
        <Row label="Size" value={`${style.size ?? 32}px`}>
          <input type="range" min={8} max={160} step={1} value={style.size ?? 32} onChange={(e) => onChange({ size: Number(e.target.value) })} aria-label="text size" />
        </Row>
      )}
    </div>
  );
}

function Row({ label, value, children }: { label: string; value?: string; children: ReactNode }) {
  return (
    <div className="ts-row">
      <div className="ts-label">
        <span>{label}</span>
        {value && <span className="dim">{value}</span>}
      </div>
      {children}
    </div>
  );
}

function Swatches({ label, value, none, onPick }: { label: string; value?: string; none?: boolean; onPick: (c: string | undefined) => void }) {
  const custom = value && !SWATCHES.includes(value.toUpperCase()) ? value : undefined;
  return (
    <div className="swatches">
      {none && (
        <button className={`swatch none ${value ? "" : "on"}`} onClick={() => onPick(undefined)} title="no fill" aria-label="no fill" aria-pressed={!value} />
      )}
      {SWATCHES.map((c) => (
        <button
          key={c}
          className={`swatch ${value?.toUpperCase() === c ? "on" : ""}`}
          style={{ background: c }}
          onClick={() => onPick(c)}
          title={c}
          aria-label={`${label} ${c}`}
          aria-pressed={value?.toUpperCase() === c}
        />
      ))}
      <label className={`swatch custom ${custom ? "on" : ""}`} title="custom colour" style={custom ? { background: custom } : undefined}>
        <input type="color" value={value ?? "#262626"} onChange={(e) => onPick(e.target.value)} aria-label={`custom ${label}`} />
      </label>
    </div>
  );
}

/* ───────── vision item ───────── */

const ITEM_TITLE: Record<VisionItem["type"], string> = { stroke: "drawing", line: "line", box: "box", ellipse: "ellipse", text: "text", image: "image" };

function ItemSettings({ item }: { item: VisionItem }) {
  const v = useVision.getState();
  const restyle = (patch: Partial<SketchStyle>) =>
    v.update(
      item.id,
      (i) => {
        if (i.type === "image") return i;
        const style = { ...i.style, ...patch };
        if (i.type === "text" && patch.size) return { ...i, style, ...measureText(i.text, patch.size) };
        return { ...i, style } as VisionItem;
      },
      { coalesce: `${item.id}:${Object.keys(patch).join()}` },
    );
  const rotatable = item.type === "image" || item.type === "box" || item.type === "ellipse" || item.type === "text";
  const rotation = rotatable ? (item.rotation ?? 0) : 0;
  const setRotation = (deg: number) => v.update(item.id, (i) => ({ ...i, rotation: deg }) as VisionItem, { coalesce: `${item.id}:rot` });

  return (
    <Box title={ITEM_TITLE[item.type]} hint={item.type === "text" ? "double-click to edit the words" : "drag to move, corners resize"}>
      {item.type !== "image" && <StyleControls shape={item.type === "stroke" ? "freehand" : item.type} style={item.style} onChange={restyle} />}
      {rotatable && (
        <div className="ts-controls">
          <Row label="Rotation" value={`${rotation}°`}>
            <input type="range" min={-180} max={180} step={1} value={rotation} onChange={(e) => setRotation(Number(e.target.value))} aria-label="rotation" />
          </Row>
        </div>
      )}
      <div className="ts-actions">
        {rotatable && rotation !== 0 && (
          <button className="item" onClick={() => setRotation(0)}>
            Straighten
          </button>
        )}
        <button className="item" onClick={() => v.reorder(item.id, "front")} title="bring to front">
          Front
        </button>
        <button className="item" onClick={() => v.reorder(item.id, "back")} title="send to back">
          Back
        </button>
        <button className="item danger" onClick={() => v.remove(item.id)} title="delete (⌫)">
          Delete
        </button>
      </div>
    </Box>
  );
}

/* ───────── board sketch ───────── */

/** A sketch on a screen; its style is stored in screenshot pixels, shown in points. */
function SketchSettings({ a }: { a: Annotation }) {
  const scale = tileOf(a.screenId)?.scale ?? 1;
  const sk = a.sketch!;
  const shown: SketchStyle = { ...sk.style, width: round(sk.style.width / scale), ...(sk.style.size ? { size: round(sk.style.size / scale) } : {}) };
  const onChange = (patch: Partial<SketchStyle>) =>
    useStore.getState().update(
      a.id,
      (x) => {
        const style = { ...x.sketch!.style, ...patch };
        if (patch.width) style.width = patch.width * scale;
        if (patch.size) style.size = patch.size * scale;
        const next: Annotation = { ...x, sketch: { ...x.sketch!, style } };
        if (patch.size && x.geometry.type === "rect") {
          const m = measureText(x.text ?? "", patch.size);
          next.geometry = { ...x.geometry, w: round(m.w * scale), h: round(m.h * scale) };
        }
        return next;
      },
      { coalesce: `${a.id}:${Object.keys(patch).join()}` },
    );
  return (
    <Box title={`${sk.shape} sketch`} hint="new content for this screen, placed where it is drawn">
      <StyleControls shape={sk.shape} style={shown} onChange={onChange} />
    </Box>
  );
}

const round = (n: number) => Math.round(n * 10) / 10;
