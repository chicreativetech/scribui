import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Annotation, UIElement } from "@scribui/core";
import { api } from "../api";
import { compileCurrent, describeElement, elementOf, useMarkers, useStore } from "../store";
import { focusTile, panToAnnotation } from "./Board";

export function Inspector() {
  const open = useStore((s) => s.inspectorOpen);
  const tab = useStore((s) => s.inspectorTab);
  const set = useStore((s) => s.set);
  const tabs: [typeof tab, string][] = [
    ["notes", "Notes"],
    ["review", "Review.md"],
    ["tree", "Tree"],
    ["rules", "rules.md"],
  ];
  return (
    <aside className={`float inspector ${open ? "" : "closed"}`}>
      <div className="tabs" role="tablist">
        {tabs.map(([k, label]) => (
          <button key={k} className={tab === k ? "on" : ""} onClick={() => set({ inspectorTab: k })} role="tab" aria-selected={tab === k}>
            {label}
          </button>
        ))}
      </div>
      {tab === "notes" && <NotesPane />}
      {tab === "review" && <ReviewPane />}
      {tab === "tree" && <TreePane />}
      {tab === "rules" && <RulesPane />}
    </aside>
  );
}

/* ───────── notes ───────── */

const KIND_GLYPH: Record<string, string> = {
  comment: "▸ comment",
  circle: "◯ circle",
  arrow: "→ arrow",
  rectangle: "□ rect",
  remove: "✕ remove",
  freehand: "∿ draw",
  rule: "§ rule",
  sketch: "✎ sketch",
};

