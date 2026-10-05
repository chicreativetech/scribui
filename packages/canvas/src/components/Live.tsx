import { useEffect, useState } from "react";
import { useStore } from "../store";
import { focusTile } from "./Board";
import { Spinner } from "./Capture";

/**
 * The app tab: the running web app, embedded, for capturing views by hand.
 * Capturing needs the Chrome window intentcue opens: it exposes
 * `window.__intentcueCapture`, which screenshots the embedded app as it is.
 */

type CaptureFn = (req: { title?: string; replace?: string }) => Promise<{ round: number; screenId: string; title: string }>;
declare global {
  interface Window {
    __intentcueCapture?: CaptureFn;
  }
}

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
    return localStorage.getItem("intentcue:live-size") || "fit";
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
  const canCapture = typeof window.__intentcueCapture === "function";

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
    window.addEventListener("intentcue:live-url", onUrl);
    return () => window.removeEventListener("intentcue:live-url", onUrl);
  }, []);

  if (!visited) return null;

  const go = (raw: string) => {
    const v = raw.trim();
    if (!v) return;
    let url = v;
    if (v.startsWith("/") && base) url = new URL(v, base).toString();
    else if (!/^[a-z]+:\/\//i.test(v)) url = `http://${v}`;
    setAddress(url);
    if (url === src) setReloadKey((k) => k + 1);
    else setSrc(url);
  };

  const pickSize = (id: string) => {
    setSize(id);
    try {
      localStorage.setItem("intentcue:live-size", id);
    } catch {
      /* storage blocked */
    }
  };

  const capture = async () => {
    if (!window.__intentcueCapture || busy) return;
    setBusy(true);
    const st = useStore.getState();
    try {
      const r = await window.__intentcueCapture({ ...(name.trim() ? { title: name.trim() } : {}), ...(replace ? { replace } : {}) });
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

  const preset = SIZES.find((s) => s.id === size) ?? SIZES[0]!;
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
          <button type="button" className="toggle" title="reload the app (its state is lost)" onClick={() => setReloadKey((k) => k + 1)}>
            ⟳
          </button>
          <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder={base || "http://localhost:3000"} spellCheck={false} />
        </form>
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
      {!canCapture && (
        <div className="live-note">
          Capturing works in the Chrome window intentcue opens for web projects. Press <kbd>o</kbd> in the terminal where intentcue runs to
          bring it back.
        </div>
      )}
      <div className="live-viewport">
        {src ? (
          <iframe
            key={reloadKey}
            data-intentcue-live=""
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
