import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { focusTile } from "./Board";
import { Spinner } from "./Capture";

/**
 * The device tab of a mobile project, in the desktop app: an emulator, phone
 * or iOS Simulator live (H.264 from the main process, decoded here with WebCodecs), used
 * with the mouse and keyboard, and captured exactly as it is. Which buttons
 * show comes from the session's capabilities. Capturing freezes the picture,
 * shows the steps, and when the screen kept changing asks whether to try
 * again or keep the frame from when Capture was pressed.
 */

type Rotation = 0 | 90 | 180 | 270;
type LiveKey = "home" | "back" | "recents" | "lock";
type Capabilities = { video: string; pointer: boolean; scroll: boolean; text: boolean; physicalKeys: boolean; keys: LiveKey[]; rotate: boolean; orientation: string };
type DeviceInfo = { id: string; name: string; kind: "emulator" | "phone" | "simulator"; state: "ready" | "offline" | "unauthorized" | "booting" };
type DeviceState = {
  status: "idle" | "connecting" | "live" | "reconnecting" | "lost";
  device: { id: string; name: string } | null;
  /** `videoRotation`: the stream stays portrait (iOS Simulator); turn it clockwise by this much to show it. */
  size: { width: number; height: number; scale: number; rotation: Rotation; videoRotation?: Rotation } | null;
  capabilities: Capabilities | null;
  message: string | null;
};
type DeviceList = {
  devices: DeviceInfo[];
  startable: { id: string; name: string }[];
  /** `installable`: the app can install it itself. */
  missing: { tool: string; install?: string; installable?: "adb" | "axe" } | null;
};
type Frame = { config: boolean; key: boolean; pts: number; data: Uint8Array; codec?: string };
type Progress = { step: "screenshot" | "elements" | "verifying" | "retrying"; attempt: number };
type Saved = { round: number; screenId: string; title: string };
type Outcome = { kind: "saved"; result: Saved } | { kind: "unsettled"; first: Uint8Array; last: Uint8Array; attempts: number; elements: boolean };
type EditKey = "enter" | "backspace" | "delete" | "tab" | "escape" | "up" | "down" | "left" | "right" | "home" | "end";
type Input =
  | { type: "pointer"; action: "down" | "move" | "up"; x: number; y: number }
  | { type: "scroll"; x: number; y: number; dx: number; dy: number }
  | { type: "key"; key: LiveKey }
  | { type: "edit"; key: EditKey }
  | { type: "text"; text: string }
  | { type: "physical"; code: string; shift: boolean; alt: boolean; text: string }
  | { type: "rotate" };

export type DesktopDevice = {
  platform: "android" | "ios";
  state(): Promise<DeviceState>;
  list(): Promise<DeviceList>;
  connect(id: string): Promise<DeviceState>;
  disconnect(): Promise<void>;
  /** Start an emulator or boot a simulator from `startable`, then show it. */
  start(id: string): Promise<DeviceState>;
  setVisible(v: boolean): void;
  resetVideo(): void;
  input(ev: Input): void;
  capture(req: { title?: string; replace?: string }): Promise<Outcome>;
  keep(): Promise<Saved>;
  discard(): void;
  cancel(): void;
  onState(cb: (s: DeviceState) => void): () => void;
  onFrame(cb: (f: Frame) => void): () => void;
  onProgress(cb: (p: Progress) => void): () => void;
  /** Install a missing tool the list marked `installable` (desktop 5+); its output comes through onInstallLog. */
  install?(id: "adb" | "axe"): Promise<{ ok: true } | { ok: false; error: string }>;
  onInstallLog?(cb: (line: string) => void): () => void;
};

export const deviceApi: DesktopDevice | null =
  typeof window !== "undefined" ? ((window as unknown as { scribuiDesktop?: { device?: DesktopDevice } }).scribuiDesktop?.device ?? null) : null;

