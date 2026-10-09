import { expect, test, type Page } from "@playwright/test";

/*
 * Canvas tests against a fixture round (cart + checkout-default, web, @2x).
 * Tests run in order; the last one sends the round, which locks it.
 */

type Ann = {
  id: string;
  kind: string;
  text?: string;
  attachedTo?: string;
  resolution?: { status: string; elements: string[]; confirmedByUser: boolean };
};

type Cam = { x: number; y: number; zoom: number };
type StoreShape = { getState(): { tiles: { id: string; x: number; y: number; scale: number }[]; camera: Cam; annotations: Ann[] } };
type Win = { __scribui: StoreShape };

const camera = (page: Page) => page.evaluate(() => (window as unknown as Win).__scribui.getState().camera);

async function reset(page: Page) {
  await page.request.put("/api/rounds/1/annotations", { data: { annotations: [] } });
  await page.goto("/");
  // a first open of round 1 starts on the vision board; these tests are about the review board
  await page.getByRole("tab", { name: "Board" }).click();
  await expect(page.locator(".tile img").first()).toBeVisible();
  await page.waitForFunction(() => (window as never as { __scribui?: unknown }).__scribui);
}

/** Screen coordinates of a screenshot pixel on a tile. */
async function at(page: Page, screen: string, x: number, y: number): Promise<[number, number]> {
  return page.evaluate(
    ([screen, x, y]) => {
      const st = (window as unknown as Win).__scribui.getState();
      const t = st.tiles.find((t) => t.id === screen)!;
      const r = document.querySelector(".board")!.getBoundingClientRect();
      const c = st.camera;
      return [r.left + (t.x + x / t.scale - c.x) * c.zoom, r.top + (t.y + y / t.scale - c.y) * c.zoom] as [number, number];
    },
    [screen, x, y] as const,
  );
}

const annotations = (page: Page) =>
  page.evaluate(() => (window as unknown as Win).__scribui.getState().annotations);

async function saved(page: Page): Promise<Ann[]> {
  await expect(page.locator(".status")).toContainText("saved");
  await page.waitForTimeout(350);
  const r = await page.request.get("/api/rounds/1");
  return ((await r.json()) as { annotations: Ann[] }).annotations;
}

async function focus(page: Page, screen: string) {
  await page.mouse.dblclick(...(await at(page, screen, 390, 700)));
  await page.waitForTimeout(400);
}

async function drawLoop(page: Page, screen: string, cx: number, cy: number, rx: number, ry: number) {
  const pts: [number, number][] = [];
  for (let i = 0; i <= 32; i++) {
    const a = (i / 32) * Math.PI * 2 - 0.3;
    pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  await page.mouse.move(...(await at(page, screen, ...pts[0]!)));
  await page.mouse.down();
  for (const p of pts.slice(1)) await page.mouse.move(...(await at(page, screen, ...p)));
  await page.mouse.up();
}

test.beforeEach(async ({ page }) => reset(page));

test("shows tiles grouped by the manifest group, with pan and zoom", async ({ page }) => {
  await expect(page.locator(".group-head .name")).toHaveText(["Purchase flow"]);
  await expect(page.locator(".tile")).toHaveCount(2);
  const z0 = (await camera(page)).zoom;
  await page.mouse.move(700, 450);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -300);
  await page.keyboard.up("Control");
  const z1 = (await camera(page)).zoom;
  expect(z1).toBeGreaterThan(z0);
  const x0 = (await camera(page)).x;
  await page.mouse.wheel(200, 0);
  const x1 = (await camera(page)).x;
  expect(x1).toBeGreaterThan(x0);
});

test("hover outlines an element and alt walks to its parent", async ({ page }) => {
  await focus(page, "checkout-default");
  await page.mouse.move(...(await at(page, "checkout-default", 390, 1130)));
  await expect(page.locator(".hover-label")).toContainText('button#payButton "Pay now"');
  await page.keyboard.press("Alt");
  await expect(page.locator(".hover-label")).toContainText("alt ↑ 2/");
});

