import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { focusTile } from "./Board";
import { Spinner } from "./Capture";

/**
 * The app tab: the running web app, for capturing views by hand.
 * In a browser the app is embedded in an iframe, and capturing needs the
 * Chrome window ScribUI opens: it exposes `window.__scribuiCapture`, which
 * screenshots the embedded app as it is. In the desktop app the app has its
 * own view (`scribuiDesktop.live`): this tab reports where it should sit and
 * drives it; pages that refuse embedding work there.
 */

type CaptureFn = (req: { title?: string; replace?: string }) => Promise<{ round: number; screenId: string; title: string }>;
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

  if (!visited) return null;

  const go = (raw: string) => {
    const v = raw.trim();
    if (!v) return;
    let url = v;
    if (v.startsWith("/") && base) url = new URL(v, base).toString();
    else if (!/^[a-z]+:\/\//i.test(v)) url = `http://${v}`;
    setAddress(url);
    if (native) {
      started.current = true;
      void native.navigate(url);
      return;
    }
    if (url === src) setReloadKey((k) => k + 1);
    else setSrc(url);
  };
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
          label: "show on board",
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
              <button type="button" className="toggle" title="back" disabled={!state?.canGoBack} onClick={() => void native.back()}>
                ‹
              </button>
              <button type="button" className="toggle" title="forward" disabled={!state?.canGoForward} onClick={() => void native.forward()}>
                ›
              </button>
            </>
          )}
          <button type="button" className={`toggle ${state?.loading ? "spin" : ""}`} title="reload the app (its state is lost)" onClick={reload}>
            ⟳
          </button>
          <input ref={addressRef} value={address} onChange={(e) => setAddress(e.target.value)} placeholder={base || "http://localhost:3000"} spellCheck={false} />
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
      {!canCapture && !native && (
        <div className="live-note">
          Capturing works in the Chrome window ScribUI opens for web projects. Press <kbd>o</kbd> in the terminal where ScribUI runs to
          bring it back.
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
