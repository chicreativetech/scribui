import { isReadOnly, noteCount, useStore } from "../store";
import { Spinner } from "./Capture";

/**
 * The round buttons in the bottom-right corner: Tablet, Panel and Pen mode,
 * stacked above the tab's main button (Capture view in Capture Screens, Send
 * in Review; none on the vision board). In the desktop app's Capture Screens
 * tab the app's own view covers the canvas, so the desktop draws the stack in
 * a view of its own (floatStack.ts) from these same buttons, as data: labels,
 * icon paths and states, never markup.
 */

export type StackIcon = { box: number; paths: string[] };
export type StackButton = { id: string; label: string; icon: StackIcon; title: string; on?: boolean; disabled?: boolean; busy?: boolean };

/** Icon paths, in a square of `box`. */
export const STACK_ICON = {
  // Bootstrap Icons' camera-fill
  camera: { box: 16, paths: [
    "M10.5 8.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0",
    "M2 4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-1.172a2 2 0 0 1-1.414-.586l-.828-.828A2 2 0 0 0 9.172 2H6.828a2 2 0 0 0-1.414.586l-.828.828A2 2 0 0 1 3.172 4zm.5 2a.5.5 0 1 1 0-1 .5.5 0 0 1 0 1m9 2.5a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0",
  ] },
  // Bootstrap Icons' send-fill
  send: { box: 16, paths: [
    "M15.964.686a.5.5 0 0 0-.65-.65L.767 5.855H.766l-.452.18a.5.5 0 0 0-.082.887l.41.26.001.002 4.995 3.178 3.178 4.995.002.002.26.41a.5.5 0 0 0 .886-.083zm-1.833 1.89L6.637 10.07l-.215-.338a.5.5 0 0 0-.154-.154l-.338-.215 7.494-7.494 1.178-.471z",
  ] },
  // the rail's own icons (assets/icons), 12×12
  tablet: { box: 12, paths: [
    "M9 0.75C9.19891 0.75 9.38968 0.829018 9.53033 0.96967C9.67098 1.11032 9.75 1.30109 9.75 1.5V10.5C9.75 10.6989 9.67098 10.8897 9.53033 11.0303C9.38968 11.171 9.19891 11.25 9 11.25H3C2.80109 11.25 2.61032 11.171 2.46967 11.0303C2.32902 10.8897 2.25 10.6989 2.25 10.5V1.5C2.25 1.30109 2.32902 1.11032 2.46967 0.96967C2.61032 0.829018 2.80109 0.75 3 0.75H9ZM3 0C2.60218 0 2.22064 0.158035 1.93934 0.43934C1.65804 0.720644 1.5 1.10218 1.5 1.5V10.5C1.5 10.8978 1.65804 11.2794 1.93934 11.5607C2.22064 11.842 2.60218 12 3 12H9C9.39782 12 9.77936 11.842 10.0607 11.5607C10.342 11.2794 10.5 10.8978 10.5 10.5V1.5C10.5 1.10218 10.342 0.720644 10.0607 0.43934C9.77936 0.158035 9.39782 0 9 0L3 0Z",
    "M6 10.5C6.19891 10.5 6.38968 10.421 6.53033 10.2803C6.67098 10.1397 6.75 9.94891 6.75 9.75C6.75 9.55109 6.67098 9.36032 6.53033 9.21967C6.38968 9.07902 6.19891 9 6 9C5.80109 9 5.61032 9.07902 5.46967 9.21967C5.32902 9.36032 5.25 9.55109 5.25 9.75C5.25 9.94891 5.32902 10.1397 5.46967 10.2803C5.61032 10.421 5.80109 10.5 6 10.5Z",
  ] },
  panel: { box: 12, paths: [
    "M10.875 2.25C10.9745 2.25 11.0698 2.28951 11.1402 2.35984C11.2105 2.43016 11.25 2.52554 11.25 2.625V9.375C11.25 9.47446 11.2105 9.56984 11.1402 9.64017C11.0698 9.71049 10.9745 9.75 10.875 9.75H1.125C1.02554 9.75 0.930161 9.71049 0.859835 9.64017C0.789509 9.56984 0.75 9.47446 0.75 9.375V2.625C0.75 2.52554 0.789509 2.43016 0.859835 2.35984C0.930161 2.28951 1.02554 2.25 1.125 2.25H10.875ZM1.125 1.5C0.826631 1.5 0.540483 1.61853 0.329505 1.8295C0.118526 2.04048 0 2.32663 0 2.625L0 9.375C0 9.67337 0.118526 9.95952 0.329505 10.1705C0.540483 10.3815 0.826631 10.5 1.125 10.5H10.875C11.1734 10.5 11.4595 10.3815 11.6705 10.1705C11.8815 9.95952 12 9.67337 12 9.375V2.625C12 2.32663 11.8815 2.04048 11.6705 1.8295C11.4595 1.61853 11.1734 1.5 10.875 1.5H1.125Z",
    "M2.25 4.125C2.25 4.02554 2.28951 3.93016 2.35984 3.85984C2.43016 3.78951 2.52554 3.75 2.625 3.75H9.375C9.47446 3.75 9.56984 3.78951 9.64017 3.85984C9.71049 3.93016 9.75 4.02554 9.75 4.125C9.75 4.22446 9.71049 4.31984 9.64017 4.39016C9.56984 4.46049 9.47446 4.5 9.375 4.5H2.625C2.52554 4.5 2.43016 4.46049 2.35984 4.39016C2.28951 4.31984 2.25 4.22446 2.25 4.125ZM2.25 6C2.25 5.90054 2.28951 5.80516 2.35984 5.73484C2.43016 5.66451 2.52554 5.625 2.625 5.625H9.375C9.47446 5.625 9.56984 5.66451 9.64017 5.73484C9.71049 5.80516 9.75 5.90054 9.75 6C9.75 6.09946 9.71049 6.19484 9.64017 6.26517C9.56984 6.33549 9.47446 6.375 9.375 6.375H2.625C2.52554 6.375 2.43016 6.33549 2.35984 6.26517C2.28951 6.19484 2.25 6.09946 2.25 6ZM2.25 7.875C2.25 7.77554 2.28951 7.68016 2.35984 7.60983C2.43016 7.53951 2.52554 7.5 2.625 7.5H7.125C7.22446 7.5 7.31984 7.53951 7.39017 7.60983C7.46049 7.68016 7.5 7.77554 7.5 7.875C7.5 7.97446 7.46049 8.06984 7.39017 8.14017C7.31984 8.21049 7.22446 8.25 7.125 8.25H2.625C2.52554 8.25 2.43016 8.21049 2.35984 8.14017C2.28951 8.06984 2.25 7.97446 2.25 7.875Z",
  ] },
  pen: { box: 12, paths: [
    "M9.10955 0.109277C9.14438 0.0743541 9.18576 0.046647 9.23132 0.0277422C9.27688 0.00883732 9.32572 -0.000893784 9.37505 -0.000893784C9.42437 -0.000893784 9.47321 0.00883732 9.51877 0.0277422C9.56433 0.046647 9.60571 0.0743541 9.64055 0.109277L11.8905 2.35928C11.9255 2.39411 11.9532 2.43549 11.9721 2.48105C11.991 2.52661 12.0007 2.57545 12.0007 2.62478C12.0007 2.6741 11.991 2.72294 11.9721 2.7685C11.9532 2.81406 11.9255 2.85544 11.8905 2.89028L4.39055 10.3903C4.35456 10.426 4.3117 10.4541 4.26455 10.4728L0.514548 11.9728C0.446401 12.0001 0.371745 12.0067 0.299838 11.992C0.227931 11.9772 0.161934 11.9417 0.110029 11.8898C0.0581242 11.8379 0.022594 11.7719 0.00784344 11.7C-0.00690715 11.6281 -0.000229523 11.5534 0.0270485 11.4853L1.52705 7.73528C1.54574 7.68813 1.57381 7.64527 1.60955 7.60928L9.10955 0.109277ZM8.4053 1.87478L10.125 3.59453L11.0948 2.62478L9.37505 0.905027L8.4053 1.87478ZM9.5948 4.12478L7.87505 2.40503L3.00005 7.28003V7.49978H3.37505C3.4745 7.49978 3.56989 7.53928 3.64021 7.60961C3.71054 7.67994 3.75005 7.77532 3.75005 7.87478V8.24978H4.12505C4.2245 8.24978 4.31989 8.28928 4.39021 8.35961C4.46054 8.42994 4.50005 8.52532 4.50005 8.62478V8.99978H4.7198L9.5948 4.12478ZM2.27405 8.00603L2.19455 8.08553L1.04855 10.9513L3.9143 9.80528L3.9938 9.72578C3.92226 9.69905 3.86059 9.65112 3.81703 9.58839C3.77348 9.52567 3.75011 9.45114 3.75005 9.37478V8.99978H3.37505C3.27559 8.99978 3.18021 8.96027 3.10988 8.88994C3.03956 8.81962 3.00005 8.72423 3.00005 8.62478V8.24978H2.62505C2.54868 8.24972 2.47416 8.22635 2.41143 8.18279C2.34871 8.13923 2.30078 8.07756 2.27405 8.00603Z",
  ] },
};