test("circle resolves, flashes and shows a chip; text is saved", async ({ page }) => {
  await focus(page, "checkout-default");
  await page.keyboard.press("o");
  await drawLoop(page, "checkout-default", 390, 1130, 400, 80);
  await expect(page.locator(".el-outline.flash")).toHaveCount(1);
  await page.keyboard.type("Make it secondary");
  await page.keyboard.press("Enter");
  await page.keyboard.press("v");
  await expect(page.locator(".chip", { hasText: "payButton" })).toBeVisible();
  const anns = await saved(page);
  expect(anns).toHaveLength(1);
  expect(anns[0]).toMatchObject({ kind: "circle", text: "Make it secondary", resolution: { elements: ["payButton"] } });
});

test("comment, remove, arrow and rectangle", async ({ page }) => {
  await focus(page, "checkout-default");
  await page.keyboard.press("c");
  await page.mouse.click(...(await at(page, "checkout-default", 150, 215)));
  await page.keyboard.type("Bigger heading");
  await page.keyboard.press("Enter");

  await page.keyboard.press("x");
  const apple = await at(page, "checkout-default", 390, 1262);
  await page.mouse.move(...apple);
  await page.mouse.click(...apple);

  await page.keyboard.press("a");
  await page.mouse.move(...(await at(page, "checkout-default", 390, 720)));
  await page.mouse.down();
  await page.mouse.move(...(await at(page, "checkout-default", 390, 250)), { steps: 6 });
  await page.mouse.up();
  await page.keyboard.press("Escape");

  await page.keyboard.press("r");
  await page.mouse.move(...(await at(page, "checkout-default", 40, 1360)));
  await page.mouse.down();
  await page.mouse.move(...(await at(page, "checkout-default", 740, 1440)), { steps: 5 });
  await page.mouse.up();
  await page.keyboard.type("a trust badge");
  await page.keyboard.press("Enter");

  const anns = await saved(page);
  expect(anns.map((a) => [a.kind, a.resolution?.status, a.resolution?.elements[0]])).toEqual([
    ["comment", "resolved", expect.stringContaining("shipping")],
    ["remove", "resolved", "applePayButton"],
    ["arrow", "resolved", "orderSummary"],
    ["rectangle", "region", undefined],
  ]);
  await expect(page.locator(".note")).toHaveCount(4);
});

test("target picker overrides the resolution and survives re-resolve", async ({ page }) => {
  await focus(page, "checkout-default");
  await page.keyboard.press("x");
  await page.mouse.click(...(await at(page, "checkout-default", 390, 1130)));
  await page.keyboard.press("v");
  await page.locator(".chip", { hasText: "payButton" }).click();
  await page.locator(".popover .menu button", { hasText: "empty area" }).click();
  let anns = await saved(page);
  expect(anns[0]!.resolution).toMatchObject({ status: "region", confirmedByUser: true });
  // server-side re-resolve keeps the human override
  const r = await page.request.post("/api/rounds/1/resolve");
  anns = ((await r.json()) as { annotations: Ann[] }).annotations;
  expect(anns[0]!.resolution).toMatchObject({ status: "region", confirmedByUser: true });
});

test("select, move, delete, undo and redo", async ({ page }) => {
  await focus(page, "checkout-default");
  await page.keyboard.press("c");
  await page.mouse.click(...(await at(page, "checkout-default", 390, 1130)));
  await page.keyboard.type("note");
  await page.keyboard.press("Enter");
  await page.keyboard.press("v");
  expect(await annotations(page)).toHaveLength(1);
  await page.keyboard.press("Backspace");
  expect(await annotations(page)).toHaveLength(0);
  await page.keyboard.press("ControlOrMeta+z");
  expect(await annotations(page)).toHaveLength(1);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  expect(await annotations(page)).toHaveLength(0);
  await page.keyboard.press("ControlOrMeta+z");
  // drag the pin by its badge
  const pin = page.locator("[data-ann-id] path").first();
  const box = (await pin.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 120, { steps: 5 });
  await page.mouse.up();
  const [a] = await saved(page);
  expect(a!.resolution?.elements[0]).not.toBe("payButton");
});

