import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { compileCurrent, useStore } from "../store";

export function SendDialog() {
  const open = useStore((s) => s.sendOpen);
  const round = useStore((s) => s.round);
  const annotations = useStore((s) => s.annotations);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // compileCurrent reads the store; `annotations` is here to recompile when they change
  const compiled = useMemo(() => (open ? compileCurrent() : null), [open, annotations]); // eslint-disable-line react-hooks/exhaustive-deps
  const sendRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") useStore.getState().set({ sendOpen: false });
      if (e.key === "Enter") {
        e.preventDefault();
        void sendRef.current();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  if (!open || !round || !compiled) return null;
  const { counts, instructions } = compiled.review;
  const unresolved = instructions.filter((i) => i.status === "unresolved");
  const needsText = instructions.filter((i) => i.needsText);

  sendRef.current = doSend;
  async function doSend() {
    if (busy || !round) return;
    setBusy(true);
    try {
      // make sure the latest edits are on disk before compiling server-side
      await api.saveAnnotations(round.round, useStore.getState().annotations);
      const r = await api.send(round.round);
      useStore.getState().set({ sendOpen: false, sentPrompt: r.prompt });
      await useStore.getState().load(round.round);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="scrim" onClick={() => useStore.getState().set({ sendOpen: false })}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Send to agent">
        <div className="mh">
          <span>send · round {String(round.round).padStart(3, "0")}</span>
          <span>
            <kbd>esc</kbd>
          </span>
        </div>
        <div className="mb">
          <h2>
            Send <span className="accent">{counts.instructions}</span> instruction{counts.instructions === 1 ? "" : "s"}
            <br />
            to your agent.
          </h2>
          <div className="stats">
            <div>
              <div className="v">{counts.instructions}</div>
              <div className="k">instructions</div>
            </div>
            <div>
              <div className="v" style={{ color: counts.unresolved ? "var(--yellow)" : undefined }}>{counts.unresolved}</div>
              <div className="k">unresolved</div>
            </div>
            <div>
              <div className="v" style={{ color: counts.needsText ? "var(--yellow)" : undefined }}>{counts.needsText}</div>
              <div className="k">need text</div>
            </div>
            <div>
              <div className="v">{counts.rules}</div>
              <div className="k">new rules</div>
            </div>
          </div>
          {(unresolved.length > 0 || needsText.length > 0) && (
            <div className="issues">
              {unresolved.map((i) => (
                <div key={i.id}>
                  <b>{i.marker}</b> unresolved: the agent will ask you about it
                </div>
              ))}
              {needsText.map((i) => (
                <div key={i.id}>
                  <b>{i.marker}</b> has no text: the agent only gets "review this"
                </div>
              ))}
            </div>
          )}
          <div className="dim" style={{ fontSize: 11.5, lineHeight: 1.6 }}>
            Writes <span style={{ color: "var(--fg)" }}>review.md</span>, <span style={{ color: "var(--fg)" }}>review.json</span> and
            annotated screenshots to <span style={{ color: "var(--fg)" }}>.intentcue/rounds/{String(round.round).padStart(3, "0")}/</span>,
            appends rules, and locks the round.
          </div>
          {error && <div className="err" style={{ marginTop: 10 }}>✗ {error}</div>}
          <div className="actions">
            <button className="btn" onClick={() => useStore.getState().set({ sendOpen: false })}>
              cancel
            </button>
            <button className="btn primary" onClick={() => void doSend()} disabled={busy || counts.instructions + counts.rules === 0}>
              {busy ? "Sending…" : "Send"} <kbd style={{ marginLeft: 6 }}>⏎</kbd>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function SentDialog() {
  const prompt = useStore((s) => s.sentPrompt);
  const platform = useStore((s) => s.round?.app?.platform);
  const build = useStore((s) => s.round?.app?.build);
  const mobile = platform === "android" || platform === "ios";
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!prompt) return;
    setCopied(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter") useStore.getState().set({ sentPrompt: null });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [prompt]);
  if (!prompt) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
    } catch {
      /* clipboard blocked */
    }
  };
  return (
    <div className="scrim" onClick={() => useStore.getState().set({ sentPrompt: null })}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="mh">
          <span className="ok">✓ sent</span>
          <span>
            <kbd>esc</kbd>
          </span>
        </div>
        <div className="mb">
          <h2>
            Round sent<span className="accent">.</span>
          </h2>
          <div className="dim">Paste this into your coding agent:</div>
          <div className="prompt-box">
            <code>{prompt}</code>
            <button onClick={copy}>{copied ? "copied ✓" : "copy"}</button>
          </div>
          <div className="next-steps">
            {mobile ? (
              <>
                <div>
                  <b>1</b> Your agent implements the changes.
                </div>
                <div>
                  <b>2</b> Rebuild and reinstall the app{build ? <span className="dim"> ({build})</span> : null}.
                </div>
                <div>
                  <b>3</b> Press <b>{build ? "Rebuild & recapture" : "↻ Recapture"}</b> here. Only changed screens are captured.
                </div>
              </>
            ) : (
              <>
                <div>
                  <b>1</b> Your agent implements the changes and marks the round applied.
                </div>
                <div>
                  <b>2</b> intentcue recaptures the changed screens automatically and shows the next round here.
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const KEYS: [string, [string, string][]][] = [
  [
    "Tools",
    [
      ["V", "select · drag to pan"],
      ["C", "comment"],
      ["O", "circle"],
      ["A", "arrow (can end on another tile)"],
      ["R", "rectangle: add something here"],
      ["X", "remove element"],
      ["P", "freehand"],
      ["U", "rule: shift-click elements, ⏎"],
    ],
  ],
  [
    "Elements",
    [
      ["alt", "cycle hovered element: child → parent"],
      ["E", "show all element outlines"],
      ["click chip", "change target: parent, child, empty"],
    ],
  ],
  [
    "Board",
    [
      ["space + drag", "pan"],
      ["scroll", "pan"],
      ["⌘/ctrl + scroll", "zoom (or pinch)"],
      ["double-click", "focus a screen"],
      ["esc", "leave focus · close"],
      ["F", "fit all"],
      ["L", "web: switch between the board and your app"],
      ["delete", "on a focused view: remove it from the round"],
      ["1 / 0", "zoom 100% / fit"],
      ["tab", "toggle panel"],
    ],
  ],
  [
    "Edit",
    [
      ["⌘Z / ⌘⇧Z", "undo / redo"],
      ["⌫", "delete selected"],
      ["⏎", "edit selected note"],
      ["N", "next unresolved"],
      [":", "command line"],
      ["⌘⏎", "send to agent"],
    ],
  ],
];

export function HelpDialog() {
  const open = useStore((s) => s.helpOpen);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "?") {
        e.stopPropagation();
        useStore.getState().set({ helpOpen: false });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);
  if (!open) return null;
  return (
    <div className="scrim" onClick={() => useStore.getState().set({ helpOpen: false })}>
      <div className="modal" style={{ width: "min(760px, 100%)" }} onClick={(e) => e.stopPropagation()}>
        <div className="mh">
          <span>keys</span>
          <span>
            <kbd>esc</kbd>
          </span>
        </div>
        <div className="mb">
          <h2>
            Point, don't describe<span className="accent">.</span>
          </h2>
          <div className="help-grid">
            {[KEYS.slice(0, 2), KEYS.slice(2)].map((col, i) => (
              <div key={i}>
                {col.map(([title, rows]) => (
                  <div key={title}>
                    <h4>{title}</h4>
                    {rows.map(([k, v]) => (
                      <div className="r" key={k}>
                        <span>{v}</span>
                        <span>
                          <kbd>{k}</kbd>
                        </span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div className="dim" style={{ marginTop: 16, fontSize: 11 }}>
            Pen: the first stroke with a stylus (Apple Pencil, S Pen, Surface Pen) turns on pen mode. Loops become circles, hooked lines arrows, crossings removals,
            short strokes handwriting. Tap the chip to change it.
          </div>
        </div>
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone ?? ""}`}>
          <span>{t.text}</span>
          {t.action && (
            <button
              onClick={() => {
                t.action!.run();
                useStore.getState().dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          {t.action && (
            <button className="dim" onClick={() => useStore.getState().dismissToast(t.id)} style={{ color: "var(--fg-faint)" }}>
              ✕
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
