import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { focusTile } from "./Board";
import { Spinner } from "./Capture";
import { deviceApi, DeviceTab, ICON, Tip } from "./Device";
import { addWebMark, deleteNote, editNote, layerMarks, liveTool, notePage, OPEN_NOTE, pagePath, surfaceStyles } from "./Marking";
import { ToolSettings } from "./ToolSettings";

/**
 * The app tab: the running web app, for capturing views by hand.
 * In a browser the app is embedded in an iframe, and capturing needs the
 * Chrome window ScribUI opens: it exposes `window.__scribuiCapture`, which
 * screenshots the embedded app as it is. In the desktop app the app has its
 * own view (`scribuiDesktop.live`): this tab reports where it should sit and
 * drives it; pages that refuse embedding work there. Mobile projects in the
 * desktop app get the device tab instead (Device.tsx).
 * Most websites refuse to be embedded: the Chrome window ScribUI opens drops
 * the headers that say so, and in the user's own browser the ScribUI extension
 * can (packages/extension/bridge.js), once allowed.
 */

type CaptureFn = (req: { title?: string; replace?: string; fullPage?: boolean; signature?: string }) => Promise<{ round: number; screenId: string; title: string }>;
type MarkEvent =
  | { type: "add"; draft: unknown }
  | { type: "ready"; url: string }
  | { type: "review" }
  | { type: "exit" }
  | { type: "select"; id: string | null }
  | { type: "edit"; id: string; text: string }
  | { type: "delete"; id: string };
type Box = { x: number; y: number; width: number; height: number };
type LiveState = {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  zoom: number;
  bounds: Box | null;
  error: string | null;
};
type DesktopLive = {
  place(area: Box | null, size: { width: number; height: number } | null): void;
  navigate(url: string): Promise<void>;
  reload(): Promise<void>;
  back(): Promise<void>;
  forward(): Promise<void>;
  devtools(): Promise<void>;
  onState(cb: (s: LiveState) => void): () => void;
  /** Desktop 6+: marking up the page (Marking.tsx). */
  markMode?(tool: string | null, styles?: unknown, theme?: string): void;
  setMarks?(list: { url: string; marks: unknown[]; confirmed: string[]; selected?: string | null }): void;
  onMark?(cb: (ev: MarkEvent) => void): () => void;
};
declare global {
  interface Window {
    __scribuiCapture?: CaptureFn;
    scribuiDesktop?: { version: number; platform: string; live?: DesktopLive };
  }
}

/** The desktop app's view for the app, when the canvas runs there. */
const native: DesktopLive | null = typeof window !== "undefined" ? (window.scribuiDesktop?.live ?? null) : null;
if (native) document.documentElement.classList.add("desktop-live");

const SIZES = [
  { id: "fit", label: "fit window", w: 0, h: 0 },
  { id: "desktop", label: "desktop 1440×900", w: 1440, h: 900 },
  { id: "laptop", label: "laptop 1280×800", w: 1280, h: 800 },
  { id: "tablet", label: "tablet 834×1194", w: 834, h: 1194 },
  { id: "phone", label: "phone 390×844", w: 390, h: 844 },
];

const pad = (n: number) => String(n).padStart(3, "0");

/** The app tab exists for web projects, and for mobile ones in the desktop app (the device tab). */
export function hasLiveTab(platform: string | undefined): boolean {
  return platform === "web" || (!!deviceApi && platform === deviceApi.platform);
}

export function showLive() {
  useStore.getState().set({ view: "live", liveVisited: true });
}

export function toggleView() {
  const st = useStore.getState();
  if (st.view === "live") st.set({ view: "board" });
  else showLive();
}

/** A page on this computer: the app being built, which doesn't refuse embedding. */
function onThisComputer(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "localhost" || h.endsWith(".localhost") || h === "[::1]" || h.startsWith("127.");
  } catch {
    return true;
  }
}

