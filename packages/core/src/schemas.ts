import { z } from "zod";

/* ─────────────────────────── primitives ─────────────────────────── */

export const Rect = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});
export type Rect = z.infer<typeof Rect>;

export const Platform = z.enum(["ios", "android", "web"]);
export type Platform = z.infer<typeof Platform>;

export const SourceRef = z.object({
  file: z.string(),
  line: z.number().int().optional(),
  component: z.string().optional(),
});
export type SourceRef = z.infer<typeof SourceRef>;

/* ─────────────────────────── element tree ─────────────────────────── */

export const IdSource = z.enum(["accessibility", "testId", "dom", "generated"]);
export type IdSource = z.infer<typeof IdSource>;

/** Normalized element types. Adapters map native classes onto these. */
export const ELEMENT_TYPES = [
  "screen",
  "container",
  "button",
  "text",
  "image",
  "input",
  "toggle",
  "slider",
  "list",
  "cell",
  "link",
  "tab",
  "navbar",
  "tabbar",
  "toolbar",
  "icon",
  "other",
] as const;

export type UIElement = {
  id: string;
  idSource: IdSource;
  type: string;
  nativeType?: string;
  label?: string;
  bounds: Rect;
  visible: boolean;
  children: UIElement[];
  source?: SourceRef;
};

export const UIElement: z.ZodType<UIElement> = z.lazy(() =>
  z.object({
    id: z.string(),
    idSource: IdSource,
    type: z.string(),
    nativeType: z.string().optional(),
    label: z.string().optional(),
    bounds: Rect,
    visible: z.boolean(),
    children: z.array(UIElement),
    source: SourceRef.optional(),
  }),
);

export const Device = z.object({
  name: z.string(),
  width: z.number(),
  height: z.number(),
  scale: z.number(),
});
export type Device = z.infer<typeof Device>;

export const ScreenCapture = z.object({
  screenId: z.string(),
  platform: Platform,
  device: Device,
  screenshot: z.string(),
  root: UIElement,
  capturedAt: z.string(),
});
export type ScreenCapture = z.infer<typeof ScreenCapture>;

/* ─────────────────────────── screen manifest ─────────────────────────── */

export const Viewport = z.object({
  width: z.number(),
  height: z.number(),
  deviceScaleFactor: z.number().optional(),
  /** Web: capture the full scrollable page instead of the viewport. */
  fullPage: z.boolean().optional(),
});

export const ScreenEntry = z.object({
  id: z.string().regex(/^[a-zA-Z0-9._-]+$/, "screen ids may only use letters, digits, . _ -"),
  title: z.string(),
  group: z.string().optional(),
  /** Mobile: Maestro flow (or setup script) path, relative to the review folder. */
  flow: z.string().optional(),
  /** Web: URL to open. */
  url: z.string().optional(),
  viewport: Viewport.optional(),
  /** Web: setup script (ES module exporting default async (page) => {}). */
  setup: z.string().optional(),
  /**
   * Web: captured by hand from the canvas's app tab. Its state (login, open
   * menus, form input) can't be reproduced from the url, so automatic captures
   * carry it forward instead of recapturing it.
   */
  live: z.boolean().optional(),
  /**
   * Source globs that render this screen, relative to the project root, such as
   * "app/src/main/java/(double-star)/feature/shop/(double-star)". Used to recapture only screens whose code changed.
   */
  sources: z.array(z.string()).optional(),
});
export type ScreenEntry = z.infer<typeof ScreenEntry>;

export const ScreenManifest = z.object({
  version: z.literal(1),
  app: z.object({
    name: z.string(),
    platform: Platform,
    bundleId: z.string().optional(),
    baseUrl: z.string().optional(),
    /** Device / simulator / emulator to capture on when several are connected. */
    device: z.string().optional(),
    /** Mobile: command that rebuilds and installs the app (run from the project root), e.g. "./gradlew installDebug". */
    build: z.string().optional(),
    /** Source globs shared by every screen (theme, design system); a change there recaptures all screens. */
    sharedSources: z.array(z.string()).optional(),
  }),
  screens: z.array(ScreenEntry),
});
export type ScreenManifest = z.infer<typeof ScreenManifest>;

