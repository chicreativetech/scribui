import { useEffect, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import { hasLiveTab, showLive } from "./Live";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const pad = (n: number) => String(n).padStart(3, "0");

export function Spinner() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((x) => x + 1), 90);
    return () => clearInterval(t);
  }, []);
  return <span className="spinner">{FRAMES[i % FRAMES.length]}</span>;
}

/** Progress of the running capture: a bar under the top bar and a panel on the board. */
export function CapturePanel() {
  const cs = useStore((s) => s.captureState);
  const ext = useStore((s) => s.externalCapture);
  const platform = useStore((s) => s.round?.app?.platform ?? (s.project && "app" in s.project.manifest ? s.project.manifest.app.platform : undefined));
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => setDismissed(false), [cs.phase, cs.error]);

  const running = cs.running || !!ext;
  const total = cs.running ? (cs.total ?? 0) : (ext?.total ?? 0);
  const done = cs.running ? (cs.done ?? 0) : (ext?.done ?? 0);
  const current = cs.running ? cs.current : ext?.current;
  const queue = cs.running ? (cs.queue ?? []) : (ext?.queue ?? []);
  const round = cs.running ? cs.round : ext?.round;
  const mobile = platform === "android" || platform === "ios";

  if (cs.phase === "failed" && !dismissed) {
    return (
      <div className="capture-panel failed" role="alert">
        <div className="cp-head">
          <span className="err">✗ capture failed</span>
          <button className="btn" onClick={() => setDismissed(true)}>
            dismiss
          </button>
        </div>
        <pre className="cp-log">{[...(cs.log ?? []).slice(-8), cs.error ?? ""].filter(Boolean).join("\n")}</pre>
        <div className="cp-actions">
          <button className="btn primary" onClick={() => void useStore.getState().captureNext()}>
            Try again
          </button>
        </div>
      </div>
    );
  }
  if (!running) return null;

  const pct = cs.phase === "building" ? 0 : total ? Math.round((done / total) * 100) : 0;
  return (
    <>
      <div className={`capture-bar ${cs.phase === "building" || !total ? "indeterminate" : ""}`}>
        <div style={{ width: `${pct}%` }} />
      </div>
      <div className="capture-panel" role="status" aria-live="polite">
        <div className="cp-head">
          <span>
            <Spinner />{" "}
            {cs.phase === "building" ? (
              <b>Rebuilding the app</b>
            ) : (
              <b>
                Capturing{round ? ` round ${pad(round)}` : ""}
                {total ? (
                  <span className="dim">
                    {" "}
                    · {done}/{total}
                  </span>
                ) : null}
              </b>
            )}
          </span>
        </div>
        {cs.trigger === "agent-applied" && cs.phase !== "building" && <div className="cp-sub">The agent applied the review; capturing what changed.</div>}
        {cs.phase === "building" ? (
          <pre className="cp-log">{(cs.log ?? []).slice(-8).join("\n")}</pre>
        ) : (
          <div className="cp-list">
            {current && (
              <div className="cur">
                <span className="accent">›</span> {current}
              </div>
            )}
            {queue
              .filter((q) => q !== current)
              .slice(0, 6)
              .map((q) => (
                <div key={q} className="dim">
                  · {q}
                </div>
              ))}
          </div>
        )}
        {mobile && cs.phase !== "building" && <div className="cp-sub">Mobile capture is in beta: about 10 s per screen.</div>}
      </div>
    </>
  );
}

