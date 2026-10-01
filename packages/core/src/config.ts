/**
 * Every tunable threshold for the resolver and pen gesture recognition lives
 * here, so they can be tuned against fixtures in one place.
 */
export const DEFAULT_CONFIG = {
  /** Circle / rectangle: minimum share of an element's area inside the shape. */
  coverage: 0.6,
  /** Circle: a container wins when its candidate children cover this share of it. */
  containerFill: 0.7,
  /** Comment pins this close to another annotation's geometry attach to it. */
  attachDistance: 24,
  /** Handwriting this close to a circle, arrow or remove becomes its comment. */
  inkAttachDistance: 48,
  /** Elements larger than this share of the screen are ignored unless nothing else fits. */
  hugeElement: 0.9,
  /** Open freehand: the smallest element holding this share of the path wins. */
  freehandContainment: 0.8,
  /** A path is closed when its end is within this share of its bbox diagonal to its start. */
  closedLoop: 0.15,

  /* pen gestures */
  /** Arrow head strokes must follow the shaft within this many ms. */
  arrowHeadWindowMs: 400,
  /** Minimum straightness (chord / path length) of an arrow shaft. */
  arrowStraightness: 0.9,
  /** Handwriting: strokes within this many ms of each other group together. */
  handwritingWindowMs: 1500,
  /** Handwriting: strokes within this many px of the group bbox join it. */
  handwritingDistance: 40,
  /** Handwriting: strokes shorter than this (bbox diagonal) count as "short". */
  handwritingStrokeMax: 90,
  /** Remove: minimum direction reversals for a zig-zag scratch-out. */
  zigzagReversals: 4,
  /** Ink crops are padded by this many px. */
  inkPadding: 16,
} as const;

export type ResolverConfig = { -readonly [K in keyof typeof DEFAULT_CONFIG]: number };