/** Tablet, Panel and Pen mode, as they stand. */
export function useStackToggles(): StackButton[] {
  const paired = useStore((s) => s.lan.paired);
  const panel = useStore((s) => s.inspectorOpen);
  const pen = useStore((s) => s.penMode);
  return [
    { id: "tablet", label: paired > 0 ? `Tablet · ${paired}` : "Tablet", icon: STACK_ICON.tablet, on: paired > 0, title: "review on a tablet: show a pairing QR code" },
    { id: "panel", label: "Panel", icon: STACK_ICON.panel, on: panel, title: "the notes and files panel (tab)" },
    { id: "pen", label: "Pen mode", icon: STACK_ICON.pen, on: pen, title: "pen mode: pen draws, touch pans (turns on with the first pen stroke)" },
  ];
}

/** A press on one of the toggles. */
export function pressToggle(id: string) {
  const st = useStore.getState();
  if (id === "tablet") st.set({ lanOpen: true });
  else if (id === "panel") st.set({ inspectorOpen: !st.inspectorOpen });
  else if (id === "pen") st.set({ penMode: !st.penMode });
}

/** Review's main button: Send, saying what goes. */
export function useSendButton(): StackButton {
  const round = useStore((s) => s.round);
  const capturing = useStore((s) => s.captureState.running || !!s.externalCapture);
  const notes = useStore((s) => noteCount(s.annotations));
  const status = round?.status.status;
  const ro = isReadOnly();
  const label = status === "sent" ? "Sent to agent" : status === "applied" ? "Applied" : notes ? `Send ${notes} note${notes === 1 ? "" : "s"}` : "Send to agent";
  return {
    id: "send",
    label,
    icon: STACK_ICON.send,
    disabled: !round || ro || status === "capturing" || capturing || !notes,
    title: ro ? "" : notes ? "send this round's notes to your agent (⌘⏎)" : "add notes to the screens, then send them to your agent",
  };
}

