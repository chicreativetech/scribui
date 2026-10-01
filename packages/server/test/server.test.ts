import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp, LanAuth, ReviewStore, sendRound } from "../src/index.js";

const F = join(import.meta.dirname, "../../../fixtures");

/** A project with round 1 captured from the web fixtures. */
async function project() {
  const dir = mkdtempSync(join(tmpdir(), "intentcue-test-"));
  const store = new ReviewStore(dir);
  await store.init({ platform: "web", name: "Test" });
  cpSync(join(F, "web/checkout/screens.json"), store.path("screens.json"));
  const n = await store.createRound();
  for (const id of ["cart", "checkout-default"]) {
    cpSync(join(F, `web/checkout/trees/${id}.json`), join(store.roundDir(n), "trees", `${id}.json`));
    cpSync(join(F, `web/checkout/screens/${id}.png`), join(store.roundDir(n), "screens", `${id}.png`));
  }
  await store.setStatus(n, "open");
  return { dir, store, n };
}

describe("store", () => {
  it("init creates the folder contract and the agent section", async () => {
    const dir = mkdtempSync(join(tmpdir(), "intentcue-init-"));
    writeFileSync(join(dir, "CLAUDE.md"), "# Mine\n\nKeep this.\n");
    const store = new ReviewStore(dir);
    const created = await store.init({ platform: "ios" });
    expect(created).toContain(".intentcue/screens.json");
    expect(existsSync(join(dir, ".intentcue/flows/home.yaml"))).toBe(true);
    const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(agents).toContain("## Visual design review");
    const claude = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    expect(claude).toMatch(/^# Mine\n\nKeep this\.\n\n<!-- intentcue:start -->/);
    // idempotent
    expect(await store.init({ platform: "ios" })).toEqual([]);
  });

  it("creates numbered rounds with a latest pointer", async () => {
    const { store } = await project();
    expect(await store.latestRound()).toBe(1);
    const n2 = await store.createRound();
    expect(n2).toBe(2);
    expect(await store.latestRound()).toBe(2);
    expect(readFileSync(store.path("latest/status.json"), "utf8")).toContain('"round": 2');
  });

  it("rules.md is append-only and keeps human edits", async () => {
    const { store } = await project();
    const p = store.path("rules.md");
    writeFileSync(p, readFileSync(p, "utf8") + "- My hand-written rule\n");
    await store.appendRules("- New rule.\n", "Round 1 · 2026-09-30");
    const body = readFileSync(p, "utf8");
    expect(body).toContain("- My hand-written rule\n\n## Round 1 · 2026-09-30\n\n- New rule.\n");
  });

  it("refuses paths outside .intentcue", async () => {
    const { store } = await project();
    expect(store.safePath("../package.json")).toBeNull();
    expect(store.safePath("rounds/001/review.md")).not.toBeNull();
  });
});

describe("send", () => {
  let ctx: Awaited<ReturnType<typeof project>>;
  beforeEach(async () => {
    ctx = await project();
  });

  it("compiles, renders, appends rules, locks the round", async () => {
    const { store, n } = ctx;
    const anns = JSON.parse(readFileSync(join(F, "rounds/01-basic/annotations.json"), "utf8")).annotations;
    anns.push({ id: "r1", screenId: "cart", kind: "rule", geometry: { type: "point", x: 0, y: 0 }, targets: ["checkoutButton"], text: "Buttons are full width" });
    await store.writeAnnotations(n, anns);
    const res = await sendRound(store, n);
    expect(res.counts).toMatchObject({ instructions: 5, unresolved: 0, rules: 1 });
    const dir = store.roundDir(n);
    expect(readFileSync(join(dir, "review.md"), "utf8")).toContain("[R1-2] Remove the \"Pay with Apple Pay\" button (id: applePayButton).");
    expect(existsSync(join(dir, "screens/checkout-default.annotated.png"))).toBe(true);
    expect(readFileSync(store.path("rules.md"), "utf8")).toContain("- Buttons are full width.");
    expect((await store.readStatus(n)).status).toBe("sent");
    await expect(store.writeAnnotations(n, [])).rejects.toThrow(/immutable/);
    await expect(sendRound(store, n)).rejects.toThrow(/immutable/);
  });

  it("writes handwriting crops", async () => {
    const { store, n } = ctx;
    const anns = JSON.parse(readFileSync(join(F, "rounds/05-ink/annotations.json"), "utf8")).annotations;
    await store.writeAnnotations(n, anns);
    await sendRound(store, n);
    const png = readFileSync(join(store.roundDir(n), "ink/e2.png"));
    expect(png.subarray(1, 4).toString()).toBe("PNG");
  });
});

describe("http api", () => {
  it("serves rounds, validates and saves annotations, sends", async () => {
    const { dir, n } = await project();
    const { app } = createApp({ projectDir: dir });
    const local = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
    const req = (path: string, init?: RequestInit) => app.request(path, init, local);

    const round = (await (await req(`/api/rounds/${n}`)).json()) as { screens: { id: string; captured: boolean }[] };
    expect(round.screens.filter((s) => s.captured).map((s) => s.id)).toEqual(["cart", "checkout-default"]);

    const cap = await req(`/api/rounds/${n}/screens/cart`);
    expect(cap.status).toBe(200);

    const bad = await req(`/api/rounds/${n}/annotations`, { method: "PUT", body: JSON.stringify({ annotations: [{ id: 1 }] }), headers: { "content-type": "application/json" } });
    expect(bad.status).toBe(400);

    const ok = await req(`/api/rounds/${n}/annotations`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ annotations: [{ id: "a", screenId: "cart", kind: "remove", geometry: { type: "point", x: 390, y: 200 } }] }),
    });
    expect(ok.status).toBe(200);

    const sent = (await (await req(`/api/rounds/${n}/send`, { method: "POST" })).json()) as { prompt: string };
    expect(sent.prompt).toBe("Implement .intentcue/latest/review.md");
    expect((await req(`/api/rounds/${n}/send`, { method: "POST" })).status).toBe(409);
    expect(await (await req(`/api/rounds/${n}/review`)).text()).toContain("promoBanner");

    expect((await req("/files/..%2F..%2Fpackage.json")).status).toBe(404);
    expect((await req("/files/rounds%2F..%2F..%2F..%2Fetc%2Fpasswd.md")).status).toBe(404);
    expect((await req(`/files/rounds/001/screens/cart.png`)).headers.get("content-type")).toBe("image/png");
  });

  it("refuses non-loopback requests unless paired over LAN", async () => {
    const { dir } = await project();
    const remote = { incoming: { socket: { remoteAddress: "192.168.1.20" } } };
    const closed = createApp({ projectDir: dir });
    expect((await closed.app.request("/api/rounds", undefined, remote)).status).toBe(403);

    const open = createApp({ projectDir: dir, lan: true });
    expect((await open.app.request("/api/rounds", undefined, remote)).status).toBe(403);
    const token = open.lan.issueToken();
    const pair = await open.app.request(`/pair?token=${token}`, undefined, remote);
    expect(pair.status).toBe(302);
    const cookie = pair.headers.get("set-cookie")!.split(";")[0]!;
    expect((await open.app.request("/api/rounds", { headers: { cookie } }, remote)).status).toBe(200);
    // one-time token
    expect((await open.app.request(`/pair?token=${token}`, undefined, remote)).status).toBe(403);
  });

  it("pairing tokens expire", () => {
    const lan = new LanAuth();
    const t = lan.issueToken(-1);
    expect(lan.redeem(t)).toBeNull();
  });
});
