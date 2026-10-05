import { useMemo } from "react";
import { TOOLS, isReadOnly, unresolvedCount, useStore } from "../store";
import { Spinner } from "./Capture";
import { showLive } from "./Live";

/* ───────── top bar ───────── */

export function TopBar({ onSend }: { onSend: () => void }) {
  const round = useStore((s) => s.round);
  const rounds = useStore((s) => s.rounds);
  const annotations = useStore((s) => s.annotations);
  const penMode = useStore((s) => s.penMode);
  const showOutlines = useStore((s) => s.showOutlines);
  const inspectorOpen = useStore((s) => s.inspectorOpen);
  const project = useStore((s) => s.project);
  const unresolved = useMemo(() => unresolvedCount(annotations), [annotations]);
  const captured = round?.screens.filter((s) => s.captured).length ?? 0;
  const failed = round?.screens.filter((s) => s.error).length ?? 0;
  const appName =
    round?.app?.name ?? (project && "app" in project.manifest ? project.manifest.app.name : undefined) ?? "intentcue";
  const status = round?.status.status;
  const ro = isReadOnly();
  const count = annotations.filter((a) => !(a.kind === "comment" && a.attachedTo)).length;
  const cs = useStore((s) => s.captureState);
  const ext = useStore((s) => s.externalCapture);
  const lan = useStore((s) => s.lan);
  const canCapture = useStore((s) => !!s.project?.canCapture);
  const platform = round?.app?.platform ?? (project && "app" in project.manifest ? project.manifest.app.platform : undefined);
  const mobile = platform === "android" || platform === "ios";
  const capturing = cs.running || !!ext;
  const view = useStore((s) => s.view);

  return (
    <header className="bar">
      <div className="seg brand">
        <span className="sq" />
        <span>intentcue</span>
      </div>
      <div className="seg">
        <span className="app-name">{appName}</span>
        {mobile && (
          <span className="pill beta" title="Mobile capture is in beta">
            {platform} beta
          </span>
        )}
      </div>
      {platform === "web" && (
        <div className="seg view-switch">
          <button className={`toggle ${view === "board" ? "on" : ""}`} onClick={() => useStore.getState().set({ view: "board" })} title="review board (L)">
            ▦ <span className="hide-sm">board</span>
          </button>
          <button className={`toggle ${view === "live" ? "on" : ""}`} onClick={showLive} title="your running app: browse and capture views (L)">
            ◉ <span className="hide-sm">app</span>
          </button>
        </div>
      )}
      {round && (
        <div className="seg">
          <select
            className="round-select"
            value={round.round}
            onChange={(e) => useStore.getState().load(Number(e.target.value))}
            title="round"
          >
            {[...rounds].reverse().map((r) => (
              <option key={r.round} value={r.round}>
                R{String(r.round).padStart(3, "0")}
              </option>
            ))}
          </select>
          <span className={`pill ${status}`}>{status}</span>
        </div>
      )}
      {round && (
        <div className="seg hide-sm">
          <span>
            {captured} <span className="dim">screen{captured === 1 ? "" : "s"}</span>
          </span>
          {failed > 0 && <span className="err">{failed} failed</span>}
          <span className="faint">│</span>
          <span>
            {count} <span className="dim">note{count === 1 ? "" : "s"}</span>
          </span>
          {unresolved > 0 && <span className="warn">! {unresolved} unresolved</span>}
        </div>
      )}
      <div className="seg grow">
        <button
          className={`toggle ${showOutlines ? "on" : ""}`}
          onClick={() => useStore.getState().set({ showOutlines: !showOutlines })}
          title="show all element outlines (E)"
        >
          ⌗ <span className="hide-sm">elements</span>
        </button>
        <button
          className={`toggle ${penMode ? "on" : ""}`}
          onClick={() => useStore.getState().set({ penMode: !penMode })}
          title="pen mode: pen draws, touch pans (turns on with the first pen stroke)"
        >
          ✎ <span className="hide-sm">pen</span>
        </button>
        <button
          className={`toggle ${lan.paired > 0 ? "on" : ""}`}
          onClick={() => useStore.getState().set({ lanOpen: true })}
          title="review on a tablet: show a pairing QR code"
        >
          ▣ <span className="hide-sm">tablet{lan.paired > 0 ? ` · ${lan.paired}` : ""}</span>
        </button>
        <button
          className={`toggle ${inspectorOpen ? "on" : ""}`}
          onClick={() => useStore.getState().set({ inspectorOpen: !inspectorOpen })}
          title="inspector (tab)"
        >
          ▤ <span className="hide-sm">panel</span>
        </button>
      </div>
      {canCapture && (
        <button
          className="recap-btn"
          onClick={() => void useStore.getState().captureNext()}
          disabled={capturing}
          title="capture the next round: only screens that changed are recaptured (:capture all for everything)"
        >
          {capturing ? (
            <>
              <Spinner /> {cs.phase === "building" ? "building" : `capturing${(cs.total ?? ext?.total) ? ` ${cs.done ?? ext?.done ?? 0}/${cs.total ?? ext?.total}` : ""}`}
            </>
          ) : (
            <>↻ Recapture</>
          )}
        </button>
      )}
      <button className="send-btn" onClick={onSend} disabled={!round || ro || status === "capturing" || capturing}>
        {status === "sent" ? "Sent to agent" : status === "applied" ? "Applied" : "Send to agent"}
        {!ro && <kbd>⌘⏎</kbd>}
      </button>
    </header>
  );
}

/* ───────── tool rail ───────── */

