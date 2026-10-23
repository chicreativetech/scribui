import { isReadOnly, noteCount, useStore } from "../store";
import { useVision } from "../vision";
import { openImport } from "./Import";
import { Spinner } from "./Capture";

/**
 * The dock at the bottom centre: Select, Comment and Add screen (icons; their
 * names show on hover), then the tab's main button (Capture view in Capture
 * Screens, Send in Review; none on the vision board). In the desktop app's Capture Screens
 * tab the app's own view covers the canvas, so the desktop draws the stack in
 * a view of its own (floatStack.ts) from these same buttons, as data: labels,
 * icon paths and states, never markup.
 */

export type StackIcon = { box: number; paths: string[] };
export type StackButton = { id: string; label: string; icon: StackIcon; title: string; on?: boolean; disabled?: boolean; busy?: boolean };
/** The latest toast, shown beside the desktop's stack; its buttons press "toast-action" and "toast-close". */
export type StackToast = { id: number; text: string; tone: "ok" | "warn" | "err" | "info"; action: string | null };

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
  // a pointer, like the rail's select
  select: { box: 16, paths: ["M3 1.2v12.4l3.4-3.2 2.3 4.6 2.2-1-2.3-4.5 4.7-.2z"] },
  // Bootstrap Icons' chat-fill
  comment: { box: 16, paths: [
    "M8 15c4.418 0 8-3.134 8-7s-3.582-7-8-7-8 3.134-8 7c0 1.76.743 3.37 1.97 4.6-.097 1.016-.417 2.13-.771 2.966-.079.186.074.394.273.362 2.256-.37 3.597-.938 4.18-1.234A9 9 0 0 0 8 15",
  ] },
  // the rail's pen (assets/icons/pen.svg), 12×12
  pen: { box: 12, paths: [
    "M9.10955 0.109277C9.14438 0.0743541 9.18576 0.046647 9.23132 0.0277422C9.27688 0.00883732 9.32572 -0.000893784 9.37505 -0.000893784C9.42437 -0.000893784 9.47321 0.00883732 9.51877 0.0277422C9.56433 0.046647 9.60571 0.0743541 9.64055 0.109277L11.8905 2.35928C11.9255 2.39411 11.9532 2.43549 11.9721 2.48105C11.991 2.52661 12.0007 2.57545 12.0007 2.62478C12.0007 2.6741 11.991 2.72294 11.9721 2.7685C11.9532 2.81406 11.9255 2.85544 11.8905 2.89028L4.39055 10.3903C4.35456 10.426 4.3117 10.4541 4.26455 10.4728L0.514548 11.9728C0.446401 12.0001 0.371745 12.0067 0.299838 11.992C0.227931 11.9772 0.161934 11.9417 0.110029 11.8898C0.0581242 11.8379 0.022594 11.7719 0.00784344 11.7C-0.00690715 11.6281 -0.000229523 11.5534 0.0270485 11.4853L1.52705 7.73528C1.54574 7.68813 1.57381 7.64527 1.60955 7.60928L9.10955 0.109277ZM8.4053 1.87478L10.125 3.59453L11.0948 2.62478L9.37505 0.905027L8.4053 1.87478ZM9.5948 4.12478L7.87505 2.40503L3.00005 7.28003V7.49978H3.37505C3.4745 7.49978 3.56989 7.53928 3.64021 7.60961C3.71054 7.67994 3.75005 7.77532 3.75005 7.87478V8.24978H4.12505C4.2245 8.24978 4.31989 8.28928 4.39021 8.35961C4.46054 8.42994 4.50005 8.52532 4.50005 8.62478V8.99978H4.7198L9.5948 4.12478ZM2.27405 8.00603L2.19455 8.08553L1.04855 10.9513L3.9143 9.80528L3.9938 9.72578C3.92226 9.69905 3.86059 9.65112 3.81703 9.58839C3.77348 9.52567 3.75011 9.45114 3.75005 9.37478V8.99978H3.37505C3.27559 8.99978 3.18021 8.96027 3.10988 8.88994C3.03956 8.81962 3.00005 8.72423 3.00005 8.62478V8.24978H2.62505C2.54868 8.24972 2.47416 8.22635 2.41143 8.18279C2.34871 8.13923 2.30078 8.07756 2.27405 8.00603Z",
  ] },
  // Bootstrap Icons' image
  image: { box: 16, paths: [
    "M6.002 5.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0",
    "M2.002 1a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V3a2 2 0 0 0-2-2zm12 1a1 1 0 0 1 1 1v6.5l-3.777-1.947a.5.5 0 0 0-.577.093l-3.71 3.71-2.66-1.772a.5.5 0 0 0-.63.062L1.002 12V3a1 1 0 0 1 1-1z",
  ] },
};

/** The dock's tools: Select, Comment and Add screen (on the vision board, Select, Draw and Image), as they stand. */
export function useDockTools(): StackButton[] {
  const tool = useStore((s) => s.tool);
  const vision = useStore((s) => s.view === "vision");
  const ro = isReadOnly() && !vision;
  const select: StackButton = { id: "select", label: "Select", icon: STACK_ICON.select, on: tool === "select", title: "select (V)" };
  if (vision)
    return [
      select,
      { id: "freehand", label: "Draw", icon: STACK_ICON.pen, on: tool === "freehand", title: "draw freely; outside a canvas it starts a new one (P)" },
      { id: "image", label: "Image", icon: STACK_ICON.image, title: "import an image to move, resize and rotate (M)" },
    ];
  return [
    select,
    { id: "comment", label: "Comment", icon: STACK_ICON.comment, on: tool === "comment", disabled: ro, title: "comment (C)" },
    { id: "add", label: "Add screen", icon: STACK_ICON.image, title: "add a screen: a screenshot, HTML or a link (M)" },
  ];
}

/** A press on one of the dock's tools. */
export function pressDockTool(id: string) {
  const st = useStore.getState();
  if (id === "select" || id === "comment" || id === "freehand") st.setTool(id);
  else if (id === "add") openImport();
  else if (id === "image") useVision.getState().set({ importOpen: true });
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

/** The dock, in the canvas: a pill at the bottom centre of its parent. */
export function FloatStack({ main, onMain, className = "" }: { main?: StackButton; onMain?: () => void; className?: string }) {
  const toggles = useDockTools();
  return (
    <div className={`dock ${className}`}>
      {/* 74px a tool, their borders overlapping */}
      <div className="dock-toggles" style={{ width: toggles.length * 73 + 1 }}>
        {toggles.map((t) => (
          <button
            key={t.id}
            className={`dock-toggle ${t.on ? "on" : ""}`}
            onClick={() => pressDockTool(t.id)}
            disabled={t.disabled}
            title={t.title}
            aria-label={t.label}
            aria-pressed={t.on}
          >
            <Icon icon={t.icon} size={18} />
            <span className="dock-label">{t.label}</span>
          </button>
        ))}
      </div>
      {main && (
        <button className="dock-main" onClick={onMain} disabled={main.disabled} title={main.title || undefined}>
          {main.busy ? <Spinner /> : <Icon icon={main.icon} size={14} />}
          <span>{main.label}</span>
        </button>
      )}
    </div>
  );
}
