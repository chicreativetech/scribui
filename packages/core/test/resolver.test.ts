import { describe, expect, it } from "vitest";
import { attachComments, resolve, resolveAll, type Annotation } from "../src/index.js";
import { el, ellipse, screen, webTrees } from "./helpers.js";

/*
 * screen 400×800
 *  ├─ header (0,0,400,60)            id header
 *  │   └─ back button (10,10,40,40)  id back
 *  ├─ card (20,100,360,200)          id card
 *  │   ├─ title text (40,120,320,30) id title "Summary"
 *  │   ├─ price text (40,160,320,30) generated "€87"
 *  │   └─ pay button (40,220,320,60) id pay "Pay now"
 *  └─ (empty area 20,320 → 380,700)
 */
const tree = screen([
  el("navbar", [0, 0, 400, 60], { id: "header", children: [el("button", [10, 10, 40, 40], { id: "back", label: "Back" })] }),
  el("container", [20, 100, 360, 200], {
    id: "card",
    children: [
      el("text", [40, 120, 320, 30], { id: "title", label: "Summary" }),
      el("text", [40, 160, 320, 30], { label: "€87" }),
      el("button", [40, 220, 320, 60], { id: "pay", label: "Pay now" }),
    ],
  }),
]);

const A = (a: Partial<Annotation> & Pick<Annotation, "kind" | "geometry">): Annotation => ({
  id: a.id ?? "x",
  screenId: "s",
  ...a,
});

describe("resolver: comment", () => {
  it("picks the deepest element under the pin", () => {
    expect(resolve(A({ kind: "comment", geometry: { type: "point", x: 60, y: 250 } }), tree)).toMatchObject({
      status: "resolved",
      elements: ["pay"],
    });
  });
  it("returns a region on empty space", () => {
    const r = resolve(A({ kind: "comment", geometry: { type: "point", x: 200, y: 500 } }), tree);
    expect(r.status).toBe("region");
    expect(r.region).toEqual({ x: 200, y: 500, w: 0, h: 0 });
  });
  it("attaches to another annotation within 24px", () => {
    const circle = A({ id: "c", kind: "circle", geometry: { type: "path", points: ellipse(200, 250, 180, 50) } });
    const near = A({ id: "n", kind: "comment", geometry: { type: "point", x: 200, y: 318 }, text: "hi" });
    const far = A({ id: "f", kind: "comment", geometry: { type: "point", x: 200, y: 600 }, text: "far" });
    const out = attachComments([circle, near, far]);
    expect(out.find((a) => a.id === "n")!.attachedTo).toBe("c");
    expect(out.find((a) => a.id === "f")!.attachedTo).toBeUndefined();
  });
  it("attached comments inherit the parent's resolution", () => {
    const circle = A({ id: "c", kind: "circle", geometry: { type: "path", points: ellipse(200, 250, 180, 50) } });
    const near = A({ id: "n", kind: "comment", geometry: { type: "point", x: 200, y: 318 }, text: "hi" });
    const out = resolveAll([circle, near], new Map([["s", tree]]));
    expect(out[1]!.resolution?.elements).toEqual(out[0]!.resolution?.elements);
  });
});

describe("resolver: circle", () => {
  it("selects a single fully circled element", () => {
    const r = resolve(A({ kind: "circle", geometry: { type: "path", points: ellipse(200, 250, 190, 50) } }), tree);
    expect(r).toMatchObject({ status: "resolved", elements: ["pay"] });
  });
  it("selects the smallest container when its children are circled", () => {
    const r = resolve(A({ kind: "circle", geometry: { type: "path", points: ellipse(200, 200, 230, 150) } }), tree);
    expect(r.elements).toEqual(["card"]);
  });
  it("returns all top-level candidates when no container qualifies", () => {
    // loop around title and price only (card coverage < 0.6)
    const r = resolve(A({ kind: "circle", geometry: { type: "path", points: ellipse(200, 157, 200, 55) } }), tree);
    expect(r.elements.sort()).toEqual(["screen.0/container.0/text.1~87", "title"].sort());
  });
  it("returns a region when nothing is covered", () => {
    const r = resolve(A({ kind: "circle", geometry: { type: "path", points: ellipse(200, 500, 60, 40) } }), tree);
    expect(r.status).toBe("region");
    expect(r.region!.w).toBeGreaterThan(100);
  });
  it("ignores elements larger than 90% of the screen", () => {
    const r = resolve(A({ kind: "circle", geometry: { type: "path", points: ellipse(200, 400, 400, 600) } }), tree);
    expect(r.elements).not.toContain(tree.id);
  });
});

describe("resolver: rectangle", () => {
  it("returns a region for an empty area (add something here)", () => {
    const r = resolve(A({ kind: "rectangle", geometry: { type: "rect", x: 20, y: 320, w: 360, h: 60 } }), tree);
    expect(r).toMatchObject({ status: "region", region: { x: 20, y: 320, w: 360, h: 60 } });
  });
  it("resolves like a circle when it covers an element", () => {
    const r = resolve(A({ kind: "rectangle", geometry: { type: "rect", x: 30, y: 210, w: 340, h: 80 } }), tree);
    expect(r.elements).toEqual(["pay"]);
  });
});

