/**
 * What each kind of note is called and asks for, named after what it tells
 * the agent (core's compiler.ts): the rail's tool names (store.ts TOOLS), and
 * the note boxes' heads and placeholders in Review (Overlay.tsx) and on the
 * app (markSurface.ts, which the desktop's mark layer loads, so no imports).
 */

export const KIND_NAME: Record<string, string> = {
  comment: "Comment",
  arrow: "Move",
  circle: "Change area",
  rectangle: "Add here",
  remove: "Remove",
  rule: "Global rule",
  freehand: "Drawing",
  sketch: "Sketch",
};

/** A note's name, a sketch's by its shape. */
export function kindName(kind: string, shape?: string): string {
  if (kind === "sketch" && shape && shape !== "drawing") return `${shape[0]!.toUpperCase()}${shape.slice(1)} sketch`;
  return KIND_NAME[kind] ?? kind;
}

/** What a note's words should say, as its box's placeholder. */
export function notePrompt(kind: string, shape?: string): string {
  switch (kind) {
    case "comment":
      return "What should change?";
    case "arrow":
      return "Why move it? (optional)";
    case "circle":
      return "What should change in this area?";
    case "rectangle":
      return "What should go here?";
    case "remove":
      return "Why remove it? (optional)";
    case "rule":
      return "e.g. Primary buttons are full width, 48pt tall";
    case "freehand":
      return "What does this drawing mean?";
    case "sketch":
      if (shape === "text") return "Text to add here";
      if (shape === "drawing") return "What is this sketch: something new, or a change to what's under it?";
      return "What is this sketch?";
    default:
      return "What should change?";
  }
}
