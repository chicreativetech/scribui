import { useMemo, type ReactNode } from "react";
import { TOOLS, VISION_HINTS, isReadOnly, unresolvedCount, useStore, type Tool } from "../store";
import { useVision } from "../vision";
import { Spinner } from "./Capture";
import { showLive } from "./Live";
import selectIcon from "../assets/icons/select.png";
import commentIcon from "../assets/icons/comment.png";
import circleIcon from "../assets/icons/circle.png";
import arrowIcon from "../assets/icons/arrow.svg";
import removeIcon from "../assets/icons/remove.svg";
import ruleIcon from "../assets/icons/rule.svg";
import penIcon from "../assets/icons/pen.svg";
import lineIcon from "../assets/icons/line.svg";
import recaptureIcon from "../assets/icons/recapture.svg";
import tabletIcon from "../assets/icons/tablet.svg";
import panelIcon from "../assets/icons/panel.svg";
import elementsIcon from "../assets/icons/elements.svg";

const pad = (n: number) => String(n).padStart(3, "0");

/* ───────── top bar: floating status pills ───────── */

export function TopBar() {
  const round = useStore((s) => s.round);
  const rounds = useStore((s) => s.rounds);
  const annotations = useStore((s) => s.annotations);
  const project = useStore((s) => s.project);
  const view = useStore((s) => s.view);
  const unresolved = useMemo(() => unresolvedCount(annotations), [annotations]);
  const failed = round?.screens.filter((s) => s.error).length ?? 0;
  const appName =
    round?.app?.name ??
    (project && "app" in project.manifest ? project.manifest.app.name : undefined) ??
    "ScribUI";
  const platform =
    round?.app?.platform ??
    (project && "app" in project.manifest ? project.manifest.app.platform : undefined);
  const mobile = platform === "android" || platform === "ios";
  const status = round?.status.status;
  const count = annotations.filter((a) => !(a.kind === "comment" && a.attachedTo)).length;

  return (
    <header className="bar">
      <div className="pills">
        {view === "live" && (
          <div className="float pill-box brand-pill" aria-label="ScribUI">
            <span className="logo">
              <span className="logo-back" />
              <span className="logo-front" />
              <span className="logo-name">ScribUI</span>
            </span>
          </div>
        )}
        <div className="float pill-box" title={appName}>
          <span className="app-name">{appName}</span>
          {mobile && (
            <span className="badge beta" title={`${platform} capture is in beta`}>
              Beta
            </span>
          )}
        </div>
        {round && (
          <div className="float pill-box">
            <select
              className="round-select"
              value={round.round}
              onChange={(e) => useStore.getState().load(Number(e.target.value))}
              title="round"
            >
              {[...rounds].reverse().map((r) => (
                <option key={r.round} value={r.round}>
                  R{pad(r.round)}
                </option>
              ))}
            </select>
            <span className={`badge ${status}`}>{status}</span>
          </div>
        )}
        {round && (
          <div className="float pill-box hide-sm">
            <span>
              {count} Note{count === 1 ? "" : "s"}
            </span>
            {unresolved > 0 && <span className="badge beta">{unresolved} unresolved</span>}
            {failed > 0 && <span className="badge failed">{failed} failed</span>}
          </div>
        )}
      </div>
      <div className="float pill-box view-switch" role="tablist" aria-label="view">
        <button
          className={`item ${view === "vision" ? "on" : ""}`}
          onClick={() => showView("vision")}
          role="tab"
          aria-selected={view === "vision"}
          title="vision: sketch the visual direction on blank canvases"
        >
          Vision
        </button>
        {platform === "web" && (
          <button
            className={`item ${view === "live" ? "on" : ""}`}
            onClick={showLive}
            role="tab"
            aria-selected={view === "live"}
            title="your running app: browse and capture views (L)"
          >
            App
          </button>
        )}
        <button
          className={`item ${view === "board" ? "on" : ""}`}
          onClick={() => showView("board")}
          role="tab"
          aria-selected={view === "board"}
          title="review board: mark up the captured screens"
        >
          Board
        </button>
      </div>
    </header>
  );
}

/** Switch view; tools that don't exist in the new view fall back to select. */
export function showView(view: "vision" | "board") {
  const st = useStore.getState();
  st.set({ view });
  if (view === "vision" && !VISION_TOOLS.includes(st.tool)) st.setTool("select");
}

