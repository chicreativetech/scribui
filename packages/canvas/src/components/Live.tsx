import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { focusTile } from "./Board";
import { BROWSER_INTRO, DESKTOP_INTRO, hintSeen, IntroCardView, markHintSeen, type IntroCard } from "./CaptureIntro";
import { captureButton, FloatStack, pressDockTool, useDockTools, type StackButton, type StackToast } from "./FloatStack";
import { deviceApi, DeviceTab, ICON, Tip } from "./Device";
import { addWebMark, deleteNote, editNote, layerMarks, liveTool, notePage, OPEN_NOTE, pagePath, surfaceStyles } from "./Marking";
import { ToolSettings } from "./ToolSettings";

/**
 * The Capture Screens tab: the running web app, for capturing views by hand.
 * Only in the desktop app: in a browser the app is a tab away, its pages come
 * to Review through the ScribUI extension or by pasting, and the tab only says
 * so (CaptureIntro.tsx). The app has its own view
 * (`scribuiDesktop.live`): this tab reports where it should sit and drives it.
 * The desktop's test harnesses embed it in an iframe instead, capturing through
 * `window.__scribuiCapture`. Mobile projects get the device tab (Device.tsx).
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
  /** Desktop 6+: the floating Capture view button, a view of its own over the app's. */
  stack?(stack: { toggles: StackButton[]; main: StackButton | null; toast: StackToast | null; theme: "light" | "dark" } | null): void;
  onStackPress?(cb: (id: string) => void): () => void;
  /** Desktop 6+: the intro card, a view of its own over the app's (null removes it). */
  card?(card: (IntroCard & { theme: "light" | "dark" }) | null): void;
  /** A tool rail tooltip, a view of its own over the app's (null hides it). */
  tip?(tip: { id: number; parts: { text: string; style: "" | "b" | "kbd" | "dim" }[]; x: number; y: number; theme: "light" | "dark" } | null): void;
  onCardClose?(cb: () => void): () => void;
};
declare global {
  interface Window {
    __scribuiCapture?: CaptureFn;
    scribuiDesktop?: { version: number; platform: string; live?: DesktopLive; hints?: { seen(id: string): Promise<boolean>; mark(id: string): void } };
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

/** The app tab exists in the desktop app: for web projects, and for mobile ones (the device tab). */
export function hasLiveTab(platform: string | undefined): boolean {
  return platform === "web" ? !!window.scribuiDesktop : !!deviceApi && platform === deviceApi.platform;
}

/** The tab is shown: where it works, and for web projects in a browser, where it says what to use instead. */
export function showsLiveTab(platform: string | undefined): boolean {
  return hasLiveTab(platform) || (platform === "web" && !window.scribuiDesktop);
}

export function showLive() {
  useStore.getState().set({ view: "live", liveVisited: true });
}

export function toggleView() {
  const st = useStore.getState();
  if (st.view === "live") st.set({ view: "board" });
  else showLive();
}

function readSize(): string {
  try {
    return localStorage.getItem("scribui:live-size") || "fit";
  } catch {
    return "fit";
  }
}

export function LiveView() {
  return deviceApi ? <DeviceTab api={deviceApi} /> : window.scribuiDesktop ? <WebLive /> : <BrowserLive />;
}

/** In a browser: no app here, only what to use instead. */
function BrowserLive() {
  const view = useStore((s) => s.view);
  if (view !== "live") return null;
  return (
    <section className="live-pane">
      <div className="live-viewport">
        <IntroCardView card={BROWSER_INTRO} onClose={() => useStore.getState().set({ view: "board" })} />
        {/* there, but not for pressing: the card says what to use instead */}
        <FloatStack main={captureButton(false, false)} />
      </div>
    </section>
  );
}

const INTRO_HINT = "capture-intro";

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
  const theme = useStore((s) => s.theme);

  // the intro card, the first time the tab opens (and from the bar's ? button)
  const [intro, setIntro] = useState(false);
  useEffect(() => {
    if (!visited) return;
    let gone = false;
    void hintSeen(INTRO_HINT).then((seen) => !gone && !seen && setIntro(true));
    return () => void (gone = true);
  }, [visited]);
  const closeIntro = () => {
    setIntro(false);
    markHintSeen(INTRO_HINT);
  };
  useEffect(() => native?.card?.(intro && shown ? { ...DESKTOP_INTRO, theme } : null), [intro, shown, theme]);
  useEffect(() => native?.onCardClose?.(() => closeIntro()), []);

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

  // the live window reports where the embedded app navigated
  useEffect(() => {
    const onUrl = (e: Event) => setAddress((e as CustomEvent<string>).detail);
    window.addEventListener("scribui:live-url", onUrl);
    return () => window.removeEventListener("scribui:live-url", onUrl);
  }, []);

  // desktop: the floating Capture view button over the app's view presses here
  // desktop: the dock over the app's view (floatStack.ts); always there, Capture view greyed out without a page or under the card
  const captureRef = useRef<() => void>(() => {});
  const hasApp = !!state?.bounds && !!state.url && !state.error;
  const toggles = useDockTools();
  const main = captureButton(canCapture && hasApp && !intro, busy);
  // the latest toast shows beside the buttons: the canvas's own would sit under the app
  const last = useStore((s) => s.toasts.at(-1));
  const toast = last ? { id: last.id, text: last.text, tone: last.tone ?? "info", action: last.action?.label ?? null } : null;
  // as JSON: the buttons are new objects on every render, the effect only runs when they change
  const stack = JSON.stringify({ toggles, main, toast, theme });
  useEffect(() => native?.stack?.(shown ? JSON.parse(stack) : null), [shown, stack]);
  useEffect(() => {
    if (!native?.stack || !shown) return;
    document.documentElement.classList.add("native-toasts");
    return () => document.documentElement.classList.remove("native-toasts");
  }, [shown]);

  // the rail's tooltips open over the app, under its view: the desktop shows them instead
  useEffect(() => {
    const show = native?.tip;
    if (!show || !shown) return;
    document.documentElement.classList.add("native-tips");
    let seq = 0;
    let timer = 0;
    let on: Element | null = null;
    const hide = () => {
      clearTimeout(timer);
      if (on) show(null);
      on = null;
    };
    const over = (e: PointerEvent) => {
      const tool = (e.target as Element | null)?.closest?.(".rail .tool");
      if (tool === on) return;
      hide();
      const tip = tool?.querySelector(":scope > .tip");
      if (!tool || !tip || (tool as HTMLButtonElement).disabled) return;
      on = tool;
      timer = window.setTimeout(() => {
        const parts = [...tip.childNodes].map((n) => {
          const el = n.nodeType === 1 ? (n as Element) : null;
          const style = el?.tagName === "B" ? "b" : el?.tagName === "KBD" ? "kbd" : el?.classList.contains("dim") ? "dim" : "";
          return { text: n.textContent ?? "", style } as const;
        }).filter((p) => p.text);
        const rail = tool.closest(".rail")!.getBoundingClientRect();
        show({ id: ++seq, parts, x: rail.right + 6, y: tool.getBoundingClientRect().top - 4, theme: useStore.getState().theme });
      }, 350);
    };
    document.addEventListener("pointerover", over);
    document.addEventListener("pointerdown", hide);
    document.documentElement.addEventListener("pointerleave", hide);
    return () => {
      hide();
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerdown", hide);
      document.documentElement.removeEventListener("pointerleave", hide);
      document.documentElement.classList.remove("native-tips");
    };
  }, [shown]);
  useEffect(
    () =>
      native?.onStackPress?.((id) => {
        if (id === "capture") return captureRef.current();
        const st = useStore.getState();
        const t = st.toasts.at(-1);
        if (id === "toast-action" && t) {
          t.action?.run();
          st.dismissToast(t.id);
        } else if (id === "toast-close" && t) st.dismissToast(t.id);
        else pressDockTool(id);
      }),
    []
  );

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
      // it sits over the app in the desktop, so it stays a while only
      const t = useStore.getState().toasts.at(-1);
      if (t) setTimeout(() => useStore.getState().dismissToast(t.id), 8000);
    } catch (e) {
      st.toast({ text: (e as Error).message.replace(/^Error:\s*/, ""), tone: "err" });
    } finally {
      setBusy(false);
    }
  };

  captureRef.current = () => void capture();

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
        <button type="button" className="toggle live-help" aria-label="how capturing works" onClick={() => setIntro(true)}>
          ?
          <Tip name="How it works" does="shows what to do in this tab again" />
        </button>
      </div>
      {native?.markMode && <ToolSettings inline />}
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
        {/* the desktop's own view gets the card from a view of its own (liveCard.ts) */}
        {!native && intro && <IntroCardView card={DESKTOP_INTRO} onClose={closeIntro} />}
        {/* in a harness's iframe the canvas can draw over the app; the desktop's own view gets native buttons (floatStack.ts) */}
        {!native && <FloatStack main={captureButton(canCapture && !!src && !intro, busy)} onMain={() => void capture()} />}
      </div>
    </section>
  );
}
