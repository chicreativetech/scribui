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
  // the vision board is the first view; these tests are about the review board
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
  await page.keyboard.type("a round badge");
  await page.keyboard.press("Enter");
  const list = (await saved(page)) as (Ann & { sketch?: { shape: string; style: { color: string } } })[];
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ kind: "sketch", text: "a round badge", sketch: { shape: "ellipse", style: { color: "#3E63DD" } } });
  expect(list[0]!.resolution?.status).toBe("region");
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