/* ───────── recapture & send ───────── */

export function ActionBar({ onSend }: { onSend: () => void }) {
  const round = useStore((s) => s.round);
  const cs = useStore((s) => s.captureState);
  const ext = useStore((s) => s.externalCapture);
  const canCapture = useStore((s) => !!s.project?.canCapture);
  const status = round?.status.status;
  const ro = isReadOnly();
  const capturing = cs.running || !!ext;

  return (
    <div className="float actions-float">
      {canCapture && (
        <button
          className="item recap-btn"
          onClick={() => void useStore.getState().captureNext()}
          disabled={capturing}
          title="capture the next round: only screens that changed are recaptured (:capture all for everything)"
        >
          {capturing ? (
            <>
              <Spinner />{" "}
              {cs.phase === "building"
                ? "building"
                : `capturing${(cs.total ?? ext?.total) ? ` ${cs.done ?? ext?.done ?? 0}/${cs.total ?? ext?.total}` : ""}`}
            </>
          ) : (
            <>
              <img className="icon" src={recaptureIcon} width={12} height={12} alt="" />
              Recapture
            </>
          )}
        </button>
      )}
      <button
        className="send-btn"
        onClick={onSend}
        disabled={!round || ro || status === "capturing" || capturing}
        title={ro ? undefined : "send to agent (⌘⏎)"}
      >
        {status === "sent" ? "Sent to agent" : status === "applied" ? "Applied" : "Send to agent"}
      </button>
    </div>
  );
}

/* ───────── tool panel ───────── */

const ICONS: Partial<Record<Tool, ReactNode>> = {
  select: <img className="icon" src={selectIcon} width={12} height={12} alt="" />,
  comment: <img className="icon" src={commentIcon} width={14} height={14} alt="" />,
  arrow: <img className="icon" src={arrowIcon} width={14.938} height={14.938} alt="" />,
  rectangle: (
    <svg className="glyph-select-rect" width={12} height={12} viewBox="0 0 12 12" aria-hidden>
      <rect x={1} y={1} width={10} height={10} strokeWidth={2} strokeDasharray="2 2" />
    </svg>
  ),
  remove: <img className="icon" src={removeIcon} width={9} height={9} alt="" />,
  circle: <img className="icon" src={circleIcon} width={14} height={14} alt="" />,
  rule: <img className="icon" src={ruleIcon} width={16} height={16} alt="" />,
  freehand: <img className="icon" src={penIcon} width={12} height={12} alt="" />,
};

ICONS.line = <img className="icon" src={lineIcon} width={17} height={17} alt="" />;
ICONS.box = <span className="glyph-rect" />;
ICONS.ellipse = <span className="glyph-ellipse" />;
ICONS.text = <span className="glyph-text">T</span>;

const GUIDE: Tool[] = ["select", "comment", "arrow", "rectangle", "remove", "circle", "rule"];
const SKETCH: Tool[] = ["freehand", "line", "box", "ellipse", "text"];
/** The vision board has no guide tools: select plus the sketch tools. */
export const VISION_TOOLS: Tool[] = ["select", ...SKETCH];

function ToolButton({ tool, ro }: { tool: Tool; ro: boolean }) {
  const active = useStore((s) => s.tool === tool);
  const vision = useStore((s) => s.view === "vision");
  const t = TOOLS.find((x) => x.tool === tool)!;
  const hint = (vision && VISION_HINTS[tool]) || t.hint;
  return (
    <button
      className={`item tool ${active ? "active" : ""}`}
      onClick={() => useStore.getState().setTool(tool)}
      disabled={ro && tool !== "select"}
      aria-label={`${t.label} (${t.key})`}
      aria-pressed={active}
    >
      {ICONS[tool]}
      <span className="tip">
        <b>{t.label}</b> <kbd>{t.key}</kbd> <span className="dim">— {hint}</span>
      </span>
    </button>
  );
}

function ImageGlyph() {
  return (
    <svg className="glyph-image" width={16} height={14} viewBox="0 0 16 14" aria-hidden>
      <rect x={1} y={1} width={14} height={12} rx={1} />
      <circle cx={5} cy={5} r={1.4} />
      <path d="M1.5 11.5 L6 7.5 L9 10 L11 8.5 L14.5 11.5" />
    </svg>
  );
}

