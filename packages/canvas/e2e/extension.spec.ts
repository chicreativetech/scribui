import { join } from "node:path";
import { chromium, expect, test, type BrowserContext } from "@playwright/test";
import { servePage } from "./pages";

/*
 * The browser extension (packages/extension), loaded into Chromium: it sends a tab's
 * page to the fixture project's server, and an open Review shows it as it arrives.
 */

const EXTENSION = join(import.meta.dirname, "../../extension");
const SERVER = "http://127.0.0.1:4399";

// a page whose last section only exists once it has been scrolled to, with a web
// component styled the way Lit and most design systems do it (an adopted stylesheet)
const PAGE = `<!doctype html><html><head><title>Lazy pricing</title><meta name="viewport" content="width=device-width">
<style>body{margin:0;font:16px sans-serif} header{height:1200px;background:#123;color:#fff} #end{height:400px}</style></head>
<body><brand-badge id="badge"></brand-badge><header id="top"><h1>Plans</h1></header><div id="end"></div>
<script>
  customElements.define("brand-badge", class extends HTMLElement {
    constructor() {
      super();
      const root = this.attachShadow({ mode: "open" });
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(":host { display: block; width: 300px; height: 60px; background: rgb(0, 0, 255); }");
      root.adoptedStyleSheets = [sheet];
      root.innerHTML = "<slot></slot>";
    }
  });
  new IntersectionObserver((seen) => {
    if (!seen[0].isIntersecting || document.getElementById("late-plan")) return;
    const b = document.createElement("button");
    b.id = "late-plan";
    b.textContent = "Enterprise";
    document.getElementById("end").appendChild(b);
  }).observe(document.getElementById("end"));
</script></body></html>`;

let ctx: BrowserContext;
let site: Awaited<ReturnType<typeof servePage>>;
test.afterAll(async () => {
  await ctx?.close();
  await site?.close();
});

test("the extension sends the page in a tab to Review, scrolled through first", async ({ request }) => {
  site = await servePage(PAGE);
  const target = site.url;

  ctx = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });
  const worker = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).host;

  const review = await ctx.newPage();
  await review.goto(`${SERVER}/`);
  await review.getByRole("tab", { name: "Review", exact: true }).click();

  const tab = await ctx.newPage();
  await tab.setViewportSize({ width: 1280, height: 800 });
  await tab.goto(target);

  // the popup, opened as a page on that tab; the test server isn't on ScribUI's usual ports
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  // opened as a page, its own tab is the active one: not a page that can be captured
  await expect(popup.locator("#blocked")).toBeVisible();
  const tabId = await popup.evaluate(async (url) => {
    await chrome.storage.local.set({ ports: [4399] });
    return (await chrome.tabs.query({ url }))[0]!.id!;
  }, target);
  await popup.goto(`chrome-extension://${id}/popup.html?tab=${tabId}`);

  await expect(popup.locator("#form")).toBeVisible();
  await expect(popup.locator("#title")).toHaveValue("Lazy pricing");
  // a ScribUI of your own on the usual ports would be listed first
  const option = await popup.locator("#project option", { hasText: "Grove" }).first().getAttribute("value");
  await popup.locator("#project").selectOption(option!);
  // a page on this computer, in a web project: a screen of the app
  await expect(popup.getByRole("radio", { name: /Our app/ })).toHaveAttribute("aria-checked", "true");
  await popup.getByRole("radio", { name: /Reference/ }).click();
  await popup.screenshot({ path: "test-results/extension-popup.png" });
  await popup.getByRole("button", { name: "Send to ScribUI" }).click();
  await expect(popup.locator("#done")).toBeVisible({ timeout: 30_000 });
  await expect(popup.locator("#done-title")).toHaveText('"Lazy pricing" is in ScribUI');
  await popup.screenshot({ path: "test-results/extension-done.png" });

  // the open Review shows it without a reload
  await expect(review.locator(".toast", { hasText: '"Lazy pricing" added from the browser' })).toBeVisible();
  // run from the command line, not the desktop app: Open in ScribUI goes to the Review tab already open
  const pages = ctx.pages().length;
  await popup.getByRole("button", { name: "Open in ScribUI" }).click();
  await expect(review.locator(".tile-label", { hasText: "Lazy pricing" })).toBeVisible();
  await expect.poll(() => review.evaluate(() => (window as never as { __scribui: { getState(): { focusId: string | null } } }).__scribui.getState().focusId)).toMatch(/^lazy-pricing/);
  expect(ctx.pages().filter((p) => !p.isClosed()).length).toBeLessThanOrEqual(pages);

  const after = await request.get(`${SERVER}/api/project`).then((r) => r.json());
  const s = after.manifest.screens.find((x: { title: string }) => x.title === "Lazy pricing");
  expect(s.imported).toMatchObject({ kind: "snapshot", role: "reference", url: target });
  const round = after.latest;
  const cap = await request.get(`${SERVER}/api/rounds/${round}/screens/${s.id}`).then((r) => r.json());
  expect(cap.device.width).toBe(1280);
  // added by the page's own script when scrolled to, before the snapshot
  expect(JSON.stringify(cap.root)).toContain('"late-plan"');
  // the component kept its styles: sized and blue
  type Node = { id: string; bounds: { x: number; y: number; w: number; h: number }; children: Node[] };
  const find = (n: Node, id: string): Node | undefined => (n.id === id ? n : n.children.map((c) => find(c, id)).find(Boolean));
  const badge = find(cap.root, "badge")!.bounds;
  expect([badge.w, badge.h]).toEqual([300, 60]);
  const png = await request.get(`${SERVER}/files/rounds/${String(round).padStart(3, "0")}/${cap.screenshot}`).then((r) => r.body());
  const color = await review.evaluate(
    async ([b64, x, y]) => {
      const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const c = new OffscreenCanvas(img.width, img.height);
      const g = c.getContext("2d")!;
      g.drawImage(img, 0, 0);
      return [...g.getImageData(x, y, 1, 1).data.slice(0, 3)];
    },
    [png.toString("base64"), badge.x + 150, badge.y + 30] as [string, number, number],
  );
  expect(color).toEqual([0, 0, 255]);
  // and the page in the tab is as it was
  expect(await tab.evaluate(() => document.querySelector("brand-badge")!.shadowRoot!.querySelectorAll("link").length)).toBe(0);
  await request.delete(`${SERVER}/api/rounds/${round}/screens/${s.id}`);
});
