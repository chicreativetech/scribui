import { join } from "node:path";
import { chromium, expect, test, type BrowserContext } from "@playwright/test";
import { servePage } from "./pages";

/*
 * The browser extension (packages/extension), loaded into Chromium: it sends a tab's
 * page to the fixture project's server, and an open Review shows it as it arrives.
 */

const EXTENSION = join(import.meta.dirname, "../../extension");
const SERVER = "http://127.0.0.1:4399";

// a page whose last section only exists once it has been scrolled to
const PAGE = `<!doctype html><html><head><title>Lazy pricing</title><meta name="viewport" content="width=device-width">
<style>body{margin:0;font:16px sans-serif} header{height:1200px;background:#123;color:#fff} #end{height:400px}</style></head>
<body><header id="top"><h1>Plans</h1></header><div id="end"></div>
<script>
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
  await popup.getByRole("button", { name: "Send to Review" }).click();
  await expect(popup.locator("#done")).toBeVisible({ timeout: 30_000 });
  await expect(popup.locator("#done-title")).toHaveText('"Lazy pricing" is in Review');
  await popup.screenshot({ path: "test-results/extension-done.png" });

  // the open Review shows it without a reload
  const toast = review.locator(".toast", { hasText: '"Lazy pricing" added from the browser' });
  await expect(toast).toBeVisible();
  await toast.getByRole("button", { name: "show it" }).click();
  await expect(review.locator(".tile-label", { hasText: "Lazy pricing" })).toBeVisible();

  const after = await request.get(`${SERVER}/api/project`).then((r) => r.json());
  const s = after.manifest.screens.find((x: { title: string }) => x.title === "Lazy pricing");
  expect(s.imported).toMatchObject({ kind: "snapshot", role: "reference", url: target });
  const round = after.latest;
  const cap = await request.get(`${SERVER}/api/rounds/${round}/screens/${s.id}`).then((r) => r.json());
  expect(cap.device.width).toBe(1280);
  // added by the page's own script when scrolled to, before the snapshot
  expect(JSON.stringify(cap.root)).toContain('"late-plan"');
  await request.delete(`${SERVER}/api/rounds/${round}/screens/${s.id}`);
});
