import { describe, expect, it } from "vitest";
import { compile, numberAnnotations, phraseTarget, renderAnnotationSvg, resolveAll, sketchPartsBounds, type Annotation, type SketchPart } from "../src/index.js";
import { el, ellipse, screen } from "./helpers.js";

const tree = screen([
  el("container", [20, 100, 360, 200], {
    id: "card",
    children: [
      el("text", [40, 120, 320, 30], { id: "title", label: "Summary" }),
      el("button", [40, 220, 320, 60], { id: "pay", label: "Pay now" }),
    ],
  }),
  el("button", [20, 720, 360, 60], { id: "later", label: "Later" }),
]);
const captures = new Map([["s", { screenId: "s", root: tree }]]);

function run(annotations: Annotation[], round = 3) {
  const resolved = resolveAll(annotations, new Map([["s", tree]]));
  return compile({ round, appName: "Demo", date: "2026-09-30", screens: [{ id: "s", title: "Checkout" }], captures, annotations: resolved });
}
const A = (id: string, a: Omit<Annotation, "id" | "screenId">): Annotation => ({ id, screenId: "s", ...a });

describe("compiler templates", () => {
  it("remove", () => {
    const out = run([A("a", { kind: "remove", geometry: { type: "point", x: 60, y: 250 }, text: "not needed" })]);
    expect(out.review.instructions[0]).toMatchObject({
      id: "R3-1",
      action: "remove",
      instruction: 'Remove the "Pay now" button (id: pay). Not needed.',
    });
  });

  it("circle with comment → change, keeps the comment verbatim in text", () => {
    const out = run([A("a", { kind: "circle", geometry: { type: "path", points: ellipse(200, 250, 190, 45) }, text: "too dominant" })]);
    expect(out.review.instructions[0]).toMatchObject({ action: "change", text: "too dominant", instruction: '"Pay now" button (id: pay): too dominant.' });
  });

  it("circle without comment → review + needsText", () => {
    const out = run([A("a", { kind: "circle", geometry: { type: "path", points: ellipse(200, 250, 190, 45) } })]);
    expect(out.review.instructions[0]).toMatchObject({ needsText: true, instruction: 'Review the "Pay now" button (id: pay); see marker 1.' });
    expect(out.review.counts.needsText).toBe(1);
  });

  it("arrow to element → move next to", () => {
    const out = run([A("a", { kind: "arrow", geometry: { type: "arrow", from: [60, 250], to: [60, 130] } })]);
    expect(out.review.instructions[0]!.instruction).toBe('Move the "Pay now" button (id: pay) next to the "Summary" text (id: title).');
  });

  it("arrow to region → move to area", () => {
    const out = run([A("a", { kind: "arrow", geometry: { type: "arrow", from: [60, 250], to: [200, 500] } })]);
    expect(out.review.instructions[0]!.instruction).toBe('Move the "Pay now" button (id: pay) to the area at (x 200, y 500).');
  });

  it("rectangle on region → add, between neighbours", () => {
    const out = run([A("a", { kind: "rectangle", geometry: { type: "rect", x: 20, y: 400, w: 360, h: 100 }, text: "a trust badge" })]);
    expect(out.review.instructions[0]!.instruction).toBe(
      'Add a trust badge in the empty area at (x 20, y 400, 360 × 100), between the container (id: card) and the "Later" button (id: later).',
    );
  });

  it("freehand → note", () => {
    const out = run([A("a", { kind: "freehand", geometry: { type: "path", points: [[50, 240], [150, 260], [250, 240]] }, text: "wobbly" })]);
    expect(out.review.instructions[0]).toMatchObject({ action: "note", instruction: 'Note on the "Pay now" button (id: pay): wobbly.' });
  });

  it("a sketch of several parts → one instruction, naming its parts and what it's drawn over", () => {
    const style = { color: "#E5484D", width: 8 };
    const parts: SketchPart[] = [
      { type: "box", x: 14, y: 94, w: 372, h: 212, style },
      { type: "line", from: [30, 160], to: [370, 160], style },
      { type: "stroke", points: [[40, 200, 0.5], [80, 240, 0.5]], style },
      { type: "stroke", points: [[100, 200, 0.5], [140, 240, 0.5]], style },
      { type: "text", x: 40, y: 260, w: 120, h: 40, text: "Swipe  me", style: { ...style, size: 32 } },
    ];
    const sketch = (text?: string): Annotation =>
      A("a", {
        kind: "sketch",
        geometry: { type: "rect", ...sketchPartsBounds(parts) },
        sketch: { shape: "drawing", style, parts },
        ...(text ? { text } : {}),
      });
    const out = run([sketch("make the card a carousel")]);
    expect(out.review.instructions).toHaveLength(1);
    expect(out.review.instructions[0]).toMatchObject({
      action: "add",
      instruction:
        'Sketch at marker 1 (a box, a line, 2 freehand strokes and the text "Swipe me") in the area at (x 10, y 90, 380 × 220), above the "Later" button (id: later), drawn over the container (id: card): make the card a carousel.',
    });
    expect(run([sketch()]).review.instructions[0]).toMatchObject({ needsText: true });
    // the annotated screenshot shows every part, in its colour
    const svg = renderAnnotationSvg(sketch(), { unit: 1, label: "1" });
    for (const tag of ["<rect", "<path d=\"M 30 160 L 370 160\"", "<text", "Swipe  me"]) expect(svg).toContain(tag);
    expect(svg.match(/<path d="[^"]+" fill="#E5484D"\/>/g)).toHaveLength(2);
  });

  it("unresolved → flagged, asks the user", () => {
    const out = run([A("a", { kind: "remove", geometry: { type: "point", x: 200, y: 600 }, text: "this" })]);
    expect(out.review.instructions[0]).toMatchObject({
      status: "unresolved",
      instruction: "[UNRESOLVED] This (see annotated screenshot, marker 1); ask the user.",
    });
  });

  it("merges attached comments into their annotation", () => {
    const out = run([
      A("c", { kind: "circle", geometry: { type: "path", points: ellipse(200, 250, 190, 45) } }),
      A("t", { kind: "comment", geometry: { type: "point", x: 200, y: 300 }, text: "make it secondary" }),
    ]);
    expect(out.review.instructions).toHaveLength(1);
    expect(out.review.instructions[0]).toMatchObject({ annotationIds: ["c", "t"], text: "make it secondary" });
  });

  it("phrases generated ids as description plus bounds", () => {
    expect(phraseTarget({ elementId: "g", type: "text", label: "Hi", bounds: { x: 1, y: 2, w: 3, h: 4 } }, "generated")).toBe(
      '"Hi" text at (x 1, y 2, 3 × 4)',
    );
    expect(
      phraseTarget({ elementId: "pay", type: "button", bounds: { x: 0, y: 0, w: 1, h: 1 }, source: { file: "src/Pay.tsx", line: 12, component: "PayButton" } }),
    ).toBe("button (id: pay) in PayButton, src/Pay.tsx:12");
  });

  it("rules go to rules.md, not to instructions", () => {
    const out = run([A("r", { kind: "rule", geometry: { type: "point", x: 0, y: 0 }, targets: ["pay"], text: "Buttons are 48pt" })]);
    expect(out.review.instructions).toHaveLength(0);
    expect(out.review.rules[0]).toMatchObject({ id: "R3-U1", text: "Buttons are 48pt" });
    expect(out.rulesMarkdown).toContain('- Buttons are 48pt.\n  <!-- R3-U1, added 2026-09-30 -->\n  - Example: "Pay now" button (id: pay) on s');
    expect(out.markdown).toContain("New rules added to rules.md: 1.");
  });

  it("is deterministic", () => {
    const anns = [
      A("a", { kind: "remove", geometry: { type: "point", x: 60, y: 250 } }),
      A("b", { kind: "comment", geometry: { type: "point", x: 60, y: 130 }, text: "bigger" }),
    ];
    expect(run(anns)).toEqual(run(anns));
  });

  it("numbers markers per screen order, attached comments share the parent number", () => {
    const { markers } = numberAnnotations(
      [
        { id: "b1", screenId: "b", kind: "remove", geometry: { type: "point", x: 0, y: 0 } },
        { id: "a1", screenId: "a", kind: "circle", geometry: { type: "path", points: [] } },
        { id: "a2", screenId: "a", kind: "comment", geometry: { type: "point", x: 0, y: 0 }, attachedTo: "a1" },
      ],
      ["a", "b"],
    );
    expect([...markers]).toEqual([["a1", 1], ["b1", 2], ["a2", 1]]);
  });
});
