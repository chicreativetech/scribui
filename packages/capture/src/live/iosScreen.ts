import type { DeviceInfo, Rotation, ViewPoint } from "./session.js";

/**
 * Pure helpers for the iOS Simulator's live view: which simulators there are,
 * and the geometry of a screen whose framebuffer never turns.
 *
 * The Simulator's framebuffer (the stream and `simctl io screenshot`) is
 * always portrait; a turned UI is drawn into it sideways. Its HID takes
 * touches in portrait points too. The accessibility tree, though, is in the
 * UI's own (turned) points. So what's shown and captured is turned upright
 * here, and touches are turned back.
 */

/** The device's orientation (UIDeviceOrientation, as the Simulator's HID sets it). */
export type SimOrientation = "portrait" | "landscapeLeft" | "landscapeRight" | "portraitUpsideDown";

/** Clockwise turn that shows the portrait framebuffer upright for each orientation (measured on iOS 26.3). */
export function turnFor(o: SimOrientation): Rotation {
  return o === "landscapeLeft" ? 90 : o === "landscapeRight" ? 270 : o === "portraitUpsideDown" ? 180 : 0;
}

/**
 * A point on the upright screen (0–1) → the HID's portrait points.
 * `portrait`: the screen's size in points, held upright.
 */
export function toPortraitPoints(p: ViewPoint, o: SimOrientation, portrait: { width: number; height: number }): { x: number; y: number } {
  const c = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
  const { width: pw, height: ph } = portrait;
  const landscape = o === "landscapeLeft" || o === "landscapeRight";
  // the point in the UI's own points
  const x = c(p.x) * (landscape ? ph : pw);
  const y = c(p.y) * (landscape ? pw : ph);
  switch (o) {
    case "landscapeLeft":
      return { x: y, y: ph - x };
    case "landscapeRight":
      return { x: pw - y, y: x };
    case "portraitUpsideDown":
      return { x: pw - x, y: ph - y };
    default:
      return { x, y };
  }
}

/**
 * The UI's orientation from the frontmost app's frame. A landscape frame
 * doesn't say which way: keep the one the device was turned to, else assume
 * the usual one (a landscape-only app on an upright device).
 */
export function uiOrientation(frame: { width: number; height: number } | null, device: SimOrientation): SimOrientation {
  if (!frame || !frame.width || !frame.height) return device;
  const landscape = frame.width > frame.height;
  if (landscape) return device === "landscapeLeft" || device === "landscapeRight" ? device : "landscapeLeft";
  return device === "portraitUpsideDown" ? device : "portrait";
}

type SimctlDevice = { udid: string; name: string; state: string; isAvailable?: boolean; deviceTypeIdentifier?: string };

export type SimulatorEntry = { udid: string; name: string; state: string; runtime: string; deviceType: string | null };

/** `xcrun simctl list devices -j` → the iOS simulators that can be used (watch, TV and visionOS left out). */
export function parseSimctlDevices(json: string): SimulatorEntry[] {
  const data = JSON.parse(json) as { devices?: Record<string, SimctlDevice[]> };
  return Object.entries(data.devices ?? {})
    .filter(([runtime]) => /SimRuntime\.iOS-/.test(runtime))
    .flatMap(([runtime, list]) =>
      list
        .filter((d) => d.isAvailable !== false)
        .map((d) => ({
          udid: d.udid,
          name: d.name,
          state: d.state,
          runtime: runtime.replace(/^.*SimRuntime\.iOS-/, "iOS ").replace(/-/g, "."),
          deviceType: d.deviceTypeIdentifier ?? null,
        })),
    );
}

/** Booted (or booting) simulators as devices; shut-down ones as simulators that can be started, newest iOS first. */
export function simulatorDevices(sims: SimulatorEntry[]): { devices: DeviceInfo[]; startable: { id: string; name: string }[] } {
  const named = (s: SimulatorEntry) => {
    // the same model on two iOS versions: say which
    const twin = sims.some((o) => o !== s && o.name === s.name);
    return twin ? `${s.name} (${s.runtime})` : s.name;
  };
  const version = (s: SimulatorEntry) => s.runtime.replace(/^iOS /, "").split(".").map(Number);
  const newest = (a: SimulatorEntry, b: SimulatorEntry) => {
    const va = version(a), vb = version(b);
    for (let i = 0; i < Math.max(va.length, vb.length); i++) if ((vb[i] ?? 0) !== (va[i] ?? 0)) return (vb[i] ?? 0) - (va[i] ?? 0);
    return a.name.localeCompare(b.name);
  };
  const sorted = [...sims].sort(newest);
  return {
    devices: sorted
      .filter((s) => s.state === "Booted" || s.state === "Booting")
      .map((s) => ({ id: s.udid, name: named(s), kind: "simulator" as const, state: s.state === "Booted" ? ("ready" as const) : ("booting" as const) })),
    startable: sorted.filter((s) => s.state === "Shutdown").map((s) => ({ id: s.udid, name: named(s) })),
  };
}

/** A device type's `profile.plist` (as JSON from plutil): the screen in pixels and its scale. */
export function parseDeviceProfile(json: string): { width: number; height: number; scale: number } | null {
  const p = JSON.parse(json) as { mainScreenWidth?: number; mainScreenHeight?: number; mainScreenScale?: number };
  if (!p.mainScreenWidth || !p.mainScreenHeight || !p.mainScreenScale) return null;
  return {
    width: Math.min(p.mainScreenWidth, p.mainScreenHeight),
    height: Math.max(p.mainScreenWidth, p.mainScreenHeight),
    scale: p.mainScreenScale,
  };
}

/** HID usages (keyboard page) of the keys that aren't text. */
export const IOS_EDIT_KEYS = {
  enter: 40,
  escape: 41,
  backspace: 42,
  tab: 43,
  home: 74,
  delete: 76,
  end: 77,
  right: 79,
  left: 80,
  down: 81,
  up: 82,
} as const;

/**
 * KeyboardEvent.code → HID usage (keyboard page): physical keys, which the
 * simulator turns into characters with its own layout. The standard mapping
 * (Backquote = grave, IntlBackslash = the ISO <> key); macOS's own swap of
 * those two on ISO keyboards isn't undone.
 */
export const HID_USAGE: Record<string, number> = {
  ...Object.fromEntries([..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].map((c, i) => [`Key${c}`, 4 + i])),
  ...Object.fromEntries([..."123456789"].map((c, i) => [`Digit${c}`, 30 + i])),
  Digit0: 39,
  Space: 44,
  Minus: 45,
  Equal: 46,
  BracketLeft: 47,
  BracketRight: 48,
  Backslash: 49,
  Semicolon: 51,
  Quote: 52,
  Backquote: 53,
  Comma: 54,
  Period: 55,
  Slash: 56,
  IntlBackslash: 100,
};