/** Curved undo/redo arrow; Inter's ↶ and ↷ glyphs are too thin at this size. */
function HistoryArrow({ redo }: { redo?: boolean }) {
  return (
    <svg
      className={`history-arrow ${redo ? "redo" : ""}`}
      width={14}
      height={14}
      viewBox="0 0 14 14"
      aria-hidden
    >
      <path d="M11.5 11 V8.5 A4.5 4.5 0 0 0 2.5 8.5 V10" />
      <path d="M0.75 8.25 L2.5 10 L4.25 8.25" />
    </svg>
  );
}

function Toggle({
  on,
  icon,
  label,
  onClick,
  title,
}: {
  on: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      className={`item wide ${on ? "on" : ""}`}
      onClick={onClick}
      title={title}
      aria-pressed={on}
    >
      {icon}
      {label}
    </button>
  );
}

export function ToolRail() {
  const ro = useStore(
    (s) => !s.round || s.round.status.status === "sent" || s.round.status.status === "applied",
  );
  const penMode = useStore((s) => s.penMode);
  const showOutlines = useStore((s) => s.showOutlines);
  const inspectorOpen = useStore((s) => s.inspectorOpen);
  const lan = useStore((s) => s.lan);
  const set = useStore((s) => s.set);
  const vision = useStore((s) => s.view === "vision");
  const undo = () => (vision ? useVision.getState().undo() : useStore.getState().undo());
  const redo = () => (vision ? useVision.getState().redo() : useStore.getState().redo());

  return (
    <nav className="float rail" aria-label="tools">
      <div className="logo">
        <span className="logo-back" />
        <span className="logo-front" />
        <span className="logo-name">ScribUI</span>
      </div>

      <div className="history">
        <button className="item tool" onClick={undo} aria-label="undo">
          <HistoryArrow />
          <span className="tip">
            undo <kbd>⌘Z</kbd>
          </span>
        </button>
        <button className="item tool" onClick={redo} aria-label="redo">
          <HistoryArrow redo />
          <span className="tip">
            redo <kbd>⌘⇧Z</kbd>
          </span>
        </button>
      </div>

      {!vision && (
        <section className="tool-group">
          <h4>Guide</h4>
          <p>Tell the agent what to change</p>
          <div className="toolbox">
            {GUIDE.map((t) => (
              <ToolButton key={t} tool={t} ro={ro} />
            ))}
          </div>
        </section>
      )}

      <section className="tool-group">
        <h4>Sketch</h4>
        <p>{vision ? "Draw the look you're after" : "Show roughly what you want"}</p>
        <div className="toolbox">
          {(vision ? VISION_TOOLS : SKETCH).map((t) => (
            <ToolButton key={t} tool={t} ro={ro && !vision} />
          ))}
          {vision && (
            <button
              className="item tool"
              onClick={() => useVision.getState().set({ importOpen: true })}
              aria-label="import image (M)"
            >
              <ImageGlyph />
              <span className="tip">
                <b>image</b> <kbd>M</kbd>{" "}
                <span className="dim">— import an image to move, resize and rotate</span>
              </span>
            </button>
          )}
        </div>
      </section>

      <div className="toggles">
        <Toggle
          on={lan.paired > 0}
          icon={<img className="icon" src={tabletIcon} width={12} height={12} alt="" />}
          label={lan.paired > 0 ? `Tablet · ${lan.paired}` : "Tablet"}
          onClick={() => set({ lanOpen: true })}
          title="review on a tablet: show a pairing QR code"
        />
        <Toggle
          on={inspectorOpen}
          icon={<img className="icon" src={panelIcon} width={12} height={12} alt="" />}
          label="Panel"
          onClick={() => set({ inspectorOpen: !inspectorOpen })}
          title="inspector (tab)"
        />
        {!vision && (
          <Toggle
            on={showOutlines}
            icon={<img className="icon" src={elementsIcon} width={7} height={10} alt="" />}
            label="Elements"
            onClick={() => set({ showOutlines: !showOutlines })}
            title="show all element outlines (E)"
          />
        )}
        <Toggle
          on={penMode}
          icon={<img className="icon" src={penIcon} width={12} height={12} alt="" />}
          label="Pen mode"
          onClick={() => set({ penMode: !penMode })}
          title="pen mode: pen draws, touch pans (turns on with the first pen stroke)"
        />
      </div>
    </nav>
  );
}