/* ─────────────────────────── annotations ─────────────────────────── */

export const AnnotationKind = z.enum([
  "comment",
  "circle",
  "arrow",
  "rectangle",
  "remove",
  "freehand",
  "rule",
  /** A drawn line, box, ellipse or text on a screen: new content, placed where it is drawn. */
  "sketch",
]);
export type AnnotationKind = z.infer<typeof AnnotationKind>;

const Pt = z.tuple([z.number(), z.number()]);

export const Geometry = z.discriminatedUnion("type", [
  z.object({ type: z.literal("point"), x: z.number(), y: z.number() }),
  z.object({ type: z.literal("path"), points: z.array(Pt) }),
  z.object({ type: z.literal("rect"), x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
  z.object({
    type: z.literal("arrow"),
    from: Pt,
    to: Pt,
    /** When the arrow ends on another tile; `to` is then in that screen's pixels. */
    toScreenId: z.string().optional(),
  }),
]);
export type Geometry = z.infer<typeof Geometry>;

export const InkData = z.object({
  strokes: z.array(z.object({ points: z.array(z.tuple([z.number(), z.number(), z.number()])) })),
  pointerType: z.enum(["pen", "mouse", "touch"]),
  handwriting: z.boolean(),
});
export type InkData = z.infer<typeof InkData>;

/** Look of a drawn shape or text; shared by board sketches and vision items. */
export const SketchStyle = z.object({
  color: z.string(),
  /** Stroke width in the item's pixel space. */
  width: z.number().positive(),
  /** Fill colour of boxes and ellipses; omitted: no fill. */
  fill: z.string().optional(),
  /** Font size of text. */
  size: z.number().positive().optional(),
});
export type SketchStyle = z.infer<typeof SketchStyle>;

export const SketchShape = z.enum(["line", "box", "ellipse", "text"]);
export type SketchShape = z.infer<typeof SketchShape>;

export const Resolution = z.object({
  status: z.enum(["resolved", "region", "unresolved"]),
  elements: z.array(z.string()),
  toElements: z.array(z.string()).optional(),
  region: Rect.optional(),
  confirmedByUser: z.boolean(),
});
export type Resolution = z.infer<typeof Resolution>;

export const Annotation = z.object({
  id: z.string(),
  screenId: z.string(),
  kind: AnnotationKind,
  geometry: Geometry,
  text: z.string().optional(),
  attachedTo: z.string().optional(),
  /**
   * Explicit element targets (rule annotations). Targets on another screen are
   * written as `<screenId>#<elementId>`.
   */
  targets: z.array(z.string()).optional(),
  ink: InkData.optional(),
  resolution: Resolution.optional(),
  /**
   * Sketch annotations: the shape and its look. Lines use a two-point path,
   * boxes and ellipses a rect, text a rect around it with the words in `text`.
   */
  sketch: z.object({ shape: SketchShape, style: SketchStyle }).optional(),
});
export type Annotation = z.infer<typeof Annotation>;

export const AnnotationsFile = z.object({
  version: z.literal(1),
  round: z.number().int(),
  annotations: z.array(Annotation),
});
export type AnnotationsFile = z.infer<typeof AnnotationsFile>;

/* ─────────────────────────── vision ─────────────────────────── */

/** A white artboard on the vision board, in world units. */
export const VisionCanvas = z.object({
  id: z.string(),
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
});
export type VisionCanvas = z.infer<typeof VisionCanvas>;

const Box = { x: z.number(), y: z.number(), w: z.number(), h: z.number(), rotation: z.number().optional() };

/**
 * Something drawn or placed on the vision board, in world units. Items belong to
 * the canvas their centre is on. `rotation` is in degrees around the box centre.
 */
export const VisionItem = z.discriminatedUnion("type", [
  z.object({
    id: z.string(),
    type: z.literal("stroke"),
    points: z.array(z.tuple([z.number(), z.number(), z.number()])),
    style: SketchStyle,
  }),
  z.object({ id: z.string(), type: z.literal("line"), from: Pt, to: Pt, style: SketchStyle }),
  z.object({ id: z.string(), type: z.literal("box"), ...Box, style: SketchStyle }),
  z.object({ id: z.string(), type: z.literal("ellipse"), ...Box, style: SketchStyle }),
  z.object({ id: z.string(), type: z.literal("text"), ...Box, text: z.string(), style: SketchStyle }),
  z.object({
    id: z.string(),
    type: z.literal("image"),
    ...Box,
    /** Relative to `.scribui/vision/`, e.g. `images/i3k2l9.png`. */
    src: z.string(),
  }),
]);
export type VisionItem = z.infer<typeof VisionItem>;

export const VisionFile = z.object({
  version: z.literal(1),
  canvases: z.array(VisionCanvas),
  items: z.array(VisionItem),
});
export type VisionFile = z.infer<typeof VisionFile>;

/* ─────────────────────────── review output ─────────────────────────── */

export const TargetRef = z.object({
  elementId: z.string(),
  type: z.string(),
  label: z.string().optional(),
  bounds: Rect,
  source: SourceRef.optional(),
});
export type TargetRef = z.infer<typeof TargetRef>;

export const Instruction = z.object({
  id: z.string(),
  screenId: z.string(),
  action: z.enum(["remove", "change", "move", "add", "relate", "note"]),
  targets: z.array(TargetRef),
  destination: z.union([TargetRef, z.object({ region: Rect })]).optional(),
  /** Screen the destination lives on, when it differs from `screenId`. */
  destinationScreenId: z.string().optional(),
  text: z.string(),
  instruction: z.string(),
  status: z.enum(["resolved", "unresolved"]),
  annotationIds: z.array(z.string()),
  /** Marker number drawn on the annotated screenshot. */
  marker: z.number().int(),
  /** Circle or rectangle without a comment: the canvas warns before sending. */
  needsText: z.boolean().optional(),
  /** Cropped handwritten notes, relative to the round folder. */
  ink: z.array(z.string()).optional(),
});
export type Instruction = z.infer<typeof Instruction>;

export const RuleEntry = z.object({
  id: z.string(),
  text: z.string(),
  examples: z.array(z.object({ screenId: z.string(), target: TargetRef })),
  annotationId: z.string(),
});
export type RuleEntry = z.infer<typeof RuleEntry>;

export const ReviewJson = z.object({
  version: z.literal(1),
  round: z.number().int(),
  app: z.string(),
  instructions: z.array(Instruction),
  rules: z.array(RuleEntry),
  counts: z.object({
    instructions: z.number().int(),
    unresolved: z.number().int(),
    needsText: z.number().int(),
    rules: z.number().int(),
  }),
});
export type ReviewJson = z.infer<typeof ReviewJson>;

/* ─────────────────────────── round status ─────────────────────────── */

export const RoundState = z.enum(["capturing", "open", "sent", "applied"]);
export type RoundState = z.infer<typeof RoundState>;

export const ScreenCaptureStatus = z.object({
  screenId: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
  /** Not recaptured: screenshot and tree were copied from this round. */
  reusedFrom: z.number().int().optional(),
  /** Why the screen was captured (or reused). */
  reason: z.string().optional(),
  /** Fingerprint of the screen's manifest entry and flow file, to notice when they change. */
  fingerprint: z.string().optional(),
});

export const StatusFile = z.object({
  round: z.number().int(),
  status: RoundState,
  createdAt: z.string(),
  updatedAt: z.string(),
  sentAt: z.string().optional(),
  appliedAt: z.string().optional(),
  screens: z.array(ScreenCaptureStatus).optional(),
  /**
   * Written by the agent when it marks the round applied: ids of screens whose
   * UI it changed, or "all" when shared styles or components changed.
   */
  changedScreens: z.union([z.array(z.string()), z.literal("all")]).optional(),
  /** While capturing: how far along it is (also written by captures in other processes). */
  progress: z
    .object({ total: z.number().int(), done: z.number().int(), current: z.string().optional(), queue: z.array(z.string()) })
    .optional(),
});
export type StatusFile = z.infer<typeof StatusFile>;