test("rule across two screens goes to rules, not instructions", async ({ page }) => {
  await page.keyboard.press("u");
  const cart = await at(page, "cart", 390, 1041);
  await page.mouse.move(...cart);
  await page.mouse.click(...cart);
  const pay = await at(page, "checkout-default", 390, 1130);
  await page.mouse.move(...pay);
  await page.mouse.click(pay[0], pay[1], { modifiers: ["Shift"] });
  await page.keyboard.press("Enter");
  await page.keyboard.type("Primary buttons are 48pt tall");
  await page.keyboard.press("Enter");
  const anns = await saved(page);
  expect(anns[0]).toMatchObject({ kind: "rule", resolution: { elements: ["checkoutButton", "checkout-default#payButton"] } });
  await page.locator(".tabs button", { hasText: "review.md" }).click();
  await expect(page.locator(".md")).toContainText("Primary buttons are 48pt tall");
});

test("pen: a loop becomes a circle, short strokes become an attached handwritten note", async ({ page }) => {
  await focus(page, "checkout-default");
  const stroke = async (pts: [number, number][]) => {
    const scr: [number, number][] = [];
    for (const p of pts) scr.push(await at(page, "checkout-default", ...p));
    await page.evaluate(async (pts) => {
      const el = document.querySelector(".board")!;
      const fire = (type: string, [x, y]: [number, number]) =>
        el.dispatchEvent(new PointerEvent(type, { pointerId: 9, pointerType: "pen", pressure: 0.5, clientX: x, clientY: y, bubbles: true, buttons: 1 }));
      fire("pointerdown", pts[0]!);
      for (const q of pts.slice(1)) fire("pointermove", q);
      fire("pointerup", pts[pts.length - 1]!);
    }, scr);
  };
  const loop: [number, number][] = [];
  for (let i = 0; i <= 36; i++) loop.push([390 + Math.cos(i / 5.73) * 400, 1130 + Math.sin(i / 5.73) * 80]);
  await stroke(loop);
  await page.waitForTimeout(700);
  for (const s of [
    [[300, 1240], [310, 1270], [320, 1240]],
    [[335, 1240], [335, 1270]],
    [[350, 1240], [365, 1270], [380, 1240]],
  ] as [number, number][][]) {
    await stroke(s);
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(1500);
  const anns = await saved(page);
  expect(anns.map((a) => a.kind)).toEqual(["circle", "comment"]);
  expect(anns[0]!.resolution?.elements).toEqual(["payButton"]);
  expect(anns[1]!.attachedTo).toBe(anns[0]!.id);
  await expect(page.locator(".status .mode")).toHaveText("PEN");
});

test("command line and help", async ({ page }) => {
  await page.keyboard.press(":");
  await page.keyboard.type("theme light");
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.keyboard.press("?");
  await expect(page.locator(".modal h2")).toContainText("Point, don't describe");
  await page.keyboard.press("Escape");
});

test("vision: draws on the canvas, starts a new canvas off it, types text, undoes", async ({ page }) => {
  await page.request.put("/api/vision", { data: { version: 1, canvases: [], items: [] } });
  await page.getByRole("tab", { name: "Vision" }).click();
  const canvas = (await page.locator(".vision-canvas").first().boundingBox())!;
  const drag = async (from: [number, number], to: [number, number]) => {
    await page.mouse.move(...from);
    await page.mouse.down();
    await page.mouse.move(...to, { steps: 8 });
    await page.mouse.up();
  };
  // guide tools are gone, sketch tools and image import are there
  await expect(page.getByRole("button", { name: /^comment/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^import image/ })).toBeVisible();

  await page.keyboard.press("b");
  await expect(page.locator(".tool-settings")).toContainText("Fill");
  const mid: [number, number] = [canvas.x + canvas.width / 2, canvas.y + canvas.height / 2];
  await drag([mid[0] - 40, mid[1] - 120], [mid[0] + 60, mid[1] - 40]);
  await page.keyboard.press("t");
  await page.mouse.click(mid[0] - 60, mid[1] + 100);
  await expect(page.locator(".vision-text-edit")).toBeFocused();
  await page.keyboard.type("Big hero photo");
  await page.keyboard.press("Escape");
  await page.keyboard.press("p");
  await drag([canvas.x + canvas.width + 120, canvas.y + 50], [canvas.x + canvas.width + 220, canvas.y + 90]);
  await expect(page.locator(".vision-canvas")).toHaveCount(2);

  await expect(page.locator(".status")).toContainText("saved");
  await page.waitForTimeout(450);
  const v = (await (await page.request.get("/api/vision")).json()) as { canvases: unknown[]; items: { type: string; text?: string }[] };
  expect(v.canvases).toHaveLength(2);
  expect(v.items.map((i) => i.type)).toEqual(["box", "text", "stroke"]);
  expect(v.items[1]!.text).toBe("Big hero photo");

  await page.keyboard.press("Meta+z");
  await expect(page.locator(".vision-canvas")).toHaveCount(1);
  await page.request.put("/api/vision", { data: { version: 1, canvases: [], items: [] } });
});

test("starts on the vision board the first time only, then on the board", async ({ page }) => {
  // reset() opened the project once already: forget that
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByRole("tab", { name: "Vision" })).toHaveAttribute("aria-selected", "true");
  await page.reload();
  await expect(page.getByRole("tab", { name: "Board" })).toHaveAttribute("aria-selected", "true");
});