export function captureButton(enabled: boolean, busy: boolean): StackButton {
  return { id: "capture", label: "Capture view", icon: STACK_ICON.camera, disabled: !enabled || busy, busy, title: "screenshot the app exactly as it is now" };
}

const Icon = ({ icon, size }: { icon: StackIcon; size: number }) => (
  <svg width={size} height={size} viewBox={`0 0 ${icon.box} ${icon.box}`} fill="currentColor" aria-hidden="true">
    {icon.paths.map((d) => (
      <path key={d} d={d} />
    ))}
  </svg>
);

/** The stack, in the canvas: over its parent's bottom-right corner. */
export function FloatStack({ main, onMain, className = "" }: { main?: StackButton; onMain?: () => void; className?: string }) {
  const toggles = useStackToggles();
  return (
    <div className={`float-stack ${className}`}>
      {toggles.map((t) => (
        <button key={t.id} className={`fab small ${t.on ? "on" : ""}`} onClick={() => pressToggle(t.id)} title={t.title} aria-pressed={t.on}>
          <Icon icon={t.icon} size={18} />
          <span>{t.label}</span>
        </button>
      ))}
      {main && (
        <button className="fab main" onClick={onMain} disabled={main.disabled} title={main.title || undefined}>
          {main.busy ? <Spinner /> : <Icon icon={main.icon} size={24} />}
          <span>{main.label}</span>
        </button>
      )}
    </div>
  );
}
