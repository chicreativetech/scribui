import { describe, expect, it } from "vitest";
import { normalizeTree, TreeIndex } from "../src/index.js";
import { el } from "./helpers.js";

describe("normalizeTree", () => {
  it("drops invisible and zero-size elements", () => {
    const t = normalizeTree(
      el("screen", [0, 0, 400, 800], {
        children: [
          el("button", [0, 0, 100, 40], { id: "a" }),
          { ...el("button", [0, 50, 100, 40], { id: "hidden" }), visible: false },
          el("image", [10, 10, 0, 0], { id: "zero" }),
        ],
      }),
    );
    expect(t.children.map((c) => c.id)).toEqual(["a"]);
  });

  it("collapses single-child wrappers with identical bounds, keeping the better id and label", () => {
    const t = normalizeTree(
      el("screen", [0, 0, 400, 800], {
        children: [
          el("container", [10, 10, 100, 40], {
            id: "wrapper",
            children: [el("button", [10, 10, 100, 40], { label: "Pay" })],
          }),
        ],
      }),
    );
    expect(t.children).toHaveLength(1);
    expect(t.children[0]).toMatchObject({ id: "wrapper", type: "button", label: "Pay" });
  });

  it("keeps a wrapper whose bounds differ", () => {
    const t = normalizeTree(
      el("screen", [0, 0, 400, 800], {
        children: [el("container", [0, 0, 200, 200], { children: [el("button", [10, 10, 100, 40])] })],
      }),
    );
    expect(t.children[0]!.children).toHaveLength(1);
  });

  it("generates stable ids from type path, sibling index and label", () => {
    const build = () =>
      normalizeTree(
        el("screen", [0, 0, 400, 800], {
          children: [
            el("container", [0, 0, 400, 400], {
              children: [el("text", [0, 0, 100, 20], { label: "Hello World" }), el("text", [0, 30, 100, 20])],
            }),
          ],
        }),
      );
    const a = build();
    const b = build();
    expect(a).toEqual(b);
    const texts = a.children[0]!.children.map((c) => c.id);
    expect(texts).toEqual(["screen.0/container.0/text.0~hello-world", "screen.0/container.0/text.1"]);
    expect(a.children[0]!.children[0]!.idSource).toBe("generated");
  });

  it("de-duplicates repeated real ids", () => {
    const t = normalizeTree(
      el("screen", [0, 0, 400, 800], {
        children: [el("cell", [0, 0, 400, 40], { id: "row" }), el("cell", [0, 40, 400, 40], { id: "row" })],
      }),
    );
    expect(t.children.map((c) => c.id)).toEqual(["row", "row#2"]);
  });

  it("indexes elements and finds the deepest under a point", () => {
    const t = normalizeTree(
      el("screen", [0, 0, 400, 800], {
        children: [el("container", [0, 0, 400, 200], { id: "card", children: [el("button", [10, 10, 100, 40], { id: "btn" })] })],
      }),
    );
    const idx = new TreeIndex(t);
    expect(idx.stackAt(20, 20).map((f) => f.el.id)).toEqual(["btn", "card", t.id]);
    expect(idx.ancestors("btn").map((e) => e.id)).toEqual(["card", t.id]);
  });
});
