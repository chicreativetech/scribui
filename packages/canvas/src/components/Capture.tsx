import { useEffect, useState } from "react";
import { api, type RoundPayload } from "../api";
import { useStore } from "../store";
import { hasLiveTab } from "./Live";

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

  // sent: the agent is on it; applied: the next round starts on its own, empty (while ScribUI runs)
  const text =
    status === "sent"
      ? `Sent to your agent. When it's done, round ${pad(round.round + 1)} starts here, empty: add the screens it changed.`
      : `${changedText(round)} ${addAgain(round.app?.platform)}`;
  return (
    <div className={`next-banner ${status}`}>
      <span className={status === "applied" ? "ok" : "accent"}>●</span>
      <span>{text}</span>
      <button className="x" onClick={() => st.set({ appliedDismissed: round.round })} aria-label="dismiss">
        ✕
      </button>
    </div>
  );
}

/** "The agent applied round 004 and changed Cart, Checkout." */
function changedText(round: RoundPayload): string {
  const changed = round.status.changedScreens;
  const titles = changed === "all" ? "every screen" : (changed ?? []).map((id) => round.screens.find((x) => x.id === id)?.title ?? id).join(", ");
  return `The agent applied round ${pad(round.round)}${titles ? ` and changed ${titles}` : ""}.`;
}

/** Where the changed screens are added again, for this platform and this window. */
function addAgain(platform: string | undefined): string {
  if (platform === "android" || platform === "ios")
    return `Rebuild and reinstall the app, then capture the screens it changed${hasLiveTab(platform) ? " in the Device tab" : " in the ScribUI desktop app"}.`;
  return hasLiveTab(platform)
    ? "Capture the screens it changed in the Capture Screens tab."
    : "Send the pages it changed with the ScribUI browser extension, or paste new screenshots.";
}

/** A new, empty round: what the agent changed in the round before, to add again here. */
export function LastChanges({ round }: { round: RoundPayload }) {
  const [prev, setPrev] = useState<RoundPayload | null>(null);
  useEffect(() => {
    setPrev(null);
    if (round.round > 1) void api.round(round.round - 1).then(setPrev, () => {});
  }, [round.round]);
  if (prev?.status.status !== "applied") return null;
  return (
    <p>
      {changedText(prev)} {addAgain(prev.app?.platform)}
    </p>
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
