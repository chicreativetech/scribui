import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp, LanAuth, ReviewStore, sendRound, startServer } from "../src/index.js";
import { connect } from "node:net";

const F = join(import.meta.dirname, "../../../fixtures");

/** A project with round 1 captured from the web fixtures. */
async function project() {
  const dir = mkdtempSync(join(tmpdir(), "scribui-test-"));
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
    const dir = mkdtempSync(join(tmpdir(), "scribui-init-"));
    writeFileSync(join(dir, "CLAUDE.md"), "# Mine\n\nKeep this.\n");
    const store = new ReviewStore(dir);
    const created = await store.init({ platform: "ios" });
    expect(created).toContain(".scribui/screens.json");
    // iOS screens are captured by hand: no flows, and the agent is told so
    expect(existsSync(join(dir, ".scribui/flows/home.yaml"))).toBe(false);
    expect((await store.readManifest()).screens).toEqual([]);
    const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(agents).toContain("## Visual design review");
    expect(agents).toContain("captures the app's screens by hand");
    const claude = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    expect(claude).toMatch(/^# Mine\n\nKeep this\.\n\n<!-- scribui:start -->/);
    // idempotent
    expect(await store.init({ platform: "ios" })).toEqual([]);
  });

  it("refreshes an existing agent section for the platform, and leaves files without one alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scribui-refresh-"));
    const store = new ReviewStore(dir);
    await store.init({ platform: "web" });
    writeFileSync(join(dir, "CLAUDE.md"), "# Mine\n");
    expect(await store.refreshAgentSection("android")).toEqual(["AGENTS.md"]);
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain("Device tab");
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe("# Mine\n");
    expect(await store.refreshAgentSection("android")).toEqual([]);
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

  it("refuses paths outside .scribui", async () => {
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
    expect(sent.prompt).toBe("Implement .scribui/latest/review.md");
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

    // only the computer running ScribUI can unpair, and unpairing locks the device out
    expect((await open.app.request("/api/lan", { method: "DELETE", headers: { cookie } }, remote)).status).toBe(403);
    expect((await open.app.request("/api/lan", { method: "DELETE" }, { incoming: { socket: { remoteAddress: "127.0.0.1" } } })).status).toBe(200);
    expect(open.lan.paired).toBe(0);
    expect((await open.app.request("/api/rounds", { headers: { cookie } }, remote)).status).toBe(403);
  });

  it("removes a screen from an open round, with the notes on it", async () => {
    const { store, n } = await project();
    const { app } = createApp({ projectDir: store.root });
    const local = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
    await store.setStatus(n, "open", { screens: [{ screenId: "cart", ok: true }, { screenId: "checkout-default", ok: true }] });
    const note = (id: string, screenId: string, extra = {}) => ({ id, screenId, kind: "comment", geometry: { type: "point", x: 1, y: 1 }, text: "x", ...extra });
    await store.writeAnnotations(n, [
      note("a1", "cart"),
      note("a2", "checkout-default"),
      { id: "a3", screenId: "checkout-default", kind: "arrow", geometry: { type: "arrow", from: [1, 1], to: [2, 2], toScreenId: "cart" } },
    ] as never);

    const res = await app.request(`/api/rounds/${n}/screens/cart`, { method: "DELETE" }, local);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: "cart", notes: 2 });
    expect(existsSync(join(store.roundDir(n), "screens", "cart.png"))).toBe(false);
    expect(await store.readCapture(n, "cart")).toBeNull();
    expect((await store.readStatus(n)).screens?.map((s) => s.screenId)).toEqual(["checkout-default"]);
    expect((await store.readAnnotations(n)).map((a) => a.id)).toEqual(["a2"]);
    expect((await store.readManifest()).screens.map((s) => s.id)).not.toContain("cart");

    expect((await app.request(`/api/rounds/${n}/screens/cart`, { method: "DELETE" }, local)).status).toBe(404);
    await store.setStatus(n, "sent");
    expect((await app.request(`/api/rounds/${n}/screens/checkout-default`, { method: "DELETE" }, local)).status).toBe(409);
  });

  it("keeps a project vision board and sends it as vision.md with a PNG per canvas", async () => {
    const { dir, store, n } = await project();
    const { app } = createApp({ projectDir: dir });
    const local = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
    const req = (path: string, init?: RequestInit) => app.request(path, init, local);

    expect(await (await req("/api/vision")).json()).toEqual({ version: 1, canvases: [], items: [] });
    const png = readFileSync(join(F, "web/checkout/screens/cart.png"));
    const up = await req("/api/vision/images", { method: "POST", headers: { "content-type": "image/png" }, body: png });
    const { src } = (await up.json()) as { src: string };
    expect(src).toMatch(/^images\/[0-9a-f]{16}\.png$/);
    expect((await req(`/api/vision/${src}`)).headers.get("content-type")).toBe("image/png");
    expect((await req("/api/vision/images", { method: "POST", headers: { "content-type": "text/plain" }, body: "x" })).status).toBe(415);
    expect((await req("/api/vision/images/..%2F..%2Fscreens.json")).status).toBe(404);

    const style = { color: "#262626", width: 3 };
    const vision = {
      version: 1,
      canvases: [
        { id: "c1", x: 0, y: 0, w: 640, h: 400 },
        { id: "c2", x: 800, y: 0, w: 640, h: 400 },
      ],
      items: [
        { id: "t", type: "text", x: 40, y: 40, w: 300, h: 40, text: "Warm and calm", style: { ...style, size: 32 } },
        { id: "i", type: "image", x: 100, y: 120, w: 120, h: 200, rotation: 10, src },
      ],
    };
    expect((await req("/api/vision", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(vision) })).status).toBe(200);
    expect((await req("/api/vision", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: 1, canvases: [], items: [{ type: "blob" }] }) })).status).toBe(400);

    await sendRound(store, n);
    const out = store.roundDir(n);
    // the empty second canvas is left out
    expect(readFileSync(join(out, "vision/canvas-1.png")).subarray(1, 4).toString()).toBe("PNG");
    expect(existsSync(join(out, "vision/canvas-2.png"))).toBe(false);
    const md = readFileSync(join(out, "vision.md"), "utf8");
    expect(md).toContain("![Canvas 1](vision/canvas-1.png)");
    expect(md).toContain('- "Warm and calm"');
    expect(readFileSync(join(out, "review.md"), "utf8")).toContain("read vision.md first. It holds 1 canvas ");
    // the board itself stays editable after the round is sent
    expect((await req("/api/vision", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...vision, items: [] }) })).status).toBe(200);
  });

  it("pairing tokens expire", () => {
    const lan = new LanAuth();
    const t = lan.issueToken(-1);
    expect(lan.redeem(t)).toBeNull();
  });
});

describe("closing the server", () => {
  it("doesn't wait for a request that's still on its way", async () => {
    const { dir } = await project();
    const srv = await startServer({ projectDir: dir, port: 0, watchMs: 60_000 });
    // a client mid-request: headers sent, never finished
    const sock = connect(srv.port, "127.0.0.1");
    await new Promise<void>((r) => sock.once("connect", () => r()));
    sock.write("GET /api/project HTTP/1.1\r\nHost: 127.0.0.1\r\n");
    await new Promise((r) => setTimeout(r, 50));
    const closed = await Promise.race([srv.close().then(() => "closed"), new Promise((r) => setTimeout(() => r("hung"), 3000))]);
    sock.destroy();
    expect(closed).toBe("closed");
  });
});