test("vision: an edge changes one side of a canvas, a corner scales it", async ({ page }) => {
  await page.request.put("/api/vision", { data: { version: 1, canvases: [{ id: "c1", x: 0, y: 0, w: 600, h: 800 }], items: [] } });
  await page.reload();
  await page.getByRole("tab", { name: "Vision" }).click();
  const canvas = page.locator(".vision-canvas").first();
  const a = (await canvas.boundingBox())!;

  // the canvas is centred between the tool rail and the panels on the right
  const rail = (await page.locator(".rail").boundingBox())!;
  const side = (await page.locator(".inspector").boundingBox())!;
  expect(Math.abs(a.x + a.width / 2 - (rail.x + rail.width + side.x) / 2)).toBeLessThan(4);

  const drag = async (from: [number, number], by: [number, number]) => {
    await page.mouse.move(...from);
    await page.mouse.down();
    await page.mouse.move(from[0] + by[0], from[1] + by[1], { steps: 6 });
    await page.mouse.up();
  };
  // the right edge: only wider, top-left in place
  await drag([a.x + a.width, a.y + a.height / 2], [60, 0]);
  const b = (await canvas.boundingBox())!;
  expect(b.width).toBeGreaterThan(a.width + 40);
  expect(Math.abs(b.height - a.height)).toBeLessThan(1);
  expect(Math.abs(b.x - a.x) + Math.abs(b.y - a.y)).toBeLessThan(2);

  // the bottom edge: only taller
  await drag([b.x + b.width / 2, b.y + b.height], [0, -50]);
  const c = (await canvas.boundingBox())!;
  expect(c.height).toBeLessThan(b.height - 30);
  expect(Math.abs(c.width - b.width)).toBeLessThan(1);

  // a corner: bigger, same shape
  await drag([c.x + c.width, c.y + c.height], [80, 80]);
  const d = (await canvas.boundingBox())!;
  expect(d.width).toBeGreaterThan(c.width + 40);
  expect(d.height / d.width).toBeCloseTo(c.height / c.width, 1);

  await page.waitForTimeout(450);
  const v = (await (await page.request.get("/api/vision")).json()) as { canvases: { w: number; h: number }[] };
  expect(v.canvases[0]!.w).toBeGreaterThan(600);
  await page.keyboard.press("Meta+z");
  await expect.poll(async () => (await canvas.boundingBox())!.width).toBeCloseTo(c.width, 0);
  await page.request.put("/api/vision", { data: { version: 1, canvases: [], items: [] } });
});