/** The ScribUI extension, through its bridge: whether it shows other websites here. null: not installed. */
function useExtensionFrames(ask: boolean) {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  useEffect(() => {
    if (!ask) return;
    const onMessage = (e: MessageEvent) => {
      if (e.source === window && e.data?.scribui === "frames") setAllowed(!!e.data.allowed);
    };
    window.addEventListener("message", onMessage);
    window.postMessage({ scribui: "frames?" }, location.origin);
    return () => window.removeEventListener("message", onMessage);
  }, [ask]);
  const allow = () => window.postMessage({ scribui: "frames-allow" }, location.origin);
  return { allowed, allow };
}

function readSize(): string {
  try {
    return localStorage.getItem("scribui:live-size") || "fit";
  } catch {
    return "fit";
  }
}

export function LiveView() {
  return deviceApi ? <DeviceTab api={deviceApi} /> : <WebLive />;
}

function WebLive() {
  const view = useStore((s) => s.view);
  const visited = useStore((s) => s.liveVisited);
  const project = useStore((s) => s.project);
  const manifest = project && "app" in project.manifest ? project.manifest : null;
  const base = manifest?.app.baseUrl ?? "";
  const handmade = (manifest?.screens ?? []).filter((s) => s.live);

  const [src, setSrc] = useState(base);
  const [address, setAddress] = useState(base);
  const [reloadKey, setReloadKey] = useState(0);
  const [size, setSize] = useState(readSize);
  const [name, setName] = useState("");
  const [replace, setReplace] = useState("");
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<LiveState | null>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const canCapture = typeof window.__scribuiCapture === "function";
  // dialogs would sit under the app's view: hide it while one is open
  const covered = useStore((s) => s.helpOpen || s.sendOpen || !!s.sentPrompt || s.lanOpen);
  const preset = SIZES.find((s) => s.id === size) ?? SIZES[0]!;
  const shown = view === "live" && !covered;
  // in a browser: another website may refuse the frame
  const extension = useExtensionFrames(!native && visited);
  const elsewhere = !native && !canCapture && !!src && !onThisComputer(src);

  // desktop: follow the app's view (address, loading, errors)
  useEffect(() => {
    if (!native) return;
    return native.onState((st) => {
      setState(st);
      if (st.url && document.activeElement !== addressRef.current) setAddress(st.url);
    });
  }, []);

  // desktop: load the app the first time the tab opens
  useEffect(() => {
    if (!native || !visited || started.current || !src) return;
    started.current = true;
    void native.navigate(src);
  }, [visited, src]);

  // desktop: keep the app's view on this tab's free area, or hidden
  useLayoutEffect(() => {
    if (!native) return;
    const el = areaRef.current;
    if (!shown || !el) {
      native.place(null, null);
      return;
    }
    const place = () => {
      const r = el.getBoundingClientRect();
      native.place({ x: r.left, y: r.top, width: r.width, height: r.height }, preset.w ? { width: preset.w, height: preset.h } : null);
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    window.addEventListener("resize", place);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", place);
      native.place(null, null);
    };
  }, [shown, preset.w, preset.h, visited]);

  /* ───────── marking up the page ───────── */

  const markTool = useStore((s) => liveTool(s.tool));
  const toolStyles = useStore((s) => s.toolStyles);
  const theme = useStore((s) => s.theme);
  const canMark = !!native?.markMode && !!state?.url && !state.error;
  const pageUrl = state?.url ?? "";
  const confirmed = useRef<string[]>([]);
  const pushMarks = useRef<() => void>(() => {});
  pushMarks.current = () => {
    if (!native?.setMarks || !pageUrl) return;
    const marks = layerMarks(pageUrl);
    // the note picked (here or in the notes list) opens on the page
    const sel = useStore.getState().selectedId;
    const selected = sel && marks.some((m) => m.annotation.id === sel) ? sel : null;
    native.setMarks({ url: pageUrl.split("#")[0]!, marks, confirmed: confirmed.current.splice(0), selected });
  };

  // the tool goes to the page while this tab shows; elsewhere the app is just used
  useEffect(() => {
    native?.markMode?.(shown && canMark ? markTool : null, surfaceStyles(), theme);
  }, [shown, canMark, markTool, toolStyles, theme]);

  // what the page's mark layer sends
  useEffect(
    () =>
      native?.onMark?.((ev) => {
        if (ev.type === "add")
          addWebMark(ev.draft, (id) => {
            confirmed.current.push(id);
            pushMarks.current();
          });
        else if (ev.type === "ready") pushMarks.current();
        else if (ev.type === "review") {
          useStore.getState().setTool("select");
          useStore.getState().set({ view: "board" });
        } else if (ev.type === "exit") useStore.getState().setTool("select");
        else if (ev.type === "select") useStore.getState().select(ev.id);
        else if (ev.type === "edit") editNote(ev.id, ev.text);
        else if (ev.type === "delete") deleteNote(ev.id);
      }),
    [],
  );

  // the notes on the shown page, again whenever they or the page change
  const annotations = useStore((s) => s.annotations);
  const shownRound = useStore((s) => s.round);
  const selectedId = useStore((s) => s.selectedId);
  useEffect(() => pushMarks.current(), [pageUrl, annotations, shownRound, project, selectedId]);

  // a note picked in the notes list: its page opens, then the note on it
  const goRef = useRef<(url: string) => void>(() => {});
  useEffect(() => {
    const open = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (!shown || !native?.setMarks) return;
      const url = notePage(id);
      const st = useStore.getState();
      if (!url) return st.toast({ text: "That note is on a screen captured another way: open Review to change it", tone: "info" });
      if (pagePath(url, base) !== pagePath(pageUrl, base)) goRef.current(url);
    };
    window.addEventListener(OPEN_NOTE, open);
    return () => window.removeEventListener(OPEN_NOTE, open);
  }, [shown, pageUrl, base]);

  // the project loads after the first render
  useEffect(() => {
    if (base && !src) {
      setSrc(base);
      setAddress(base);
    }
  }, [base, src]);

  // the extension may now show the website the frame refused: load it again
  const wasAllowed = useRef(extension.allowed);
  useEffect(() => {
    if (extension.allowed && wasAllowed.current === false) setReloadKey((k) => k + 1);
    wasAllowed.current = extension.allowed;
  }, [extension.allowed]);

  // the live window reports where the embedded app navigated
  useEffect(() => {
    const onUrl = (e: Event) => setAddress((e as CustomEvent<string>).detail);
    window.addEventListener("scribui:live-url", onUrl);
    return () => window.removeEventListener("scribui:live-url", onUrl);
  }, []);

  if (!visited) return null;

  const go = (raw: string) => {
    const v = raw.trim();
    if (!v) return;
    let url = v;
    if (v.startsWith("/") && base) url = new URL(v, base).toString();
    // a bare address: http for the machine and the local network, https for the web
    else if (!/^[a-z]+:\/\//i.test(v)) url = `${/^(localhost|[\d.]+|\[[\da-f:]+\])(:\d+)?(\/|$)/i.test(v) ? "http" : "https"}://${v}`;
    setAddress(url);
    if (native) {
      started.current = true;
      void native.navigate(url);
      return;
    }
    if (url === src) setReloadKey((k) => k + 1);
    else setSrc(url);
  };
  goRef.current = go;
  const reload = () => (native ? void native.reload() : setReloadKey((k) => k + 1));

  const pickSize = (id: string) => {
    setSize(id);
    try {
      localStorage.setItem("scribui:live-size", id);
    } catch {
      /* storage blocked */
    }
  };

  const capture = async () => {
    if (!window.__scribuiCapture || busy) return;
    setBusy(true);
    const st = useStore.getState();
    try {
      const r = await window.__scribuiCapture({ ...(name.trim() ? { title: name.trim() } : {}), ...(replace ? { replace } : {}) });
      setName("");
      setReplace("");
      await st.refreshRounds();
      await st.load(r.round);
      st.toast({
        text: `captured "${r.title}" into R${pad(r.round)}`,
        tone: "ok",
        action: {
          label: "show in Review",
          run: () => {
            useStore.getState().set({ view: "board" });
            setTimeout(() => focusTile(r.screenId), 60);
          },
        },
      });
    } catch (e) {
      st.toast({ text: (e as Error).message.replace(/^Error:\s*/, ""), tone: "err" });
    } finally {
      setBusy(false);
    }
  };

  const frameStyle = preset.w ? { width: preset.w, height: preset.h } : { width: "100%", height: "100%" };

  return (
    <section className={`live-pane ${view === "live" ? "" : "off"}`} aria-hidden={view !== "live"}>
      <div className="live-bar">
        <form
          className="live-address"
          onSubmit={(e) => {
            e.preventDefault();
            go(address);
          }}
        >
          {native && (
            <>
              <button type="button" className="toggle" aria-label="back" disabled={!state?.canGoBack} onClick={() => void native.back()}>
                {ICON.back}
                <Tip name="Back" does="goes to the previous page in your app" />
              </button>
              <button type="button" className="toggle" aria-label="forward" disabled={!state?.canGoForward} onClick={() => void native.forward()}>
                {ICON.forward}
                <Tip name="Forward" does="goes to the next page again" />
              </button>
            </>
          )}
          <button type="button" className={`toggle ${state?.loading ? "spin" : ""}`} aria-label="reload the app" onClick={reload}>
            {ICON.refresh}
            <Tip name="Reload" does="loads the page again (your app's state is lost)" />
          </button>
          <input ref={addressRef} value={address} onChange={(e) => setAddress(e.target.value)} placeholder={base || "http://localhost:3000"} spellCheck={false} />
          {base && (
            <button type="button" className="toggle" aria-label="home" onClick={() => go(base)}>
              {ICON.home}
              <Tip name="Home" does="goes back to your app's start page" />
            </button>
          )}
        </form>
        {native && state && state.zoom < 1 && state.bounds && (
          <span className="live-zoom" title="larger than the room here: shown scaled down, captured at full size">
            {Math.round(state.zoom * 100)}%
          </span>
        )}
        <select className="live-select" value={size} onChange={(e) => pickSize(e.target.value)} title="size of the app">
          {SIZES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <span className="live-sep" />
        <input
          className="live-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={replace ? "keep its name" : "name (page title)"}
          disabled={!canCapture}
          onKeyDown={(e) => e.key === "Enter" && void capture()}
        />
        <select className="live-select" value={replace} onChange={(e) => setReplace(e.target.value)} disabled={!canCapture} title="add a new view or replace one">
          <option value="">as a new view</option>
          {handmade.map((s) => (
            <option key={s.id} value={s.id}>
              replace "{s.title}"
            </option>
          ))}
        </select>
        <button className="live-capture" onClick={() => void capture()} disabled={!canCapture || busy} title="screenshot the app exactly as it is now">
          {busy ? <Spinner /> : "●"} Capture view
        </button>
      </div>
      {native?.markMode && <ToolSettings inline />}
      {!canCapture && !native && (
        <div className="live-note">
          Capturing works in the Chrome window ScribUI opens for web projects. Press <kbd>o</kbd> in the terminal where ScribUI runs to
          bring it back.
        </div>
      )}
      {elsewhere && extension.allowed === false && (
        <div className="live-note">
          Most websites refuse to show inside another page, so this one may stay blank. The ScribUI extension can show them here.{" "}
          <button className="link" onClick={extension.allow}>
            Allow it
          </button>
        </div>
      )}
      {elsewhere && extension.allowed === null && (
        <div className="live-note">
          Most websites refuse to show inside another page, so this one may stay blank. The ScribUI browser extension or the ScribUI
          desktop app can show them.
        </div>
      )}
      <div className="live-viewport">
        {native ? (
          <div ref={areaRef} className="live-native">
            {!src && !state?.url ? (
              <div className="live-empty">Type your app's address above.</div>
            ) : state?.error ? (
              <div className="live-empty live-error">
                <p>The app didn't load.</p>
                <p className="faint">{state.error}</p>
                <p>
                  Start your app, then <button className="link" onClick={reload}>reload</button>.
                </p>
              </div>
            ) : null}
          </div>
        ) : src ? (
          <iframe
            key={reloadKey}
            data-scribui-live=""
            name="scribui-live"
            src={src}
            title="live app"
            style={frameStyle}
            className={preset.w ? "sized" : ""}
            allow="clipboard-read; clipboard-write; fullscreen"
          />
        ) : (
          <div className="live-empty">Type your app's address above.</div>
        )}
      </div>
    </section>
  );
}