function NotesPane() {
  const annotations = useStore((s) => s.annotations);
  const round = useStore((s) => s.round);
  const selectedId = useStore((s) => s.selectedId);
  const { markers, rules } = useMarkers();
  const compiled = useMemo(() => compileCurrent(), [annotations]); // eslint-disable-line react-hooks/exhaustive-deps
  const needsText = new Set(compiled?.review.instructions.filter((i) => i.needsText).flatMap((i) => i.annotationIds) ?? []);

  if (!round) return <div className="empty-pane">No round loaded.</div>;
  const roots = annotations.filter((a) => !(a.kind === "comment" && a.attachedTo));
  if (roots.length === 0)
    return (
      <div className="empty-pane">
        <div className="pane-head" style={{ padding: "0 0 12px" }}>
          <h3>No notes yet</h3>
        </div>
        Pick a tool on the left and mark up a screen.
        <br />
        <b>C</b> comment · <b>O</b> circle · <b>A</b> arrow · <b>X</b> remove
        <br />
        Every mark snaps to a real UI element.
      </div>
    );

  const byScreen = new Map<string, Annotation[]>();
  for (const a of roots) {
    const list = byScreen.get(a.screenId) ?? [];
    list.push(a);
    byScreen.set(a.screenId, list);
  }
  const order = round.screens.map((s) => s.id).filter((id) => byScreen.has(id));

  return (
    <div className="pane">
      <div className="pane-head">
        <h3>Round {String(round.round).padStart(3, "0")}</h3>
        <span className="dim">
          {roots.length} note{roots.length === 1 ? "" : "s"}
        </span>
      </div>
      {order.map((sid) => {
        const info = round.screens.find((s) => s.id === sid);
        const list = byScreen.get(sid)!.sort((a, b) => sortKey(a, markers, rules) - sortKey(b, markers, rules));
        return (
          <div key={sid} className="screen-sec">
            <div className="sh" onClick={() => focusTile(sid)}>
              <b>{info?.title ?? sid}</b>
              <span>{sid}</span>
            </div>
            {list.map((a) => {
              const attached = annotations.filter((c) => c.attachedTo === a.id);
              const texts = [a.text, ...attached.map((c) => c.text)].filter(Boolean).join(" · ");
              const inked = [a, ...attached].some((c) => c.ink?.handwriting);
              const unresolved = a.resolution?.status === "unresolved" && a.kind !== "rule";
              const num = a.kind === "rule" ? `U${rules.get(a.id)}` : String(markers.get(a.id) ?? "");
              const target = a.resolution?.elements[0] ? elementOf(a.screenId, a.resolution.elements[0]) : undefined;
              return (
                <div
                  key={a.id}
                  className={`note ${selectedId === a.id ? "sel" : ""}`}
                  onClick={() => {
                    useStore.getState().select(a.id);
                    panToAnnotation(a);
                  }}
                  onDoubleClick={() => useStore.getState().set({ editor: { annotationId: a.id, isNew: false } })}
                >
                  <div className={`num ${a.kind === "rule" ? "u" : unresolved ? "w" : ""}`}>{num}</div>
                  <div style={{ minWidth: 0 }}>
                    <div className="kind">
                      <span>{a.kind === "sketch" && a.sketch ? `✎ ${a.sketch.shape}` : KIND_GLYPH[a.kind]}</span>
                      {target && <span className="t">{describeElement(target)}</span>}
                      {!target && a.resolution?.status === "region" && <span className="t">empty area</span>}
                      {a.resolution?.elements && a.resolution.elements.length > 1 && (
                        <span className="dim">+{a.resolution.elements.length - 1}</span>
                      )}
                    </div>
                    <div className={`txt ${texts || inked ? "" : "empty"}`}>
                      {texts || (inked ? "✎ handwritten note" : "no text · double-click to add")}
                    </div>
                    <div className="flags">
                      {unresolved && <span className="warn">! unresolved</span>}
                      {needsText.has(a.id) && <span className="warn">needs text</span>}
                      {a.resolution?.confirmedByUser && <span className="ok">✓ target confirmed</span>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function sortKey(a: Annotation, markers: Map<string, number>, rules: Map<string, number>) {
  return a.kind === "rule" ? 10000 + (rules.get(a.id) ?? 0) : (markers.get(a.id) ?? 0);
}

/* ───────── review.md ───────── */

function ReviewPane() {
  const annotations = useStore((s) => s.annotations);
  const round = useStore((s) => s.round);
  const [sent, setSent] = useState<string | null>(null);
  const status = round?.status.status;
  useEffect(() => {
    setSent(null);
    if (round && (status === "sent" || status === "applied")) api.review(round.round).then(setSent);
  }, [round, status]);
  const md = useMemo(() => sent ?? compileCurrent()?.markdown ?? "", [annotations, sent]); // eslint-disable-line react-hooks/exhaustive-deps
  const copy = () => navigator.clipboard?.writeText(md);
  return (
    <div className="pane">
      <div className="pane-head">
        <h3>review.md</h3>
        <span className="dim">{sent ? "as sent" : "live preview"}</span>
      </div>
      <div className="pane-actions">
        <button className="btn" onClick={copy}>
          copy
        </button>
      </div>
      <pre className="md">{highlightMd(md)}</pre>
    </div>
  );
}

function highlightMd(md: string): ReactNode {
  return md.split("\n").map((line, i) => {
    let node: ReactNode = line;
    if (/^#{1,3} /.test(line)) node = <span className="h">{line}</span>;
    else if (/^Screenshot:|^When done|^App:/.test(line)) node = <span className="dimmed">{line}</span>;
    else if (line.includes("[UNRESOLVED]")) node = <span className="un">{line}</span>;
    else {
      const parts = line.split(/(\(id: [^)]+\)|\[R\d+-U?\d+\])/g);
      node = parts.map((p, j) =>
        /^\(id: /.test(p) || /^\[R\d+/.test(p) ? (
          <span key={j} className="id">
            {p}
          </span>
        ) : (
          <Fragment key={j}>{p}</Fragment>
        ),
      );
    }
    return (
      <Fragment key={i}>
        {node}
        {"\n"}
      </Fragment>
    );
  });
}

/* ───────── element tree ───────── */

function TreePane() {
  const focusId = useStore((s) => s.focusId);
  const selectedElement = useStore((s) => s.selectedElement);
  const selectedId = useStore((s) => s.selectedId);
  const annotations = useStore((s) => s.annotations);
  const hover = useStore((s) => s.hover);
  const round = useStore((s) => s.round);
  const selAnn = annotations.find((a) => a.id === selectedId);
  const screenId = selectedElement?.screenId ?? selAnn?.screenId ?? hover?.screenId ?? focusId ?? round?.screens.find((s) => s.captured)?.id;
  const cap = useStore((s) => (screenId ? s.captures.get(screenId) : undefined));
  const selId = selectedElement?.elementId ?? selAnn?.resolution?.elements[0];

  if (!cap) return <div className="empty-pane">Hover or focus a screen to see its element tree.</div>;
  const rows: { el: UIElement; prefix: string }[] = [];
  const walk = (el: UIElement, prefix: string, last: boolean, depth: number) => {
    rows.push({ el, prefix: depth === 0 ? "" : prefix + (last ? "└─ " : "├─ ") });
    el.children.forEach((c, i) => walk(c, depth === 0 ? "" : prefix + (last ? "   " : "│  "), i === el.children.length - 1, depth + 1));
  };
  walk(cap.root, "", true, 0);
  return (
    <div className="pane">
      <div className="pane-head">
        <h3>{round?.screens.find((s) => s.id === screenId)?.title ?? screenId}</h3>
        <span className="dim">
          {rows.length} el · {cap.platform} @{cap.device.scale}x
        </span>
      </div>
      <div className="tree">
        {rows.map(({ el, prefix }) => (
          <div
            key={el.id}
            className={`row ${el.id === selId ? "sel" : ""}`}
            onClick={() => useStore.getState().set({ selectedElement: { screenId: cap.screenId, elementId: el.id }, selectedId: null })}
            onMouseEnter={() => useStore.getState().set({ hover: { screenId: cap.screenId, stack: [el], level: 0, px: [el.bounds.x, el.bounds.y] } })}
            onMouseLeave={() => useStore.getState().set({ hover: null })}
            title={`${el.id}\n${el.bounds.x},${el.bounds.y} ${el.bounds.w}×${el.bounds.h}px${el.nativeType ? `\n${el.nativeType}` : ""}`}
          >
            <span className="br">{prefix}</span>
            <span className="ty">{el.type}</span>
            <span className={`id ${el.idSource === "generated" ? "gen" : ""}`}>
              {el.idSource === "generated" ? "·" : `#${el.id}`}
            </span>
            {el.label && <span className="lb">"{el.label}"</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ───────── rules.md ───────── */

function RulesPane() {
  const [md, setMd] = useState<string | null>(null);
  const status = useStore((s) => s.round?.status.status);
  useEffect(() => {
    api.rules().then(setMd).catch(() => setMd(""));
  }, [status]);
  return (
    <div className="pane">
      <div className="pane-head">
        <h3>rules.md</h3>
        <span className="dim">persistent · edit by hand</span>
      </div>
      <pre className="md">{md === null ? "…" : highlightMd(md || "No rules yet. Use the rule tool (U).")}</pre>
    </div>
  );
}