test("board: sketch tools draw on screens only, with the tool's colour", async ({ page }) => {
  await page.keyboard.press("q");
  await page.locator(".tool-settings").getByRole("button", { name: "colour #3E63DD" }).click();
  // off the screens nothing is drawn
  const off = await at(page, "cart", -300, 200);
  await page.mouse.move(...off);
  await page.mouse.down();
  await page.mouse.move(off[0] + 40, off[1] + 40, { steps: 4 });
  await page.mouse.up();
  expect(await annotations(page)).toHaveLength(0);

  await page.mouse.move(...(await at(page, "cart", 100, 400)));
  await page.mouse.down();
  await page.mouse.move(...(await at(page, "cart", 500, 600)), { steps: 6 });
  await page.mouse.up();
  // the sketch stays open for more parts until it's ready
  await page.keyboard.press("Enter");
  await page.keyboard.type("a round badge");
  await page.keyboard.press("Enter");
  type Sketched = Ann & { sketch?: { shape: string; parts?: { type: string; style: { color: string } }[] } };
  const list = (await saved(page)) as Sketched[];
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ kind: "sketch", text: "a round badge", sketch: { shape: "drawing", parts: [{ type: "ellipse", style: { color: "#3E63DD" } }] } });
  expect(list[0]!.resolution?.status).toBe("region");
});

test("board: all the sketch tools add to one sketch until it's ready", async ({ page }) => {
  const drag = async (from: [number, number], to: [number, number]) => {
    await page.mouse.move(...(await at(page, "cart", ...from)));
    await page.mouse.down();
    await page.mouse.move(...(await at(page, "cart", ...to)), { steps: 6 });
    await page.mouse.up();
  };
  const chip = page.locator(".drawing-chip");
  // freehand strokes: lift the pen and keep drawing
  await page.keyboard.press("p");
  await drag([100, 300], [600, 300]);
  await drag([600, 300], [600, 700]);
  // a box, a line and text join the same sketch
  await page.keyboard.press("b");
  await drag([120, 320], [580, 680]);
  await page.keyboard.press("i");
  await drag([120, 500], [580, 500]);
  await expect(chip).toContainText("4 parts");
  expect(await annotations(page)).toHaveLength(0);
  // undo and redo step through the sketch, not the notes before it
  await page.keyboard.press("ControlOrMeta+z");
  await expect(chip).toContainText("3 parts");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(chip).toContainText("4 parts");
  await page.getByRole("button", { name: "undo" }).click();
  await page.getByRole("button", { name: "undo" }).click();
  await expect(chip).toContainText("2 parts");
  await page.getByRole("button", { name: "redo" }).click();
  await expect(chip).toContainText("3 parts");
  await page.keyboard.press("t");
  await page.mouse.click(...(await at(page, "cart", 150, 400)));
  await expect(page.locator(".sketch-text")).toBeFocused();
  await page.keyboard.type("Swipe me");
  await page.keyboard.press("Enter");
  await expect(page.locator(".sketch-text")).toHaveCount(0);
  await expect(chip).toContainText("4 parts");

  await chip.getByRole("button", { name: /Ready/ }).click();
  await expect(chip).toHaveCount(0);
  await page.keyboard.type("a card with a swipe hint");
  await page.keyboard.press("Enter");

  type Sketched = Ann & { sketch?: { shape: string; parts?: { type: string; text?: string }[] } };
  const list = (await saved(page)) as Sketched[];
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ kind: "sketch", text: "a card with a swipe hint", sketch: { shape: "drawing" } });
  expect(list[0]!.sketch!.parts!.map((p) => p.type)).toEqual(["stroke", "stroke", "box", "text"]);
  expect(list[0]!.sketch!.parts![3]!.text).toBe("Swipe me");

  // a tool that isn't a sketch tool finishes an open sketch too
  await page.keyboard.press("p");
  await drag([100, 900], [500, 950]);
  await page.keyboard.press("v");
  await expect(page.locator(".popover textarea")).toBeFocused();
  await page.keyboard.press("Escape");
  expect((await saved(page)).filter((a) => a.kind === "sketch")).toHaveLength(2);
});

