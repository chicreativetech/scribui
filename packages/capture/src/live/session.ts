import type { Device, RawElement } from "@scribui/core";

/**
 * A device shown live in the desktop app: what it can do and how to talk to it.
 * Each platform (Android now, the iOS Simulator next) implements `LiveTarget`;
 * the device view only reads `capabilities`, so it shows Home, Back, Rotate or
 * text input when the session has them.
 */

export type Capabilities = {
  /** "webcontents": the web app's own view, no stream. */
  video: "webcontents" | "h264" | "mjpeg";
  pointer: boolean;
  /** Wheel / trackpad scrolling. */
  scroll: boolean;
  text: boolean;
  /**
   * Typing goes in as the computer's physical keys (`physical` input), which
   * the device turns into characters with its own keyboard layout (the iOS
   * Simulator, like Simulator.app). Otherwise typed characters go in as text.
   */
  physicalKeys: boolean;
  keys: LiveKey[];
  rotate: boolean;
  orientation: "portrait" | "landscape" | "auto";
};

export type LiveKey = "home" | "back" | "recents" | "lock";

/** Keys typed on the computer's keyboard that aren't text. */
export type EditKey = "enter" | "backspace" | "delete" | "tab" | "escape" | "up" | "down" | "left" | "right" | "home" | "end";

export type DeviceInfo = {
  id: string;
  name: string;
  kind: "emulator" | "phone" | "simulator";
  /** "ready": can be shown; the others say why not. */
  state: "ready" | "offline" | "unauthorized" | "booting";
};

export type Rotation = 0 | 90 | 180 | 270;

/**
 * The device's screen as it is now, in device pixels (rotation applied).
 * `videoRotation`: the stream stays in the device's natural orientation (the
 * iOS Simulator's framebuffer is always portrait); turn it clockwise by this
 * much to show it upright. Absent or 0 when the video already follows.
 */
export type LiveSize = { width: number; height: number; scale: number; rotation: Rotation; videoRotation?: Rotation };

/** A point on the shown screen, 0–1 from its top-left corner. */
export type ViewPoint = { x: number; y: number };

export type LiveInput =
  | { type: "pointer"; action: "down" | "move" | "up"; x: number; y: number }
  | { type: "scroll"; x: number; y: number; dx: number; dy: number }
  | { type: "key"; key: LiveKey }
  | { type: "edit"; key: EditKey }
  | { type: "text"; text: string }
  /** A key as pressed on the computer: `code` is KeyboardEvent.code; `text` what it typed there (a fallback; empty for a dead key). */
  | { type: "physical"; code: string; shift: boolean; alt: boolean; text: string }
  | { type: "rotate" };

export type LiveCaptureStep = "screenshot" | "elements" | "verifying" | "retrying";
export type CaptureProgress = { step: LiveCaptureStep; attempt: number };

export type LiveCapture = {
  png: Uint8Array;
  raw: RawElement;
  device: Device;
  orientation: "portrait" | "landscape";
  /** Both screenshots agreed: the element tree belongs to `png`. */
  settled: boolean;
  /** The elements could be read; false for a screen that never stops changing (the tree is just the screen). */
  elements: boolean;
  attempts: number;
  /** The frame on screen when Capture was pressed (equals `png` when settled on the first try). */
  firstPng: Uint8Array;
  /** The last screenshot: what the screen had changed to when it didn't settle. */
  lastPng: Uint8Array;
};

/** A video packet for the decoder in the canvas. */
export type LiveFrame = { config: boolean; key: boolean; pts: bigint; data: Uint8Array; codec?: string };

export type LiveEvents = {
  frame: LiveFrame;
  resize: LiveSize;
  /** The stream stopped; the session tries to come back on its own. */
  disconnect: { reason: string };
  /** Streaming again after a disconnect. */
  reconnect: LiveSize;
  /** Gave up: the device is gone. */
  error: { message: string };
};

export interface LiveSession {
  readonly deviceId: string;
  readonly name: string;
  readonly capabilities: Capabilities;
  readonly size: LiveSize;
  on<E extends keyof LiveEvents>(event: E, cb: (e: LiveEvents[E]) => void): () => void;
  /** A point on the shown screen → device pixels, for the current rotation. */
  toDevice(p: ViewPoint): { x: number; y: number };
  input(ev: LiveInput): Promise<void>;
  /** A fresh key frame (after a decoder error in the canvas). */
  resetVideo(): void;
  capture(signal: AbortSignal, progress: (p: CaptureProgress) => void): Promise<LiveCapture>;
  /** A name for a captured view from what's in front (the app, the screen), when the platform says. */
  foregroundTitle?(): Promise<string | null>;
  dispose(): Promise<void>;
}

export interface LiveTarget {
  list(): Promise<DeviceInfo[]>;
  connect(deviceId: string, signal?: AbortSignal): Promise<LiveSession>;
}

/** Shown-screen point → pixels of a `width`×`height` image, clamped to it. */
export function scalePoint(p: ViewPoint, width: number, height: number): { x: number; y: number } {
  const c = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
  return { x: Math.min(width - 1, c(p.x) * width), y: Math.min(height - 1, c(p.y) * height) };
}