/** What to do next once the round is sent or applied. */
export function NextStepBanner() {
  const round = useStore((s) => s.round);
  const rounds = useStore((s) => s.rounds);
  const cs = useStore((s) => s.captureState);
  const ext = useStore((s) => s.externalCapture);
  const dismissed = useStore((s) => s.appliedDismissed);
  if (!round) return null;
  const status = round.status.status;
  if (status !== "sent" && status !== "applied") return null;
  if (cs.running || ext) return null;
  const latest = rounds.length ? Math.max(...rounds.map((r) => r.round)) : round.round;
  const st = useStore.getState();

  if (round.round !== latest) {
    return (
      <div className="ro-banner">
        <b>●</b> round {pad(round.round)} is {status}: read-only
        <button className="btn" onClick={() => void st.load(latest)}>
          go to latest
        </button>
      </div>
    );
  }
  if (dismissed === round.round) return null;

  const platform = round.app?.platform;
  const mobile = platform === "android" || platform === "ios";
  const canCapture = !!round.canRecapture;

  if (mobile || !canCapture) {
    // Android and iOS screens, and web views captured by hand without a url, are captured again by hand:
    // say which ones changed, and where to capture them
    const changed = round.status.changedScreens;
    const titles =
      changed === "all"
        ? "every screen"
        : (changed ?? []).map((id) => round.screens.find((x) => x.id === id)?.title ?? id).join(", ");
    const device = hasLiveTab(platform);
    const text = !mobile
      ? status === "sent"
        ? "Sent to your agent. When it's done, capture the screens it changed again in the App tab."
        : `The agent applied round ${pad(round.round)}${titles ? ` and changed ${titles}` : ""}. Capture ${titles ? "them" : "the changed screens"} again in the App tab: pick replace "…" next to Capture view to update a screen in place.`
      : status === "sent"
        ? "Sent to your agent. When it's done, rebuild and reinstall the app, then capture the screens it changed again."
        : `The agent applied round ${pad(round.round)}${titles ? ` and changed ${titles}` : ""}. Rebuild and reinstall the app, then capture ${titles ? "them" : "the changed screens"} again${device ? " in the Device tab" : " in the ScribUI desktop app"}. Pick replace "…" next to Capture view to update a screen in place.`;
    return (
      <div className={`next-banner ${status}`}>
        <span className={status === "applied" ? "ok" : "accent"}>●</span>
        <span>{text}</span>
        {device && status === "applied" && (
          <button className="btn primary" onClick={() => showLive()}>
            Open the {mobile ? "Device" : "App"} tab
          </button>
        )}
        <button className="x" onClick={() => st.set({ appliedDismissed: round.round })} aria-label="dismiss">
          ✕
        </button>
      </div>
    );
  }

  const text =
    status === "sent" ? "Sent to your agent. ScribUI recaptures automatically when it marks the round applied." : `The agent applied round ${pad(round.round)}.`;

  return (
    <div className={`next-banner ${status}`}>
      <span className={status === "applied" ? "ok" : "accent"}>●</span>
      <span>{text}</span>
      {canCapture && (
        <button className="btn primary" onClick={() => void st.captureNext()}>
          ↻ Recapture{status === "sent" ? " now" : ""}
        </button>
      )}
      <button className="x" onClick={() => st.set({ appliedDismissed: round.round })} aria-label="dismiss">
        ✕
      </button>
    </div>
  );
}

/** Pair a tablet (any device with a browser): QR code with a one-time link. */
export function LanDialog() {
  const open = useStore((s) => s.lanOpen);
  const lan = useStore((s) => s.lan);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const fresh = async () => {
    setError(null);
    try {
      useStore.getState().set({ lan: await api.startLan() });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const unpair = async () => {
    setError(null);
    try {
      useStore.getState().set({ lan: await api.unpairAll() });
      useStore.getState().toast({ text: "all devices unpaired", tone: "ok" });
      await fresh(); // a new code, ready for the next device
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    if (!open) return;
    void fresh();
    const t = setInterval(() => setNow(Date.now()), 1000);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && useStore.getState().set({ lanOpen: false });
    window.addEventListener("keydown", onKey, true);
    return () => {
      clearInterval(t);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  if (!open) return null;

  const left = lan.expiresAt ? Math.max(0, lan.expiresAt - now) : 0;
  const mm = Math.floor(left / 60000);
  const ss = String(Math.floor((left % 60000) / 1000)).padStart(2, "0");
  return (
    <div className="scrim" onClick={() => useStore.getState().set({ lanOpen: false })}>
      <div className="modal lan" onClick={(e) => e.stopPropagation()}>
        <div className="mh">
          <span>review on a tablet</span>
          <span>
            <kbd>esc</kbd>
          </span>
        </div>
        <div className="mb lan-body">
          <div className="qr" dangerouslySetInnerHTML={{ __html: lan.qr ?? "" }} />
          <div>
            <h2>
              Scan to pair<span className="accent">.</span>
            </h2>
            <ol className="lan-steps">
              <li>Join the same Wi-Fi as this computer.</li>
              <li>Scan the code with the tablet's camera, or open the link below in its browser.</li>
              <li>
                Review with a finger or a stylus (Apple Pencil, S Pen, Surface Pen). Loops, arrows and handwriting are recognised.
              </li>
            </ol>
            {error ? (
              <div className="err">✗ {error}</div>
            ) : (
              <>
                <div className="lan-url">{lan.url ?? "…"}</div>
                <div className="dim" style={{ fontSize: 11 }}>
                  {left > 0 ? `One-time link · expires in ${mm}:${ss}` : lan.url ? "Link used or expired" : ""}
                  {lan.paired > 0 && (
                    <span className="ok">
                      {" "}
                      · ● {lan.paired} device{lan.paired === 1 ? "" : "s"} paired
                    </span>
                  )}
                </div>
              </>
            )}
            <div className="dim" style={{ fontSize: 11, marginTop: 8 }}>
              iPad, Android tablet, Surface or any other device with a modern browser. Devices stay paired until you unpair them or quit
              ScribUI.
            </div>
            <div className="actions" style={{ justifyContent: "flex-start" }}>
              <button className="btn" onClick={() => void fresh()}>
                new code
              </button>
              {lan.paired > 0 && (
                <button className="btn" onClick={() => void unpair()}>
                  unpair all
                </button>
              )}
              <button className="btn primary" onClick={() => useStore.getState().set({ lanOpen: false })}>
                Done
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