test("board: the fill tool fills a box, a closed area of lines, and recolours a line", async ({ page }) => {
  const drag = async (from: [number, number], to: [number, number]) => {
    await page.mouse.move(...(await at(page, "cart", ...from)));
    await page.mouse.down();
    await page.mouse.move(...(await at(page, "cart", ...to)), { steps: 4 });
    await page.mouse.up();
  };
  const click = async (x: number, y: number) => page.mouse.click(...(await at(page, "cart", x, y)));
  await page.keyboard.press("b");
  await drag([100, 200], [400, 400]);
  // a triangle of three lines
  await page.keyboard.press("i");
  await drag([100, 600], [500, 600]);
  await drag([500, 600], [300, 900]);
  await drag([300, 900], [100, 600]);
  await page.keyboard.press("g");
  await page.locator(".tool-settings").getByRole("button", { name: "colour #E5484D" }).click();
  await click(250, 300);
  await click(300, 700);
  // outside every closed shape there's nothing to fill
  await click(700, 300);
  await expect(page.locator(".toast")).toContainText("isn't closed");
  await page.locator(".tool-settings").getByRole("button", { name: "colour #30A46C" }).click();
  await click(300, 600);
  await expect(page.locator(".drawing-chip")).toContainText("5 parts");
  await page.keyboard.press("Enter");
  await page.keyboard.type("a red card and a play button");
  await page.keyboard.press("Enter");

  type Part = { type: string; style: { color: string; fill?: string }; loops?: [number, number][][] };
  const list = (await saved(page)) as (Ann & { sketch?: { parts?: Part[] } })[];
  const parts = list[0]!.sketch!.parts!;
  expect(parts.map((p) => p.type)).toEqual(["box", "line", "line", "line", "fill"]);
  expect(parts[0]!.style.fill).toBe("#E5484D");
  expect(parts[1]!.style.color).toBe("#30A46C");
  // the fill covers the triangle and no more
  const xs = parts[4]!.loops!.flat().map((p) => p[0]);
  const ys = parts[4]!.loops!.flat().map((p) => p[1]);
  expect(Math.min(...xs)).toBeGreaterThan(80);
  expect(Math.max(...xs)).toBeLessThan(520);
  expect(Math.min(...ys)).toBeGreaterThan(580);
  expect(Math.max(...ys)).toBeLessThan(920);
});

test("board: the fill tool fills a shape drawn over a filled one, and undoes", async ({ page }) => {
  const drag = async (from: [number, number], to: [number, number]) => {
    await page.mouse.move(...(await at(page, "cart", ...from)));
    await page.mouse.down();
    await page.mouse.move(...(await at(page, "cart", ...to)), { steps: 4 });
    await page.mouse.up();
  };
  const loop = async (cx: number, cy: number, rad: number) => {
    await page.mouse.move(...(await at(page, "cart", cx + rad, cy)));
    await page.mouse.down();
    for (let i = 1; i <= 40; i++) await page.mouse.move(...(await at(page, "cart", cx + Math.cos((i / 40) * Math.PI * 2) * rad, cy + Math.sin((i / 40) * Math.PI * 2) * rad)));
    await page.mouse.up();
  };
  const click = async (x: number, y: number) => page.mouse.click(...(await at(page, "cart", x, y)));
  const colour = (c: string) => page.locator(".tool-settings").getByRole("button", { name: `colour ${c}` }).click();
  type Part = { type: string; style: { color: string; fill?: string }; loops?: [number, number][][] };
  const parts = () => page.evaluate(() => (window as never as { __scribui: { getState(): { drawing: { parts: Part[] } | null } } }).__scribui.getState().drawing?.parts ?? []);

  // a box filled red, a box drawn over it filled green
  await page.keyboard.press("b");
  await drag([100, 200], [500, 500]);
  await page.keyboard.press("g");
  await colour("#E5484D");
  await click(150, 250);
  await page.keyboard.press("b");
  await drag([200, 300], [400, 450]);
  await page.keyboard.press("g");
  await colour("#30A46C");
  await click(300, 400);
  let p = await parts();
  expect(p.map((x) => [x.type, x.style.fill])).toEqual([["box", "#E5484D"], ["box", "#30A46C"]]);

  // a freehand loop filled blue, a smaller one drawn in it filled yellow
  await page.keyboard.press("p");
  await loop(300, 750, 120);
  await page.keyboard.press("g");
  await colour("#3E63DD");
  await click(200, 750);
  await page.keyboard.press("p");
  await loop(300, 750, 50);
  await page.keyboard.press("g");
  await colour("#F2D100");
  await click(300, 750);
  p = await parts();
  expect(p.map((x) => x.type)).toEqual(["box", "box", "stroke", "fill", "stroke", "fill"]);
  expect(p[3]!.style.color).toBe("#3E63DD");
  expect(p[5]!.style.color).toBe("#F2D100");
  const xs = p[5]!.loops!.flat().map((q) => q[0]);
  expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(130);
  // clicking the same area again recolours that fill
  await colour("#8E4EC6");
  await click(300, 750);
  p = await parts();
  expect(p).toHaveLength(6);
  expect(p[5]!.style.color).toBe("#8E4EC6");
  // and undo puts its colour back
  await page.keyboard.press("ControlOrMeta+z");
  expect((await parts())[5]!.style.color).toBe("#F2D100");
});

