import type { Platform, ScreenCapture, ScreenEntry, ScreenManifest } from "@scribui/core";

export type CaptureContext = {
  /** Absolute path of the `.scribui/` folder. */
  reviewDir: string;
  /** Absolute path of the round folder being captured. */
  roundDir: string;
  manifest: ScreenManifest;
  /** Device name or udid / serial requested with `--device`. */
  device?: string;
  log?: (msg: string) => void;
};

export interface CaptureAdapter {
  platform: Platform;
  /** Tools installed, device booted. */
  check(): Promise<{ ok: boolean; problems: string[] }>;
  /** Run the flow / navigate / setup for one screen. */
  prepare(screen: ScreenEntry): Promise<void>;
  /** Screenshot plus normalized tree. Writes `screens/<id>.png`. */
  capture(screen: ScreenEntry): Promise<ScreenCapture>;
  /** Release browsers, sessions, temp files. */
  dispose?(): Promise<void>;
}