describe("resolver: arrow", () => {
  it("resolves start and end elements", () => {
    const r = resolve(A({ kind: "arrow", geometry: { type: "arrow", from: [60, 250], to: [30, 30] } }), tree);
    expect(r).toMatchObject({ elements: ["pay"], toElements: ["back"] });
  });
  it("returns a region destination on empty space", () => {
    const r = resolve(A({ kind: "arrow", geometry: { type: "arrow", from: [60, 250], to: [200, 600] } }), tree);
    expect(r.elements).toEqual(["pay"]);
    expect(r.region).toEqual({ x: 200, y: 600, w: 0, h: 0 });
  });
  it("is unresolved when the start is on empty space", () => {
    expect(resolve(A({ kind: "arrow", geometry: { type: "arrow", from: [200, 600], to: [60, 250] } }), tree).status).toBe(
      "unresolved",
    );
  });
  it("resolves the destination on another screen", () => {
    const other = screen([el("button", [0, 700, 400, 100], { id: "next" })]);
    const trees = new Map([
      ["s", tree],
      ["o", other],
    ]);
    const r = resolve(A({ kind: "arrow", geometry: { type: "arrow", from: [60, 250], to: [200, 750], toScreenId: "o" } }), tree, trees);
    expect(r).toMatchObject({ elements: ["pay"], toElements: ["next"] });
  });
});

describe("resolver: remove", () => {
  it("picks the deepest element under the click", () => {
    expect(resolve(A({ kind: "remove", geometry: { type: "point", x: 20, y: 20 } }), tree).elements).toEqual(["back"]);
  });
  it("is unresolved on empty space", () => {
    expect(resolve(A({ kind: "remove", geometry: { type: "point", x: 200, y: 600 } }), tree).status).toBe("unresolved");
  });
});

describe("resolver: freehand", () => {
  it("open path: the smallest element holding most of the path", () => {
    const pts: [number, number][] = [[50, 240], [150, 260], [250, 240], [350, 260]];
    expect(resolve(A({ kind: "freehand", geometry: { type: "path", points: pts } }), tree).elements).toEqual(["pay"]);
  });
  it("open path across elements: the one with the longest stretch", () => {
    const pts: [number, number][] = [[200, 250], [200, 350], [200, 500]];
    const r = resolve(A({ kind: "freehand", geometry: { type: "path", points: pts } }), tree);
    expect(r.elements).toEqual(["card"]);
  });
  it("closed loop resolves like a circle", () => {
    const r = resolve(A({ kind: "freehand", geometry: { type: "path", points: ellipse(200, 250, 190, 50) } }), tree);
    expect(r.elements).toEqual(["pay"]);
  });
});

describe("resolver: rule and overrides", () => {
  it("rules use explicit targets", () => {
    const r = resolve(A({ kind: "rule", geometry: { type: "point", x: 0, y: 0 }, targets: ["pay", "o#next"] }), tree);
    expect(r).toMatchObject({ status: "resolved", elements: ["pay", "o#next"] });
  });
  it("never changes a confirmed resolution", () => {
    const confirmed = { status: "resolved" as const, elements: ["card"], confirmedByUser: true };
    const r = resolve(A({ kind: "remove", geometry: { type: "point", x: 20, y: 20 }, resolution: confirmed }), tree);
    expect(r).toBe(confirmed);
  });
  it("prefers real ids and smaller area on ties", () => {
    const t = screen([
      el("container", [0, 0, 200, 200], { children: [el("button", [10, 10, 50, 50], { label: "gen" })] }),
      el("container", [0, 0, 200, 200], { id: "real", children: [el("button", [10, 10, 50, 50], { id: "realBtn" })] }),
    ]);
    const r = resolve(A({ kind: "remove", geometry: { type: "point", x: 20, y: 20 } }), t);
    expect(r.elements).toEqual(["realBtn"]);
  });
  it("thresholds are configuration", () => {
    const loose = resolve(
      A({ kind: "circle", geometry: { type: "path", points: ellipse(200, 157, 200, 55) } }),
      tree,
      undefined,
      { coverage: 0.3 },
    );
    expect(loose.elements.length).toBeGreaterThan(0);
  });
});

describe("resolver on a real web capture", () => {
  const trees = webTrees();
  it("finds testIDs on the checkout screen", () => {
    const t = trees.get("checkout-default")!;
    expect(resolve(A({ kind: "remove", geometry: { type: "point", x: 390, y: 1130 } }), t).elements).toEqual(["payButton"]);
    expect(resolve(A({ kind: "circle", geometry: { type: "path", points: ellipse(390, 716, 380, 110) } }), t).elements).toEqual([
      "orderSummary",
    ]);
  });
});
