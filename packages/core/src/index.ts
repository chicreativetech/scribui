export * from "./schemas.js";
export * from "./config.js";
export * from "./geometry.js";
export * from "./tree.js";
export * from "./resolver.js";
export * from "./numbering.js";
export * from "./compiler.js";
export * from "./render.js";
export * from "./vision.js";
export * from "./gestures.js";
export * from "./agents.js";
export * from "./capturePlan.js";
export * from "./templates.js";

/** Short random ids for annotations: `a` + 6 base36 chars. */
export function newAnnotationId(): string {
  return "a" + Math.random().toString(36).slice(2, 8).padEnd(6, "0");
}

export const PRODUCT = {
  name: "scribui",
  folder: ".scribui",
  defaultPort: 4382,
} as const;

/** The desktop app's link scheme: `scribui://open?dir=<absolute path>` opens a project in it, `scribui://new?dir=…` starts a new project there. */
export const DESKTOP_PROTOCOL = "scribui";
export const desktopOpenUrl = (dir: string) => `${DESKTOP_PROTOCOL}://open?dir=${encodeURIComponent(dir)}`;
/** `ack`: the app confirms it took the link by creating `~/.scribui/handoff/<ack>` (an older app ignores the link). */
export const desktopNewUrl = (dir: string, ack?: string) => `${DESKTOP_PROTOCOL}://new?dir=${encodeURIComponent(dir)}${ack ? `&ack=${ack}` : ""}`;
export const HANDOFF_DIR = "handoff";
export const validAck = (v: unknown): v is string => typeof v === "string" && /^[a-z0-9]{8,64}$/.test(v);
export * from "./fill.js";
