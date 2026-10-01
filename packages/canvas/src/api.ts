import type { Annotation, Device, ScreenCapture, ScreenManifest, StatusFile } from "@intentcue/core";

export type ScreenInfo = {
  id: string;
  title: string;
  group: string;
  captured: boolean;
  error?: string;
  /** Not recaptured in this round: copied from this round. */
  reusedFrom?: number;
  /** Why it was captured or reused. */
  reason?: string;
  platform?: "ios" | "android" | "web";
  device?: Device;
  size?: { width: number; height: number };
  screenshot?: string;
};

export type RoundPayload = {
  round: number;
  status: StatusFile;
  app?: ScreenManifest["app"];
  screens: ScreenInfo[];
  annotations: Annotation[];
  /** The server can recapture screens (started by the CLI). */
  canRecapture?: boolean;
};

export type CaptureState = {
  running: boolean;
  phase: "idle" | "building" | "capturing" | "done" | "failed";
  trigger?: "gui" | "agent-applied";
  round?: number;
  total?: number;
  done?: number;
  current?: string;
  queue?: string[];
  log?: string[];
  error?: string;
  summary?: string;
};

export type LanState = { enabled: boolean; paired: number; url?: string | null; expiresAt?: number; qr?: string };

export type ProjectPayload = {
  folder: string;
  root: string;
  manifest: ScreenManifest | { error: string };
  rounds: number[];
  latest: number | null;
  lan: LanState;
  canCapture: boolean;
  autoRecapture: boolean;
  capture: CaptureState;
};

export type RoundListItem = { round: number; status: string; createdAt?: string; annotations: number };

export const CLIENT_ID = Math.random().toString(36).slice(2);

async function json<T>(r: Response): Promise<T> {
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try {
      const body = (await r.json()) as { error?: string };
      if (body.error) msg = body.error;
    } catch {
      /* not json */
    }
    throw new Error(msg);
  }
  return r.json() as Promise<T>;
}

export const api = {
  project: () => fetch("/api/project").then((r) => json<ProjectPayload>(r)),
  rounds: () => fetch("/api/rounds").then((r) => json<RoundListItem[]>(r)),
  round: (n: number) => fetch(`/api/rounds/${n}`).then((r) => json<RoundPayload>(r)),
  screen: (n: number, id: string) =>
    fetch(`/api/rounds/${n}/screens/${encodeURIComponent(id)}`).then((r) => json<ScreenCapture>(r)),
  saveAnnotations: (n: number, annotations: Annotation[]) =>
    fetch(`/api/rounds/${n}/annotations`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-client-id": CLIENT_ID },
      body: JSON.stringify({ annotations }),
    }).then((r) => json<{ ok: true }>(r)),
  send: (n: number) =>
    fetch(`/api/rounds/${n}/send`, { method: "POST" }).then((r) =>
      json<{ round: number; prompt: string; counts: { instructions: number; unresolved: number; needsText: number; rules: number } }>(r),
    ),
  recapture: (n: number, screens: string[]) =>
    fetch(`/api/rounds/${n}/recapture`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ screens }),
    }).then((r) => json<CaptureState>(r)),
  capture: (body: { screens?: string[]; all?: boolean; build?: boolean } = {}) =>
    fetch("/api/capture", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) =>
      json<CaptureState>(r),
    ),
  lan: () => fetch("/api/lan").then((r) => json<LanState>(r)),
  startLan: () => fetch("/api/lan", { method: "POST" }).then((r) => json<LanState>(r)),
  review: (n: number) => fetch(`/api/rounds/${n}/review`).then((r) => (r.ok ? r.text() : null)),
  rules: () => fetch("/api/rules").then((r) => r.text()),
};

export type ServerEvent =
  | { type: "hello" }
  | { type: "round-created"; round: number }
  | {
      type: "capture-progress";
      round: number;
      screens: { screenId: string; ok: boolean; error?: string }[];
      status: string;
      progress?: { total: number; done: number; current?: string; queue: string[] };
    }
  | { type: "capture-state"; state: CaptureState }
  | { type: "lan-changed"; enabled: boolean; paired: number }
  | { type: "status-changed"; round: number; status: string }
  | { type: "annotations-changed"; round: number; by: string };

/** WebSocket with automatic reconnect. */
export function connectEvents(onEvent: (e: ServerEvent) => void, onState: (connected: boolean) => void) {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 500;
  const open = () => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      retry = 500;
      onState(true);
    };
    ws.onmessage = (m) => {
      try {
        onEvent(JSON.parse(String(m.data)) as ServerEvent);
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      onState(false);
      if (!closed) setTimeout(open, (retry = Math.min(retry * 2, 8000)));
    };
  };
  open();
  return () => {
    closed = true;
    ws?.close();
  };
}
