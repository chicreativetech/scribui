import { describe, expect, it } from "vitest";
import { globToRegExp, planCapture, type PlanInput, type PreviousRound } from "../src/index.js";

const screens = [
  { id: "home", title: "Home", flow: "flows/home.sh", sources: ["app/**/feature/home/**"] },
  { id: "shop", title: "Shop", flow: "flows/shop.sh", sources: ["app/**/feature/shop/**"] },
  { id: "profile", title: "Profile", flow: "flows/profile.sh", sources: ["app/**/feature/profile/**"] },
];
const unmapped = screens.map(({ sources: _s, ...rest }) => rest);
const fp = new Map(screens.map((s) => [s.id, `fp-${s.id}`]));
const prev = (p: Partial<PreviousRound> = {}): PreviousRound => ({
  round: 1,
  status: "applied",
  screens: screens.map((s) => ({ screenId: s.id, ok: true, fingerprint: `fp-${s.id}` })),
  ...p,
});
const plan = (i: Partial<PlanInput>) =>
  planCapture({ screens: unmapped, previous: prev(), fingerprints: fp, changedFiles: [], ...i });
const captured = (p: ReturnType<typeof planCapture>) => p.items.filter((i) => i.action === "capture").map((i) => i.screenId);

describe("globToRegExp", () => {
  it("matches ** across directories, * within one", () => {
    expect(globToRegExp("app/**/feature/shop/**").test("app/src/main/java/se/x/feature/shop/ShopScreens.kt")).toBe(true);
    expect(globToRegExp("app/**/feature/shop/**").test("app/src/feature/home/Home.kt")).toBe(false);
    expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/x/a.ts")).toBe(false);
    expect(globToRegExp("**/*.md").test("README.md")).toBe(true);
  });
});

describe("planCapture", () => {
  it("captures everything on the first round and with --all", () => {
    expect(plan({ previous: null }).full).toBe(true);
    expect(plan({ all: true }).why).toBe("--all");
  });

  it("captures screens that had instructions, reuses the rest", () => {
    const p = plan({ previous: prev({ reviewedScreens: ["shop"] }), changedFiles: ["app/src/feature/shop/Shop.kt"] });
    expect(captured(p)).toEqual(["shop"]);
    expect(p.items.find((i) => i.screenId === "home")).toMatchObject({ action: "reuse", reusedFrom: 1, copyFrom: 1 });
  });

  it("captures screens the agent reported, and everything for 'all'", () => {
    expect(captured(plan({ previous: prev({ changedScreens: ["profile"] }) }))).toEqual(["profile"]);
    expect(plan({ previous: prev({ changedScreens: "all" }) }).full).toBe(true);
  });

  it("captures everything when the round added rules", () => {
    expect(plan({ previous: prev({ reviewedScreens: ["shop"], newRules: 1 }) }).full).toBe(true);
  });

  it("maps changed files to screens through sources", () => {
    const p = plan({ screens, changedFiles: ["app/src/main/java/x/feature/home/HomeScreen.kt"] });
    expect(captured(p)).toEqual(["home"]);
    expect(p.items[0]!.reason).toContain("source changed");
  });

  it("captures everything for shared sources or unmapped changes", () => {
    expect(plan({ screens, sharedSources: ["app/**/designsystem/**"], changedFiles: ["app/x/designsystem/Theme.kt"] }).full).toBe(true);
    expect(plan({ screens, changedFiles: ["app/src/main/AndroidManifest.xml"] }).why).toContain("not mapped");
  });

  it("ignores docs, tests and intentcue files", () => {
    const p = plan({ screens, changedFiles: ["README.md", ".intentcue/rounds/001/status.json", "app/src/test/x/FooTest.kt"] });
    expect(captured(p)).toEqual([]);
    expect(p.why).toContain("nothing changed");
  });

  it("is safe when files changed but nothing says which screens", () => {
    expect(plan({ changedFiles: ["app/src/main/java/Foo.kt"] }).full).toBe(true);
  });

  it("captures new screens, failed screens and changed flows", () => {
    const p = plan({
      screens: [...unmapped, { id: "cart", title: "Cart" }],
      previous: prev({ screens: [{ screenId: "home", ok: true, fingerprint: "fp-home" }, { screenId: "shop", ok: false }, { screenId: "profile", ok: true, fingerprint: "old" }] }),
    });
    expect(Object.fromEntries(p.items.map((i) => [i.screenId, i.reason]))).toEqual({
      home: "unchanged",
      shop: "failed last time",
      profile: "flow or screens.json entry changed",
      cart: "new screen",
    });
  });

  it("recaptures screens on the same page together", () => {
    const web = [
      { id: "checkout", title: "Checkout", url: "/checkout" },
      { id: "checkout-error", title: "Checkout, error", url: "/checkout?error=card" },
      { id: "cart", title: "Cart", url: "/cart" },
    ];
    const p = planCapture({
      screens: web,
      previous: prev({ screens: web.map((w) => ({ screenId: w.id, ok: true })), changedScreens: ["checkout"] }),
      fingerprints: new Map(),
      changedFiles: [],
    });
    expect(Object.fromEntries(p.items.map((i) => [i.screenId, i.reason]))).toEqual({
      checkout: "agent changed it in R001",
      "checkout-error": "same page as checkout",
      cart: "unchanged",
    });
  });

  it("--screens captures exactly those and reuses the rest", () => {
    const p = plan({ only: ["shop"], previous: prev({ changedScreens: "all" }) });
    expect(captured(p)).toEqual(["shop"]);
  });

  it("keeps pointing at the original round across reuses", () => {
    const p = plan({ previous: prev({ round: 3, screens: [{ screenId: "home", ok: true, reusedFrom: 1 }, { screenId: "shop", ok: true }, { screenId: "profile", ok: true }] }) });
    expect(p.items.find((i) => i.screenId === "home")).toMatchObject({ reusedFrom: 1, copyFrom: 3 });
    expect(p.items.find((i) => i.screenId === "shop")).toMatchObject({ reusedFrom: 3 });
  });
});