const pad = (n: number) => String(n).padStart(3, "0");
const STEPS: Record<Progress["step"], string> = {
  screenshot: "Taking the screenshot",
  elements: "Reading the elements",
  verifying: "Checking the screen held still",
  retrying: "The screen moved; trying again",
};
const KEY_LABEL: Record<LiveKey, { icon: string; title: string }> = {
  back: { icon: "◁", title: "Back" },
  home: { icon: "○", title: "Home" },
  recents: { icon: "▢", title: "Recent apps" },
  lock: { icon: "⏻", title: "Power: lock or wake the screen" },
};
const EDIT: Record<string, EditKey> = {
  Enter: "enter",
  Backspace: "backspace",
  Delete: "delete",
  Tab: "tab",
  Escape: "escape",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Home: "home",
  End: "end",
};
const ZOOMS = [
  { id: "fit", label: "fit window" },
  { id: "100", label: "100%" },
  { id: "75", label: "75%" },
  { id: "50", label: "50%" },
];

/** WebCodecs exists only in secure contexts (the canvas is served from 127.0.0.1). */
const canDecode = typeof window !== "undefined" && window.isSecureContext && typeof VideoDecoder !== "undefined";

function readPref(key: string, fallback: string) {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}
function writePref(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* storage blocked */
  }
}

/**
 * Decodes the stream into a <canvas>. A config packet (start, rotation, reset)
 * reconfigures the decoder and is merged into the next key frame; deltas
 * before a key frame are dropped; a decoder error asks the device for a fresh
 * key frame. While `frozen`, the picture stays as it was.
 */
function useDecoder(api: DesktopDevice, canvas: React.RefObject<HTMLCanvasElement | null>, frozen: React.RefObject<boolean>, turn: React.RefObject<Rotation>) {
  const [painted, setPainted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!canDecode) return;
    let decoder: VideoDecoder | null = null;
    let config: Uint8Array | null = null;
    let needKey = true;
    let lastReset = 0;
    let first = true;
    const reset = () => {
      needKey = true;
      if (Date.now() - lastReset > 1000) {
        lastReset = Date.now();
        api.resetVideo();
      }
    };
    const configure = (codec: string) => {
      if (decoder && decoder.state !== "closed") decoder.close();
      decoder = new VideoDecoder({
        output: (f) => {
          const c = canvas.current;
          if (c && !frozen.current) {
            // a portrait stream of a turned screen is drawn turned upright
            const t = turn.current;
            const sideways = t === 90 || t === 270;
            const w = sideways ? f.displayHeight : f.displayWidth;
            const h = sideways ? f.displayWidth : f.displayHeight;
            if (c.width !== w || c.height !== h) {
              c.width = w;
              c.height = h;
            }
            const ctx = c.getContext("2d");
            if (ctx) {
              ctx.setTransform(1, 0, 0, 1, 0, 0);
              if (t) {
                ctx.translate(w / 2, h / 2);
                ctx.rotate((t * Math.PI) / 180);
                ctx.translate(-f.displayWidth / 2, -f.displayHeight / 2);
              }
              ctx.drawImage(f, 0, 0);
            }
            if (first) {
              first = false;
              setPainted(true);
            }
          }
          f.close();
        },
        error: (e) => {
          setError(e.message);
          reset();
        },
      });
      decoder.configure({ codec, optimizeForLatency: true });
      needKey = true;
    };
    const off = api.onFrame((p) => {
      if (p.config) {
        config = p.data;
        if (p.codec) configure(p.codec);
        return;
      }
      if (!decoder || decoder.state !== "configured") return reset();
      if (needKey && !p.key) return;
      let data = p.data;
      if (config) {
        const m = new Uint8Array(config.length + data.length);
        m.set(config);
        m.set(data, config.length);
        data = m;
        config = null;
      }
      try {
        decoder.decode(new EncodedVideoChunk({ type: p.key ? "key" : "delta", timestamp: p.pts, data }));
        needKey = false;
        setError(null);
      } catch (e) {
        setError((e as Error).message);
        reset();
      }
    });
    api.resetVideo();
    return () => {
      off();
      if (decoder && decoder.state !== "closed") decoder.close();
    };
  }, [api, canvas, frozen, turn]);
  return { painted, error };
}