export function ToolRail() {
  const tool = useStore((s) => s.tool);
  const ro = useStore((s) => !s.round || s.round.status.status === "sent" || s.round.status.status === "applied");
  return (
    <nav className="rail" aria-label="tools">
      {TOOLS.map((t, i) => (
        <div key={t.tool}>
          {i === 1 && <div className="sep" />}
          <button
            className={`tool ${tool === t.tool ? "active" : ""}`}
            onClick={() => useStore.getState().setTool(t.tool)}
            disabled={ro && t.tool !== "select"}
            aria-label={`${t.label} (${t.key})`}
          >
            <span className="k">{t.key}</span>
            <span className="l">{t.label}</span>
            <span className="tip">
              <b>{t.label}</b> <span className="dim">— {t.hint}</span>
            </span>
          </button>
        </div>
      ))}
      <div className="sep" />
      <button className="tool" onClick={() => useStore.getState().undo()} aria-label="undo">
        <span className="k">↶</span>
        <span className="l">undo</span>
        <span className="tip">undo <kbd>⌘Z</kbd></span>
      </button>
      <button className="tool" onClick={() => useStore.getState().redo()} aria-label="redo">
        <span className="k">↷</span>
        <span className="l">redo</span>
        <span className="tip">redo <kbd>⌘⇧Z</kbd></span>
      </button>
      <div style={{ flex: 1 }} />
      <button className="tool" onClick={() => useStore.getState().set({ helpOpen: true })} aria-label="help">
        <span className="k">?</span>
        <span className="l">keys</span>
      </button>
    </nav>
  );
}

/* ───────── status line ───────── */

export function StatusLine({ onCommand }: { onCommand: (cmd: string) => void }) {
  const tool = useStore((s) => s.tool);
  const penMode = useStore((s) => s.penMode);
  const editor = useStore((s) => s.editor);
  const command = useStore((s) => s.command);
  const cursor = useStore((s) => s.cursorPx);
  const hover = useStore((s) => s.hover);
  const zoom = useStore((s) => s.camera.zoom);
  const connected = useStore((s) => s.connected);
  const saveState = useStore((s) => s.saveState);
  const capture = useStore((s) => s.capture);
  const ruleTargets = useStore((s) => s.ruleTargets);
  const focusId = useStore((s) => s.focusId);
  const ro = useStore((s) => !s.round || s.round.status.status === "sent" || s.round.status.status === "applied");
  const el = hover ? hover.stack[hover.level] : null;
  const toolInfo = TOOLS.find((t) => t.tool === tool);

  const mode = command !== null ? "COMMAND" : editor ? "INSERT" : ro ? "READ-ONLY" : penMode ? "PEN" : "NORMAL";
  const modeCls = command !== null ? "cmd" : editor ? "insert" : ro ? "ro" : penMode ? "pen" : "";

  return (
    <footer className="status">
      <div className={`mode ${modeCls}`}>{mode}</div>
      {command !== null ? (
        <div className="cmdline">
          <span className="accent">:</span>
          <input
            autoFocus
            value={command}
            onChange={(e) => useStore.getState().set({ command: e.target.value })}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                const c = command;
                useStore.getState().set({ command: null });
                onCommand(c);
              } else if (e.key === "Escape" || (e.key === "Backspace" && command === "")) {
                useStore.getState().set({ command: null });
              }
            }}
            onBlur={() => useStore.getState().set({ command: null })}
            spellCheck={false}
            placeholder="send · fit · recapture [id|stale|all] · outlines · pen · theme light|dark · round <n> · zoom <pct> · next · help"
          />
        </div>
      ) : (
        <>
          <div className="cell">
            <span className="v">{toolInfo?.label}</span>
            {tool === "rule" && ruleTargets.length > 0 && (
              <span className="accent">
                {ruleTargets.length} selected · ⏎ to write the rule
              </span>
            )}
            {tool !== "rule" && <span className="hide-sm">{toolInfo?.hint}</span>}
          </div>
          {focusId && (
            <div className="cell hide-sm">
              focus <span className="v">{focusId}</span> <span className="faint">esc</span>
            </div>
          )}
          <div className="cell grow">
            {cursor && (
              <span>
                <span className="v">{cursor.screenId}</span> {cursor.x},{cursor.y}px
              </span>
            )}
            {el && (
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                <span className="faint">│</span> <span style={{ color: "var(--cyan)" }}>{el.type}</span>
                {el.idSource !== "generated" && <span className="v"> #{el.id}</span>}
                {el.label && <span> "{el.label.slice(0, 40)}"</span>}
                <span className="faint"> [{el.idSource}]</span>
                {el.source && <span className="faint"> {el.source.component ?? ""} {el.source.file}</span>}
              </span>
            )}
          </div>
          {capture && (
            <div className="cell">
              <span className="warn">capturing R{String(capture.round).padStart(3, "0")}</span>
              <span className="v">{capture.screens.length}</span>
            </div>
          )}
          <div className="cell hide-sm">{Math.round(zoom * 100)}%</div>
          <div className="cell">
            {saveState === "saving" ? (
              <span className="warn">○ saving</span>
            ) : saveState === "error" ? (
              <span className="err">✗ not saved</span>
            ) : (
              <span className="dim">● saved</span>
            )}
          </div>
          <div className="cell" title={connected ? "live: updates from the agent arrive instantly" : "disconnected"}>
            <span className={`dot ${connected ? "on" : ""}`} /> {connected ? "live" : "offline"}
          </div>
          <div className="cell hide-sm">
            <span className="faint">:</span>cmd <span className="faint">?</span>keys
          </div>
        </>
      )}
    </footer>
  );
}