/* ───────── status line ───────── */

/** Sun in dark mode, moon in light mode: the icon shows where a click takes you. */
function ThemeSwitch() {
  const theme = useStore((s) => s.theme);
  const dark = theme === "dark";
  return (
    <button
      className="theme-switch"
      onClick={() => useStore.getState().set({ theme: dark ? "light" : "dark" })}
      title={dark ? "switch to light mode" : "switch to dark mode"}
      aria-label={dark ? "switch to light mode" : "switch to dark mode"}
    >
      {dark ? (
        <svg width={14} height={14} viewBox="0 0 14 14" aria-hidden>
          <circle cx={7} cy={7} r={2.75} />
          <path
            d="M7 1v1.5M7 11.5V13M1 7h1.5M11.5 7H13M2.76 2.76l1.06 1.06M10.18 10.18l1.06 1.06M2.76 11.24l1.06-1.06M10.18 3.82l1.06-1.06"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.4}
            strokeLinecap="round"
          />
        </svg>
      ) : (
        <svg width={14} height={14} viewBox="0 0 14 14" aria-hidden>
          <path d="M11.9 9.1A5.25 5.25 0 0 1 4.9 2.1a5.25 5.25 0 1 0 7 7z" />
        </svg>
      )}
    </button>
  );
}

export function StatusLine({ onCommand }: { onCommand: (cmd: string) => void }) {
  const tool = useStore((s) => s.tool);
  const penMode = useStore((s) => s.penMode);
  const editor = useStore((s) => s.editor);
  const command = useStore((s) => s.command);
  const cursor = useStore((s) => s.cursorPx);
  const hover = useStore((s) => s.hover);
  const vision = useStore((s) => s.view === "vision");
  const boardZoom = useStore((s) => s.camera.zoom);
  const visionZoom = useVision((s) => s.camera.zoom);
  const zoom = vision ? visionZoom : boardZoom;
  const connected = useStore((s) => s.connected);
  const boardSave = useStore((s) => s.saveState);
  const visionSave = useVision((s) => s.saveState);
  const saveState = vision ? visionSave : boardSave;
  const capture = useStore((s) => s.capture);
  const ruleTargets = useStore((s) => s.ruleTargets);
  const focusId = useStore((s) => s.focusId);
  const ro = useStore(
    (s) => !s.round || s.round.status.status === "sent" || s.round.status.status === "applied",
  );
  const el = hover ? hover.stack[hover.level] : null;
  const toolInfo = TOOLS.find((t) => t.tool === tool);

  const textEdit = useVision((s) => !!s.textEdit);
  const insert = vision ? textEdit : !!editor;
  const locked = ro && !vision;
  const mode = command !== null ? "COMMAND" : insert ? "INSERT" : locked ? "READ-ONLY" : penMode ? "PEN" : vision ? "VISION" : "NORMAL";
  const modeCls = command !== null ? "cmd" : insert ? "insert" : locked ? "ro" : penMode ? "pen" : vision ? "vis" : "";

  return (
    <footer className="float status">
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
              <span className="accent">{ruleTargets.length} selected · ⏎ to write the rule</span>
            )}
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
                <span className="faint">│</span>{" "}
                <span style={{ color: "var(--cyan)" }}>{el.type}</span>
                {el.idSource !== "generated" && <span className="v"> #{el.id}</span>}
                {el.label && <span> "{el.label.slice(0, 40)}"</span>}
                <span className="faint"> [{el.idSource}]</span>
                {el.source && (
                  <span className="faint">
                    {" "}
                    {el.source.component ?? ""} {el.source.file}
                  </span>
                )}
              </span>
            )}
          </div>
          {capture && (
            <div className="cell">
              <span className="warn">capturing R{pad(capture.round)}</span>
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
          <div
            className="cell"
            title={connected ? "live: updates from the agent arrive instantly" : "disconnected"}
          >
            <span className={`dot ${connected ? "on" : ""}`} /> {connected ? "live" : "offline"}
          </div>
          <div className="cell hide-sm">
            <span className="faint">:</span>cmd <span className="faint">?</span>keys
          </div>
        </>
      )}
      <ThemeSwitch />
    </footer>
  );
}