test("vision: the fill tool fills a closed area of a canvas, under its lines", async ({ page }) => {
  const line = (id: string, from: [number, number], to: [number, number]) => ({ id, type: "line", from, to, style: { color: "#262626", width: 4 } });
  await page.request.put("/api/vision", {
    data: { version: 1, canvases: [{ id: "c1", x: 0, y: 0, w: 600, h: 800 }], items: [line("l1", [100, 100], [500, 100]), line("l2", [500, 100], [300, 400]), line("l3", [300, 400], [100, 100])] },
  });
  await page.getByRole("tab", { name: "Vision" }).click();
  const box = (await page.locator(".vision-canvas").first().boundingBox())!;
  const at = (x: number, y: number) => [box.x + (x * box.width) / 600, box.y + (y * box.height) / 800] as const;
  await page.keyboard.press("g");
  await page.mouse.click(...at(300, 200));
  await expect(page.locator(".status")).toContainText("saved");
  await page.waitForTimeout(450);
  const v = (await (await page.request.get("/api/vision")).json()) as { items: { type: string; loops?: [number, number][][] }[] };
  expect(v.items.map((i) => i.type)).toEqual(["fill", "line", "line", "line"]);
  const ys = v.items[0]!.loops!.flat().map((p) => p[1]);
  expect(Math.min(...ys)).toBeGreaterThan(90);
  expect(Math.max(...ys)).toBeLessThan(410);

  // a box drawn over a filled one: the fill goes to the box on top
  const rect = (id: string, x: number, y: number, w: number, h: number, fill?: string) => ({ id, type: "box", x, y, w, h, style: { color: "#262626", width: 4, ...(fill ? { fill } : {}) } });
  await page.request.put("/api/vision", {
    data: { version: 1, canvases: [{ id: "c1", x: 0, y: 0, w: 600, h: 800 }], items: [rect("a", 100, 450, 400, 300, "#E5484D"), rect("b", 200, 520, 200, 150)] },
  });
  await page.reload();
  await page.getByRole("tab", { name: "Vision" }).click();
  await page.keyboard.press("g");
  await page.mouse.click(...at(300, 600));
  await expect(page.locator(".status")).toContainText("saved");
  await page.waitForTimeout(450);
  const after = (await (await page.request.get("/api/vision")).json()) as { items: { id: string; style: { fill?: string } }[] };
  expect(after.items.map((i) => [i.id, i.style.fill])).toEqual([["a", "#E5484D"], ["b", "#3E63DD"]]);
  await page.request.put("/api/vision", { data: { version: 1, canvases: [], items: [] } });
});

test("send writes the review and locks the round", async ({ page }) => {
  await focus(page, "checkout-default");
  await page.keyboard.press("x");
  await page.mouse.click(...(await at(page, "checkout-default", 390, 1262)));
  await saved(page);
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(page.locator(".modal h2")).toContainText("Send 1 instruction");
  await page.keyboard.press("Enter");
  await expect(page.locator(".prompt-box code")).toHaveText("Implement .scribui/latest/review.md");
  const md = await (await page.request.get("/api/rounds/1/review")).text();
  expect(md).toContain('[R1-1] Remove the "Pay with Apple Pay" button (id: applePayButton).');
  await page.keyboard.press("Escape");
  await expect(page.locator(".next-banner")).toContainText("Sent to your agent");
  const put = await page.request.put("/api/rounds/1/annotations", { data: { annotations: [] } });
  expect(put.status()).toBe(409);
});
