import type { LiveInput } from "@scribui/capture";

/**
 * Pure helpers for the device tab (no Electron here, so they can be tested):
 * checking what the canvas sends, and naming a captured view.
 */

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const LIVE_KEYS = new Set(["home", "back", "recents", "lock"]);
const EDIT_KEYS = new Set(["enter", "backspace", "delete", "tab", "escape", "up", "down", "left", "right", "home", "end"]);
const ACTIONS = new Set(["down", "move", "up"]);
const unit = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null);

/** The canvas's input, checked field by field: nothing else reaches the device. */
export function liveInput(v: unknown): LiveInput | null {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return null;
  const x = unit(o.x), y = unit(o.y);
  switch (o.type) {
    case "pointer":
      return x !== null && y !== null && ACTIONS.has(o.action as string) ? { type: "pointer", action: o.action as "down", x, y } : null;
    case "scroll": {
      const dx = num(o.dx), dy = num(o.dy);
      return x !== null && y !== null && dx !== null && dy !== null ? { type: "scroll", x, y, dx: Math.max(-16, Math.min(16, dx)), dy: Math.max(-16, Math.min(16, dy)) } : null;
    }
    case "key":
      return LIVE_KEYS.has(o.key as string) ? { type: "key", key: o.key as "home" } : null;
    case "edit":
      return EDIT_KEYS.has(o.key as string) ? { type: "edit", key: o.key as "enter" } : null;
    case "text":
      return typeof o.text === "string" && o.text.length > 0 && o.text.length <= 2000 ? { type: "text", text: o.text } : null;
    case "rotate":
      return { type: "rotate" };
  }
  return null;
}

/** The resumed activity's class as words: `topResumedActivity=ActivityRecord{… u0 pkg/.ui.SearchActivity t9}` → "Search". */
export function activityTitle(dumpsys: string): string | null {
  const m = /(?:topResumedActivity|mResumedActivity|ResumedActivity)[:=]\s*ActivityRecord\{[^}]*?\s([\w.]+)\/([\w.$]+)/.exec(dumpsys);
  if (!m) return null;
  const cls = m[2]!.split(/[.$]/).pop() ?? "";
  const words = cls
    .replace(/Activity$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .trim();
  return words && words !== "Main" ? words : null;
}
