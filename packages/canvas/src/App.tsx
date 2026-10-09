import { useEffect } from "react";
import { newAnnotationId, type Annotation } from "@scribui/core";
import { connectEvents } from "./api";
import { useChat } from "./chat";
import { fitCamera } from "./layout";
import { TOOLS, isReadOnly, useStore } from "./store";
import { animateCamera, Board, boardViewport, fitAll, focusTile, panToAnnotation, unfocus, zoomAt } from "./components/Board";
import { ActionBar, StatusLine, ToolRail, TopBar } from "./components/Chrome";
import { CapturePanel, LanDialog, NextStepBanner } from "./components/Capture";
import { ChatPanel } from "./components/Chat";
import { HelpDialog, SendDialog, SentDialog, Toasts } from "./components/Dialogs";
import { Inspector } from "./components/Inspector";
import { hasLiveTab, LiveView, showLive, toggleView } from "./components/Live";
import { ToolSettings } from "./components/ToolSettings";
import { ImageImportDialog, VisionBoard, visionKey, zoomVision, fitVisionCamera } from "./components/Vision";
import { useVision } from "./vision";

const liveTab = () => {
  const p = useStore.getState().project;
  return !!p && "app" in p.manifest && hasLiveTab(p.manifest.app.platform);
};

export function App() {
  const round = useStore((s) => s.round);
  const loading = useStore((s) => s.loading);
  const error = useStore((s) => s.error);
  const theme = useStore((s) => s.theme);
  const capture = useStore((s) => s.capture);
  const project = useStore((s) => s.project);
  const firstCapture = useStore((s) => s.captureState.running || !!s.externalCapture);
  const inspectorOpen = useStore((s) => s.inspectorOpen);
  const chatOpen = useChat((s) => s.open);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("scribui:theme", theme);
    } catch {
      /* storage blocked */
    }
  }, [theme]);

  const view = useStore((s) => s.view);

  useEffect(() => {
    void useStore.getState().load();
    return connectEvents(
      (e) => {
        const st = useStore.getState();
        if (e.type === "round-created") {
          void st.refreshRounds();
          st.set({ capture: { round: e.round, screens: [] } });
          // show the new round right away; tiles fill in as screens are captured
          if (!st.round || isReadOnly()) void st.load(e.round);
        } else if (e.type === "capture-progress") {
          st.set({ capture: e.status === "capturing" ? { round: e.round, screens: e.screens } : null });
          if (!st.captureState.running && e.progress) st.set({ externalCapture: { round: e.round, ...e.progress } });
          if (st.round?.round === e.round) reloadSoon(e.round);
        } else if (e.type === "capture-state") {
          const was = st.captureState;
          st.set({ captureState: e.state, externalCapture: null });
          if (e.state.running && e.state.round && st.round?.round !== e.state.round && (!st.round || isReadOnly())) void st.load(e.state.round);
          if (e.state.running && e.state.round && st.round?.round === e.state.round && (e.state.done ?? 0) !== (was.done ?? 0)) reloadSoon(e.state.round);
          if (!e.state.running && was.running) {
            if (e.state.phase === "done" && e.state.round) {
              void st.refreshRounds();
              void st.load(e.state.round);
              st.toast({ text: `round ${pad(e.state.round)} ready · ${e.state.summary ?? ""}`, tone: "ok" });
            } else if (e.state.phase === "done") {
              // nothing changed: offer the full capture the user may have meant
              st.toast({
                text: e.state.summary ?? "nothing to capture",
                tone: "info",
                action: { label: "capture all", run: () => void useStore.getState().captureNext({ all: true }) },
              });
            }
          }
        } else if (e.type === "lan-changed") {
          st.set({ lan: { ...st.lan, enabled: e.enabled, paired: e.paired } });
          if (e.paired > st.lan.paired) st.toast({ text: "tablet paired", tone: "ok" });
        } else if (e.type === "status-changed") {
          if (e.status === "open") st.set({ externalCapture: null });
          void st.refreshRounds();
          const cur = st.round?.round;
          if (e.status === "open" && e.round !== cur) {
            st.set({ capture: null });
            const busy = st.annotations.length > 0 && !isReadOnly();
            if (!cur || !busy) {
              void st.load(e.round);
              st.toast({ text: `round ${pad(e.round)} captured`, tone: "ok" });
            } else {
              st.toast({
                text: `round ${pad(e.round)} captured`,
                tone: "info",
                action: { label: "open it", run: () => void useStore.getState().load(e.round) },
              });
            }
          } else if (e.round === cur) {
            if (e.status === "open" && st.capture) st.set({ capture: null });
            void st.load(e.round);
            if (e.status === "applied") st.toast({ text: `round ${pad(e.round)} applied by the agent`, tone: "ok" });
          }
        } else if (e.type === "annotations-changed") {
          // another tab or device edited this round
          if (e.round === st.round?.round && e.by !== clientId()) void st.load(e.round);
        } else if (e.type === "chat") {
          useChat.setState({ server: e.state });
        } else if (e.type === "vision-changed") {
          // another tab or device drew on the vision board
          const v = useVision.getState();
          if (e.by !== clientId() && !v.textEdit) void v.load();
        }
      },
      (connected) => useStore.getState().set({ connected }),
    );
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // already handled: the device tab types into the device (an "l" there is text, not the tab key)
      if (e.defaultPrevented) return;
      const t = e.target as HTMLElement;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
      const st = useStore.getState();
      if (st.helpOpen || st.sendOpen || st.sentPrompt) return;
      const mod = e.metaKey || e.ctrlKey;
      if (!mod && !e.altKey && e.key.toLowerCase() === "l" && liveTab()) return toggleView();
      // the board's keys don't apply while the live app is shown
      if (st.view === "live") return;
      if (st.view === "vision") {
        if (visionKey(e)) return;
        if (mod && e.key === "Enter") {
          e.preventDefault();
          if (!isReadOnly()) st.set({ sendOpen: true });
        } else if (!mod && e.key === "Tab") {
          e.preventDefault();
          st.set({ inspectorOpen: !st.inspectorOpen });
        } else if (e.key === "?") st.set({ helpOpen: true });
        else if (e.key === ":") {
          e.preventDefault();
          st.set({ command: "" });
        }
        return;
      }

      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) st.redo();
        else st.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        st.redo();
        return;
      }
      if (mod && e.key === "Enter") {
        e.preventDefault();
        if (!isReadOnly()) st.set({ sendOpen: true });
        return;
      }
      if (mod && (e.key === "=" || e.key === "+" || e.key === "-")) {
        e.preventDefault();
        const vp = boardViewport();
        st.setCamera((c) => zoomAt(c, vp.x + vp.w / 2, vp.y + vp.h / 2, c.zoom * (e.key === "-" ? 0.8 : 1.25)));
        return;
      }
      if (mod || e.altKey) return;

      // a remove button is asking: Enter removes, Escape cancels
      if (st.removeAsk) {
        if (e.key === "Enter") {
          e.preventDefault();
          return void st.removeScreen(st.removeAsk);
        }
        if (e.key === "Escape") return st.set({ removeAsk: null });
      }
      // a sketch in progress: ⏎ or Escape finishes it and opens its note
      if ((e.key === "Enter" || e.key === "Escape") && st.drawing) {
        e.preventDefault();
        return st.finishDrawing();
      }
      if (e.key === "Escape") {
        if (st.picker) return st.set({ picker: null });
        if (st.ruleTargets.length) return st.set({ ruleTargets: [] });
        if (st.selectedId || st.selectedElement) return st.set({ selectedId: null, selectedElement: null });
        if (st.focusId) return unfocus();
        if (st.tool !== "select") return st.setTool("select");
        return;
      }
      if (e.key === "Enter") {
        if (st.tool === "rule" && st.ruleTargets.length && !isReadOnly()) {
          e.preventDefault();
          const first = st.ruleTargets[0]!;
          const a: Annotation = {
            id: newAnnotationId(),
            screenId: first.screenId,
            kind: "rule",
            geometry: { type: "point", x: 0, y: 0 },
            targets: st.ruleTargets.map((r) => (r.screenId === first.screenId ? r.elementId : `${r.screenId}#${r.elementId}`)),
          };
          st.set({ ruleTargets: [] });
          st.add(a, { edit: true });
          return;
        }
        if (st.selectedId && !isReadOnly()) {
          e.preventDefault();
          st.set({ editor: { annotationId: st.selectedId, isNew: false } });
        }
        return;
      }
      if ((e.key === "Backspace" || e.key === "Delete") && st.selectedId && !isReadOnly()) {
        e.preventDefault();
        st.remove(st.selectedId);
        return;
      }
      // Delete on a focused view (nothing selected) asks to remove the view
      if ((e.key === "Backspace" || e.key === "Delete") && st.focusId && !isReadOnly()) {
        e.preventDefault();
        return st.set({ removeAsk: st.focusId });
      }
      if (e.key === "Tab") {
        e.preventDefault();
        st.set({ inspectorOpen: !st.inspectorOpen });
        return;
      }
      if (e.key === "?") return st.set({ helpOpen: true });
      if (e.key === ":") {
        e.preventDefault();
        return st.set({ command: "" });
      }
      const k = e.key.toUpperCase();
      const tool = TOOLS.find((x) => x.key === k);
      if (tool) {
        if (isReadOnly() && tool.tool !== "select") return;
        st.setTool(tool.tool);
        return;
      }
      if (k === "E") return st.set({ showOutlines: !st.showOutlines });
      if (k === "F" || e.key === "0") {
        st.set({ focusId: null, preFocusCamera: null });
        return animateCamera(fitAll(st.tiles, st.groups, boardViewport()));
      }
      if (e.key === "1") {
        const vp = boardViewport();
        return animateCamera(zoomAt(st.camera, vp.x + vp.w / 2, vp.y + vp.h / 2, 1));
      }
      if (k === "N") return nextUnresolved();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onSend = () => useStore.getState().set({ sendOpen: true });

  return (
    <div className={`app ${inspectorOpen ? "with-panel" : ""} ${chatOpen ? "with-chat" : ""} ${view === "live" ? "live-view" : ""}`}>
      <main className="stage">
        <Board />
        <VisionBoard />
        <NextStepBanner />
        <CapturePanel />
        <LiveView />
        {!round && !loading && view === "board" && (
          <div className="empty-board">
            <div className="box">
              <h1>
                Nothing to
                <br />
                review yet<span className="accent">.</span>
              </h1>
              {error ? (
                <p className="err">✗ {error}</p>
              ) : project && "error" in project.manifest ? (
                <p className="err">✗ {project.manifest.error}</p>
              ) : (
                <>
                  {project && "app" in project.manifest && project.manifest.app.platform === "web" ? (
                    <p>
                      Open the <button className="link" onClick={showLive}>app tab</button> (<kbd>L</kbd>), browse to a view in your app and
                      press <b>Capture view</b>.
                    </p>
                  ) : project && "app" in project.manifest && hasLiveTab(project.manifest.app.platform) ? (
                    <p>
                      Open the <button className="link" onClick={showLive}>device tab</button> (<kbd>L</kbd>), go to a screen in your app
                      and press <b>Capture view</b>, or ask your agent to list screens in <code>.scribui/screens.json</code> and run{" "}
                      <code>npx scribui capture</code>.
                    </p>
                  ) : (
                    <>
                      <p>
                        Ask your agent to list screens in <code>.scribui/screens.json</code>, then run
                      </p>
                      <p>
                        <code>npx scribui capture</code>
                      </p>
                    </>
                  )}
                  <p className="faint">This page updates on its own when a round is captured.</p>
                </>
              )}
              {firstCapture && (
                <p className="warn">Capturing the first round… the screens appear here as they're captured.</p>
              )}
              {capture && (
                <div className="progress">
                  <div className="warn">capturing round {pad(capture.round)}…</div>
                  {capture.screens.map((s) => (
                    <div key={s.screenId}>
                      {s.ok ? <span className="ok">✓</span> : <span className="err">✗</span>} {s.screenId}
                      {s.error && <span className="faint"> {s.error}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
        <Toasts />
      </main>
      <ToolRail />
      <TopBar />
      <ActionBar onSend={onSend} />
      <Inspector />
      <ChatPanel />
      <StatusLine onCommand={runCommand} />
      <SendDialog />
      <SentDialog />
      <HelpDialog />
      <LanDialog />
      <ToolSettings />
      <ImageImportDialog />
    </div>
  );
}

const pad = (n: number) => String(n).padStart(3, "0");

let reloadTimer: ReturnType<typeof setTimeout> | null = null;
/** Reload the viewed round shortly (coalesces bursts of progress events). */
function reloadSoon(round: number) {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    const st = useStore.getState();
    if (st.round?.round === round && !st.editor) void st.load(round);
  }, 300);
}
const clientId = () => (window as unknown as { __icClient?: string }).__icClient ?? "";

function nextUnresolved() {
  const st = useStore.getState();
  const list = st.annotations.filter((a) => a.kind !== "rule" && !(a.kind === "comment" && a.attachedTo) && a.resolution?.status === "unresolved");
  if (!list.length) {
    st.toast({ text: "no unresolved notes", tone: "ok" });
    return;
  }
  const i = list.findIndex((a) => a.id === st.selectedId);
  const next = list[(i + 1) % list.length]!;
  st.select(next.id);
  st.set({ picker: { annotationId: next.id } });
  panToAnnotation(next);
}

function runCommand(raw: string) {
  const st = useStore.getState();
  const [cmd, ...args] = raw.trim().split(/\s+/);
  switch (cmd) {
    case "send":
    case "w":
      if (!isReadOnly()) st.set({ sendOpen: true });
      return;
    case "fit":
    case "f":
      if (st.view === "vision") return useVision.getState().setCamera(fitVisionCamera());
      st.set({ focusId: null });
      return animateCamera(fitAll(st.tiles, st.groups, boardViewport()));
    case "focus": {
      const id = args[0];
      if (id && st.tiles.some((t) => t.id === id)) return focusTile(id);
      return st.toast({ text: `no screen "${id ?? ""}"`, tone: "err" });
    }
    case "outlines":
    case "el":
      return st.set({ showOutlines: !st.showOutlines });
    case "pen":
      return st.set({ penMode: !st.penMode });
    case "theme":
      return st.set({ theme: args[0] === "light" ? "light" : args[0] === "dark" ? "dark" : st.theme === "dark" ? "light" : "dark" });
    case "round":
    case "r": {
      const n = Number(args[0]);
      if (Number.isInteger(n) && st.rounds.some((r) => r.round === n)) return void st.load(n);
      return st.toast({ text: `no round ${args[0] ?? ""}`, tone: "err" });
    }
    case "zoom":
    case "z": {
      const pct = Number(args[0]);
      if (!pct) return;
      if (st.view === "vision") return zoomVision(pct / 100);
      const vp = boardViewport();
      return animateCamera(zoomAt(st.camera, vp.x + vp.w / 2, vp.y + vp.h / 2, pct / 100));
    }
    case "next":
    case "n":
      return nextUnresolved();
    case "recapture":
    case "rc": {
      const screens = st.round?.screens ?? [];
      const arg = args[0] ?? (st.focusId ? st.focusId : "stale");
      const ids =
        arg === "all"
          ? screens.map((s) => s.id)
          : arg === "stale"
            ? screens.filter((s) => s.reusedFrom !== undefined).map((s) => s.id)
            : args.filter((a) => screens.some((s) => s.id === a));
      if (!ids.length) return st.toast({ text: arg === "stale" ? "no reused screens in this round" : `no screen "${arg}"`, tone: "warn" });
      return void st.recapture(ids);
    }
    case "capture":
      return void st.captureNext({ all: args[0] === "all" });
    case "rebuild":
      return void st.captureNext({ build: true });
    case "ipad":
    case "lan":
      return st.set({ lanOpen: true });
    case "help":
    case "h":
      return st.set({ helpOpen: true });
    case "tile": {
      const t = st.tiles.find((x) => x.id === st.focusId);
      if (t) animateCamera(fitCamera(t, boardViewport(), 56, 3));
      return;
    }
    case "":
    case undefined:
      return;
    default:
      st.toast({ text: `unknown command: ${cmd}`, tone: "err" });
  }
}
