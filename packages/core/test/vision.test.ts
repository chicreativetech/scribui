import { describe, expect, it } from "vitest";
import {
  canvasOf,
  compile,
  itemBounds,
  renderAnnotationSvg,
  renderVisionCanvasSvg,
  renderVisionMarkdown,
  resolveAll,
  visionPages,
  wrapCanvas,
  type Annotation,
  type VisionCanvas,
  type VisionItem,
} from "../src/index.js";
import { el, screen } from "./helpers.js";

const style = { color: "#262626", width: 3 };
const c1: VisionCanvas = { id: "c1", x: 0, y: 0, w: 1280, h: 800 };

describe("vision board", () => {
  it("an item belongs to the canvas its centre is on", () => {
    const inside: VisionItem = { id: "a", type: "box", x: 100, y: 100, w: 200, h: 100, style };
    const across: VisionItem = { id: "b", type: "box", x: 1200, y: 100, w: 400, h: 100, style };
    expect(canvasOf(inside, [c1])?.id).toBe("c1");
    expect(canvasOf(across, [c1])).toBeUndefined();
  });

  it("rotation widens the bounds", () => {
    const b = itemBounds({ id: "a", type: "image", x: 0, y: 0, w: 100, h: 20, rotation: 90, src: "images/x.png" });
    expect(b.w).toBeCloseTo(20);
    expect(b.h).toBeCloseTo(100);
  });

  it("wraps a drawing off every canvas in a new canvas of the default size", () => {
    const r = wrapCanvas({ x: 2000, y: 100, w: 100, h: 50 }, [c1], { w: 1280, h: 800 });
    expect(r).toMatchObject({ w: 1280, h: 800 });
    expect(r.x).toBeLessThanOrEqual(2000);
    expect(r.x + r.w).toBeGreaterThanOrEqual(2100);
  });

  it("a new canvas next to an old one grows away from it", () => {
    const r = wrapCanvas({ x: 1340, y: 100, w: 80, h: 80 }, [c1], { w: 1280, h: 800 });
    expect(r.x).toBeGreaterThanOrEqual(1280);
    expect(r.w).toBe(1280);
  });

  it("exports a canvas: white page, clipped viewBox, shapes, text and images", () => {
    const items: VisionItem[] = [
      { id: "t", type: "text", x: 40, y: 40, w: 200, h: 40, text: "Calm & <bold>", style: { ...style, size: 32 } },
      { id: "e", type: "ellipse", x: 300, y: 300, w: 100, h: 60, style: { ...style, fill: "#FC9803" }, rotation: 15 },
      { id: "i", type: "image", x: 500, y: 100, w: 100, h: 100, src: "images/a.png" },
    ];
    const svg = renderVisionCanvasSvg(c1, items, (src) => `data:${src}`);
    expect(svg).toContain('viewBox="0 0 1280 800"');
    expect(svg).toContain('fill="#FFFFFF"');
    expect(svg).toContain("Calm &amp; &lt;bold&gt;");
    expect(svg).toContain('rotate(15 350 330)');
    expect(svg).toContain('href="data:images/a.png"');
  });

  it("only canvases with something on them are pages, in reading order", () => {
    const c2: VisionCanvas = { id: "c2", x: 1400, y: 0, w: 400, h: 800 };
    const c0: VisionCanvas = { id: "c0", x: 0, y: 1000, w: 400, h: 400 };
    const items: VisionItem[] = [
      { id: "a", type: "line", from: [1500, 10], to: [1600, 20], style },
      { id: "b", type: "line", from: [10, 10], to: [20, 20], style },
    ];
    expect(visionPages({ canvases: [c2, c0, c1], items }).map((p) => p.canvas.id)).toEqual(["c1", "c2"]);
  });

  it("vision.md links each canvas and quotes the words on it", () => {
    const md = renderVisionMarkdown([{ file: "vision/canvas-1.png", items: [{ id: "t", type: "text", x: 0, y: 0, w: 1, h: 1, text: "Hero\nbig photo", style }] }], 4);
    expect(md).toContain("# Visual direction, round 4");
    expect(md).toContain("![Canvas 1](vision/canvas-1.png)");
    expect(md).toContain('- "Hero / big photo"');
  });
});

describe("sketch annotations", () => {
  const tree = screen([el("button", [20, 720, 360, 60], { id: "later", label: "Later" })]);
  const run = (a: Annotation, visionCanvases = 0) =>
    compile({
      round: 2,
      appName: "Demo",
      date: "2026-10-06",
      screens: [{ id: "s", title: "Home" }],
      captures: new Map([["s", { screenId: "s", root: tree }]]),
      annotations: resolveAll([a], new Map([["s", tree]])),
      visionCanvases,
    });

  it("a sketched box is new content where it was drawn", () => {
    const out = run({ id: "a", screenId: "s", kind: "sketch", geometry: { type: "rect", x: 20, y: 100, w: 300, h: 120 }, sketch: { shape: "box", style }, text: "promo banner" });
    expect(out.review.instructions[0]).toMatchObject({ action: "add", status: "resolved", destination: { region: { x: 20, y: 100, w: 300, h: 120 } } });
    expect(out.review.instructions[0]!.instruction).toMatch(/^Add promo banner in the area at/);
  });

  it("sketched text asks for those words", () => {
    const out = run({ id: "a", screenId: "s", kind: "sketch", geometry: { type: "rect", x: 20, y: 300, w: 200, h: 40 }, sketch: { shape: "text", style: { ...style, size: 32 } }, text: "Free shipping" });
    expect(out.review.instructions[0]!.instruction).toContain('Add the text "Free shipping" in the area at');
    expect(out.review.instructions[0]!.needsText).toBeUndefined();
  });

  it("a bare shape asks for a comment", () => {
    const out = run({ id: "a", screenId: "s", kind: "sketch", geometry: { type: "path", points: [[20, 400], [300, 400]] }, sketch: { shape: "line", style } });
    expect(out.review.instructions[0]).toMatchObject({ needsText: true });
  });

  it("renders in its own colour", () => {
    const svg = renderAnnotationSvg({ id: "a", screenId: "s", kind: "sketch", geometry: { type: "rect", x: 0, y: 0, w: 10, h: 10 }, sketch: { shape: "ellipse", style: { color: "#3E63DD", width: 2 } } }, { unit: 1, label: "1" });
    expect(svg).toContain('stroke="#3E63DD"');
    expect(svg).toContain("<ellipse");
  });

  it("review.md points to vision.md when canvases are sent", () => {
    expect(run({ id: "a", screenId: "s", kind: "comment", geometry: { type: "point", x: 30, y: 730 }, text: "x" }, 2).markdown).toContain("read vision.md first. It holds 2 canvases");
  });
});