export function DeviceTab({ api }: { api: DesktopDevice }) {
  const view = useStore((s) => s.view);
  const visited = useStore((s) => s.liveVisited);
  const project = useStore((s) => s.project);
  const manifest = project && "app" in project.manifest ? project.manifest : null;
  const handmade = (manifest?.screens ?? []).filter((s) => s.live);
  const covered = useStore((s) => s.helpOpen || s.sendOpen || !!s.sentPrompt || s.lanOpen);
  const shown = view === "live" && !covered;

  const [state, setState] = useState<DeviceState>({ status: "idle", device: null, size: null, capabilities: null, message: null });
  const [list, setList] = useState<DeviceList | null>(null);
  const [listing, setListing] = useState(false);
  const [starting, setStarting] = useState<string | null>(null);
  const [zoom, setZoom] = useState(() => readPref("scribui:device-zoom", "fit"));
  const [name, setName] = useState("");
  const [replace, setReplace] = useState("");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [busy, setBusy] = useState(false);
  /** A tool install from the empty state: its latest output line, and how it failed. */
  const [installing, setInstalling] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [unsettled, setUnsettled] = useState<{ first: string; last: string; attempts: number; elements: boolean } | null>(null);
  const [room, setRoom] = useState({ width: 0, height: 0 });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const roomRef = useRef<HTMLDivElement>(null);
  const frozen = useRef(false);
  const auto = useRef(false);
  const busyRef = useRef(false);
  const moveQueued = useRef<{ x: number; y: number } | null>(null);
  const down = useRef(false);
  const turn = useRef<Rotation>(0);
  const { painted, error: decodeError } = useDecoder(api, canvasRef, frozen, turn);

  useEffect(() => api.onState(setState), [api]);
  useEffect(() => api.onProgress(setProgress), [api]);
  useEffect(() => api.onInstallLog?.((line) => setInstalling(line)), [api]);

  // frames only flow while the tab shows
  useEffect(() => {
    api.setVisible(shown);
    return () => api.setVisible(false);
  }, [api, shown]);

  const refresh = useCallback(async () => {
    setListing(true);
    try {
      const l = await api.list();
      setList(l);
      return l;
    } catch (e) {
      useStore.getState().toast({ text: (e as Error).message, tone: "err" });
      return null;
    } finally {
      setListing(false);
    }
  }, [api]);

  const connect = useCallback(
    async (id: string) => {
      writePref("scribui:device", id);
      setState(await api.connect(id));
    },
    [api],
  );

  // first visit: the device from last time, or the only one connected
  useEffect(() => {
    if (!visited || auto.current) return;
    auto.current = true;
    void (async () => {
      const now = await api.state();
      setState(now);
      const l = await refresh();
      if (!l || now.status !== "idle") return;
      const ready = l.devices.filter((d) => d.state === "ready");
      const last = readPref("scribui:device", "");
      const pick = ready.find((d) => d.id === last) ?? (ready.length === 1 ? ready[0] : undefined);
      if (pick) await connect(pick.id);
    })();
  }, [visited, api, refresh, connect]);

  // the free room for the device, for fitting it
  useLayoutEffect(() => {
    const el = roomRef.current;
    if (!el) return;
    const measure = () => setRoom({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [visited]);

  const live = state.status === "live" || state.status === "reconnecting";
  const hasCanvas = live && !!state.size;
  const videoTurn = state.size?.videoRotation ?? 0;
  useLayoutEffect(() => {
    turn.current = videoTurn;
  }, [videoTurn]);
  // a canvas that was just (re)mounted is blank until the next frame, and a turned
  // picture is drawn the new way from the next one: ask for a key frame
  useEffect(() => {
    if (hasCanvas) api.resetVideo();
  }, [api, hasCanvas, videoTurn]);

  if (!visited) return null;

  const caps = state.capabilities;
  const size = state.size;
  // the device's size in its own points (device pixels / scale), then fitted or zoomed
  const BEZEL = 14;
  const MARGIN = 24;
  let display: { width: number; height: number } | null = null;
  if (size && size.width && size.height) {
    const pw = size.width / size.scale;
    const ph = size.height / size.scale;
    const fit = Math.min((room.width - 2 * MARGIN - 2 * BEZEL) / pw, (room.height - 2 * MARGIN - 2 * BEZEL) / ph);
    const k = zoom === "fit" ? Math.max(0.1, fit) : Number(zoom) / 100;
    display = { width: Math.round(pw * k), height: Math.round(ph * k) };
  }

  /* ───────── input ───────── */

  const point = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const interactive = live && state.status === "live" && !busy && !unsettled;
  const send = (ev: Input) => {
    if (interactive) api.input(ev);
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (!interactive || e.button !== 0 || !caps?.pointer) return;
    screenRef.current?.focus();
    (e.target as Element).setPointerCapture(e.pointerId);
    down.current = true;
    send({ type: "pointer", action: "down", ...point(e) });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!down.current) return;
    const first = !moveQueued.current;
    moveQueued.current = point(e);
    // at most one move per frame
    if (first)
      requestAnimationFrame(() => {
        const p = moveQueued.current;
        moveQueued.current = null;
        if (p && down.current) send({ type: "pointer", action: "move", ...p });
      });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!down.current) return;
    down.current = false;
    moveQueued.current = null;
    send({ type: "pointer", action: "up", ...point(e) });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!interactive || !caps?.text) return;
    if (e.metaKey || e.ctrlKey) return; // the app's own shortcuts (and paste, below)
    const edit = EDIT[e.key];
    const char = e.key.length === 1 || [...e.key].length === 1;
    if (edit) {
      e.preventDefault();
      send({ type: "edit", key: edit });
    } else if (caps.physicalKeys && (char || e.key === "Dead") && e.code) {
      // the device turns the key into a character with its own layout (dead keys compose there)
      e.preventDefault();
      send({ type: "physical", code: e.code, shift: e.shiftKey, alt: e.altKey, text: char ? e.key : "" });
    } else if (char) {
      e.preventDefault();
      send({ type: "text", text: e.key });
    }
  };
  const onPaste = (e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData("text/plain");
    if (text && caps?.text) {
      e.preventDefault();
      send({ type: "text", text: text.slice(0, 2000) });
    }
  };

  /* ───────── capture ───────── */

  const toastSaved = (r: Saved, warn: boolean) => {
    const st = useStore.getState();
    void st.refreshRounds().then(() => st.load(r.round));
    st.toast({
      text: `captured "${r.title}" into R${pad(r.round)}${warn ? " (the screen was still changing)" : ""}`,
      tone: warn ? "warn" : "ok",
      action: {
        label: "show on board",
        run: () => {
          useStore.getState().set({ view: "board" });
          setTimeout(() => focusTile(r.screenId), 60);
        },
      },
    });
    setName("");
    setReplace("");
  };

  const endCapture = () => {
    frozen.current = false;
    busyRef.current = false;
    setBusy(false);
    setProgress(null);
  };

  const capture = async () => {
    if (state.status !== "live" || busyRef.current) return;
    // the picture stays as it was when Capture was pressed
    frozen.current = true;
    busyRef.current = true;
    setBusy(true);
    setUnsettled(null);
    try {
      const out = await api.capture({ ...(name.trim() ? { title: name.trim() } : {}), ...(replace ? { replace } : {}) });
      if (out.kind === "saved") {
        toastSaved(out.result, false);
        endCapture();
      } else {
        const url = (b: Uint8Array) => URL.createObjectURL(new Blob([b as BlobPart], { type: "image/png" }));
        setUnsettled({ first: url(out.first), last: url(out.last), attempts: out.attempts, elements: out.elements });
        setProgress(null);
      }
    } catch (e) {
      const msg = (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
      if (!/cancelled/.test(msg)) useStore.getState().toast({ text: msg, tone: "err" });
      endCapture();
    }
  };

  const closeUnsettled = () => {
    if (unsettled) {
      URL.revokeObjectURL(unsettled.first);
      URL.revokeObjectURL(unsettled.last);
    }
    setUnsettled(null);
  };
  const keepFirst = async () => {
    try {
      toastSaved(await api.keep(), true);
    } catch (e) {
      useStore.getState().toast({ text: (e as Error).message, tone: "err" });
    }
    closeUnsettled();
    endCapture();
  };
  const tryAgain = () => {
    closeUnsettled();
    api.discard();
    frozen.current = false;
    busyRef.current = false;
    setBusy(false);
    // a fresh frame first, so what's captured is what's shown
    requestAnimationFrame(() => setTimeout(() => void capture(), 150));
  };
  const dismiss = () => {
    closeUnsettled();
    api.discard();
    endCapture();
  };

  const start = async (id: string) => {
    setStarting(list?.startable.find((s) => s.id === id)?.name ?? id);
    try {
      setState(await api.start(id));
      await refresh();
    } catch (e) {
      useStore.getState().toast({ text: (e as Error).message, tone: "err" });
    } finally {
      setStarting(null);
    }
  };

  const devices = list?.devices ?? [];
  const ios = api.platform === "ios";
  const pickValue = state.device?.id ?? "";
  const known = devices.some((d) => d.id === pickValue);

  /* ───────── render ───────── */

  return (
    <section className={`live-pane device-pane ${view === "live" ? "" : "off"}`} aria-hidden={view !== "live"}>
      <div className="live-bar">
        <select
          className="live-select device-pick"
          value={pickValue}
          onChange={(e) => {
            const v = e.target.value;
            if (v.startsWith("start:")) void start(v.slice(6));
            else if (v) void connect(v);
          }}
          title="device"
          disabled={busy || !!starting}
        >
          {!pickValue && <option value="">choose a device…</option>}
          {pickValue && !known && <option value={pickValue}>{state.device?.name}</option>}
          {devices.map((d) => (
            <option key={d.id} value={d.id} disabled={d.state !== "ready"}>
              {d.name}
              {d.kind === "phone" ? " (USB)" : ""}
              {d.state !== "ready" ? ` (${d.state})` : ""}
            </option>
          ))}
          {list?.startable.map((a) => (
            <option key={a.id} value={`start:${a.id}`}>
              start {a.name}
            </option>
          ))}
        </select>
        <button className={`toggle ${listing ? "spin" : ""}`} title="look for devices again" onClick={() => void refresh()}>
          ⟳
        </button>
        {caps && (
          <span className="device-keys">
            {caps.keys.map((k) => (
              <button key={k} className="toggle" title={KEY_LABEL[k].title} disabled={!interactive} onClick={() => send({ type: "key", key: k })}>
                {KEY_LABEL[k].icon}
              </button>
            ))}
            {caps.rotate && (
              <button className="toggle" title="rotate the device (turns auto-rotate off)" disabled={!interactive} onClick={() => send({ type: "rotate" })}>
                ⟲
              </button>
            )}
          </span>
        )}
        <select
          className="live-select"
          value={zoom}
          onChange={(e) => {
            setZoom(e.target.value);
            writePref("scribui:device-zoom", e.target.value);
          }}
          title="size of the device"
        >
          {ZOOMS.map((z) => (
            <option key={z.id} value={z.id}>
              {z.label}
            </option>
          ))}
        </select>
        <span className="live-sep" />
        <input
          className="live-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={replace ? "keep its name" : "name (screen title)"}
          disabled={!live}
          onKeyDown={(e) => e.key === "Enter" && void capture()}
        />
        <select className="live-select" value={replace} onChange={(e) => setReplace(e.target.value)} disabled={!live} title="add a new view or replace one">
          <option value="">as a new view</option>
          {handmade.map((s) => (
            <option key={s.id} value={s.id}>
              replace "{s.title}"
            </option>
          ))}
        </select>
        <button className="live-capture" onClick={() => void capture()} disabled={state.status !== "live" || busy} title="screenshot the device exactly as it is now">
          {busy ? <Spinner /> : "●"} Capture view
        </button>
      </div>
      {!canDecode && (
        <div className="live-note">
          The device view needs WebCodecs, which this page can't use (it isn't a secure context). Open the project from the ScribUI app.
        </div>
      )}
      <div ref={roomRef} className={`live-viewport device-room ${zoom === "fit" ? "fit" : ""}`}>
        {live && display ? (
          <div className={`device-frame ${state.status === "reconnecting" ? "dim" : ""}`} style={{ padding: BEZEL }}>
            <div
              ref={screenRef}
              className="device-screen"
              tabIndex={0}
              style={{ width: display.width, height: display.height }}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              title={caps?.text ? "click to use the device; type to enter text" : undefined}
            >
              <canvas
                ref={canvasRef}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onWheel={(e) => {
                  if (!caps?.scroll) return;
                  const k = e.deltaMode === 1 ? 1 / 3 : 1 / 100;
                  send({ type: "scroll", ...point(e), dx: -e.deltaX * k, dy: -e.deltaY * k });
                }}
              />
              {!painted && <div className="device-wait">waiting for the picture…</div>}
              {state.status === "reconnecting" && (
                <div className="device-wait">
                  <Spinner /> reconnecting to {state.device?.name}…
                </div>
              )}
              {busy && !unsettled && (
                <div className="device-progress" role="status">
                  <Spinner /> {progress ? STEPS[progress.step] : "Capturing"}
                  {progress && progress.attempt > 1 ? ` (${progress.attempt})` : ""}
                  <button className="link" onClick={() => api.cancel()}>
                    cancel
                  </button>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="live-empty device-empty">
            {state.status === "connecting" ? (
              <p>
                <Spinner /> {starting ? `starting ${starting}… (this can take a minute)` : `connecting to ${state.device?.name ?? "the device"}…`}
              </p>
            ) : list?.missing ? (
              <>
                <p>The device view needs {list.missing.tool}.</p>
                {list.missing.installable && api.install && (
                  <p>
                    <button
                      className="live-capture"
                      disabled={installing !== null}
                      onClick={async () => {
                        setInstallError(null);
                        setInstalling("starting…");
                        const r = await api.install!(list.missing!.installable!);
                        setInstalling(null);
                        if (!r.ok) setInstallError(r.error);
                        else void refresh();
                      }}
                    >
                      {installing !== null ? <><Spinner /> Installing {list.missing.tool}…</> : `Install ${list.missing.tool}`}
                    </button>
                  </p>
                )}
                {installing !== null && <p className="faint device-install-log">{installing}</p>}
                {installError && <p className="err">Install failed: {installError}</p>}
                {list.missing.install && (
                  <p>
                    <code>{list.missing.install}</code>{" "}
                    <button className="link" onClick={() => void navigator.clipboard.writeText(list.missing!.install!)}>
                      copy
                    </button>
                  </p>
                )}
                <p className="faint">{list.missing.installable && api.install ? "Or install it from a terminal, then look for devices again (⟳)." : "Then look for devices again (⟳)."}</p>
              </>
            ) : (
              <>
                {state.status === "lost" && state.message && <p className="err">{state.message}</p>}
                {state.status === "lost" && state.device && (
                  <p>
                    <button className="live-capture" onClick={() => void connect(state.device!.id)}>
                      ⟳ Try {state.device.name} again
                    </button>
                  </p>
                )}
                {devices.filter((d) => d.state === "ready").length ? (
                  <p>Choose a device above.</p>
                ) : (
                  <p>{ios ? "No simulator is running." : "No emulator or phone is connected."}</p>
                )}
                {devices
                  .filter((d) => d.state !== "ready")
                  .map((d) => (
                    <p key={d.id} className="warn">
                      {d.name}:{" "}
                      {d.state === "unauthorized"
                        ? "allow USB debugging on the phone"
                        : d.state === "booting"
                          ? "still starting"
                          : "offline; reconnect its cable"}
                    </p>
                  ))}
                {!!list?.startable.length && (
                  <p className="device-avds">
                    {list.startable.slice(0, ios ? 6 : undefined).map((a) => (
                      <button key={a.id} className="live-capture" disabled={!!starting} onClick={() => void start(a.id)}>
                        ▶ Start {a.name}
                      </button>
                    ))}
                  </p>
                )}
                {!!list && ios && list.startable.length > 6 && <p className="faint">More simulators are in the list above.</p>}
                {!devices.length && !list?.startable.length && list && (
                  <p className="faint">
                    {ios
                      ? "Create a simulator in Xcode (Window → Devices and Simulators)."
                      : "Start an emulator from Android Studio, or connect a phone with USB debugging on."}
                  </p>
                )}
              </>
            )}
          </div>
        )}
        {decodeError && live && <div className="device-error faint">decoder: {decodeError}</div>}
        {unsettled && (
          <div className="device-unsettled" role="dialog" aria-label="the screen was still changing">
            <h3>The screen was still changing</h3>
            <p className="faint">
              {unsettled.elements
                ? `The screenshots before and after reading the elements differ (${unsettled.attempts} ${unsettled.attempts === 1 ? "try" : "tries"}). If you keep the first frame, element positions may be off.`
                : "It never stopped (a running timer, a video or a spinner?), so its elements can't be read. If you keep the first frame, notes on it mark regions instead of elements; pausing it and trying again gives the elements."}
            </p>
            <div className="device-frames">
              <figure>
                <img src={unsettled.first} alt="when you pressed Capture" />
                <figcaption>when you pressed Capture</figcaption>
              </figure>
              <figure>
                <img src={unsettled.last} alt="a moment later" />
                <figcaption>a moment later</figcaption>
              </figure>
            </div>
            <div className="device-actions">
              <button className="live-capture" onClick={tryAgain}>
                Try again
              </button>
              <button className="toggle" onClick={() => void keepFirst()}>
                Keep first frame
              </button>
              <button className="toggle" onClick={dismiss}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
