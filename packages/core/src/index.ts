export * from "./schemas.js";
export * from "./config.js";
export * from "./geometry.js";
export * from "./tree.js";
export * from "./resolver.js";
export * from "./numbering.js";
export * from "./compiler.js";
export * from "./render.js";
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
