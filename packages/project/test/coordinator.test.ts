import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReviewStore, type CaptureRunner } from "@scribui/server";
import { captureProject, captureRound, findOwner, hostProject, ignoreLockInGit, ProjectLock, readLock, saveCapturedView, type LockInfo } from "../src/index.js";

const F = join(import.meta.dirname, "../../../fixtures");

/** A web project with round 1 captured from the fixtures. */
async function project() {
  const dir = mkdtempSync(join(tmpdir(), "scribui-coord-"));
  const store = new ReviewStore(dir);
  await store.init({ platform: "web", name: "Test", baseUrl: "http://127.0.0.1:5178" });
  cpSync(join(F, "web/checkout/screens.json"), store.path("screens.json"));
  const n = await store.createRound();
  for (const id of ["cart", "checkout-default"]) {
    cpSync(join(F, `web/checkout/trees/${id}.json`), join(store.roundDir(n), "trees", `${id}.json`));
    cpSync(join(F, `web/checkout/screens/${id}.png`), join(store.roundDir(n), "screens", `${id}.png`));
  }
  await store.setStatus(n, "open");
  return { dir, store, n };
}

/** A process that stays alive for `ms`: something else holding a lock. */
function otherProcess(ms: number) {
  const child = spawn(process.execPath, ["-e", `setTimeout(() => {}, ${ms})`], { stdio: "ignore" });
  return { pid: child.pid!, exited: new Promise<void>((r) => child.on("exit", () => r())), kill: () => child.kill() };
}

const writeLock = (reviewDir: string, info: Partial<LockInfo>) =>
  writeFileSync(join(reviewDir, ".lock"), JSON.stringify({ pid: 1, host: hostname(), role: "capture", app: "cli", startedAt: new Date().toISOString(), ...info }));

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe("project lock", () => {
  it("is exclusive, says who holds it, and is released by its owner only", async () => {
    const { store } = await project();
    const a = ProjectLock.acquire(store.dir, { role: "server", app: "cli" });
    expect("lock" in a).toBe(true);
    const b = ProjectLock.acquire(store.dir, { role: "capture", app: "mcp" });
    expect(b).toMatchObject({ held: { pid: process.pid, role: "server", app: "cli" } });
    if (!("lock" in a)) return;
    a.lock.update({ port: 4390 });
    expect(readLock(store.dir)).toMatchObject({ port: 4390, role: "server" });
    a.lock.release();
    expect(readLock(store.dir)).toBeNull();
  });

  it("takes over a lock whose process is gone", async () => {
    const { store } = await project();
    const gone = otherProcess(10);
    await gone.exited;
    writeLock(store.dir, { pid: gone.pid });
    const got = ProjectLock.acquire(store.dir, { role: "capture", app: "cli" });
    expect("lock" in got).toBe(true);
    expect(readLock(store.dir)?.pid).toBe(process.pid);
    if ("lock" in got) got.lock.release();
  });

  it("leaves a live process's lock alone, and a lock it lost to another process", async () => {
    const { store } = await project();
    const other = otherProcess(5_000);
    cleanups.push(() => void other.kill());
    writeLock(store.dir, { pid: other.pid });
    expect(ProjectLock.acquire(store.dir, { role: "server", app: "desktop" })).toMatchObject({ held: { pid: other.pid } });
  });

  it("keeps the lock out of git, once", async () => {
    const { store } = await project();
    ignoreLockInGit(store.dir);
    ignoreLockInGit(store.dir);
    const gi = readFileSync(join(store.dir, ".gitignore"), "utf8");
    expect(gi.match(/^\.lock\*$/gm)).toHaveLength(1);
  });
});

describe("coordinator", () => {
  it("one server per project: a second one is pointed at the first", async () => {
    const { store } = await project();
    const first = await hostProject(store, { app: "cli", port: 4471, server: {} });
    expect(first.kind).toBe("owner");
    if (first.kind !== "owner") return;
    cleanups.push(() => first.server.close());
    expect(readLock(store.dir)).toMatchObject({ role: "server", app: "cli", port: first.server.port });

    const second = await hostProject(store, { app: "desktop", port: 4471, server: {} });
    expect(second).toMatchObject({ kind: "running", owner: { app: "cli", url: `http://127.0.0.1:${first.server.port}/` } });

    await first.server.close();
    cleanups.pop();
    expect(readLock(store.dir)).toBeNull();
    expect(await findOwner(store, 4471)).toBeNull();
  });

  it("a server waits for a one-off capture to finish before it takes the project", async () => {
    const { store } = await project();
    const capture = otherProcess(1200);
    writeLock(store.dir, { pid: capture.pid, role: "capture" });
    let waited = false;
    const hosted = await hostProject(store, { app: "cli", port: 4481, server: {}, onWait: () => (waited = true) });
    expect(waited).toBe(true);
    expect(hosted.kind).toBe("owner");
    if (hosted.kind === "owner") await hosted.server.close();
  });

  it("scribui capture and MCP hand their capture to the running server, which queues it", async () => {
    const { store } = await project();
    const triggers: string[] = [];
    const runner: CaptureRunner = async (req, report) => {
      triggers.push(String(req.trigger));
      report({ total: 1, done: 0, current: "cart" });
      await new Promise((r) => setTimeout(r, 300));
      return { round: 2, summary: "1 captured", failed: [], ok: ["cart"], reused: ["checkout-default"] };
    };
    const hosted = await hostProject(store, { app: "desktop", port: 4491, server: { runner } });
    if (hosted.kind !== "owner") throw new Error("expected to own the project");
    cleanups.push(() => hosted.server.close());

    const handedTo: string[] = [];
    const [a, b] = await Promise.all([
      captureProject(store, { app: "cli", port: 4491, onHandOver: (o) => handedTo.push(o.app) }),
      captureProject(store, { app: "mcp", port: 4491 }),
    ]);
    expect(handedTo).toEqual(["desktop"]);
    expect(a).toMatchObject({ via: "server", result: { round: 2, ok: ["cart"], reused: ["checkout-default"] } });
    expect(b.via).toBe("server");
    // one at a time, in order: the second waited for the first instead of being refused
    expect(triggers.sort()).toEqual(["cli", "mcp"]);
  });

  it("with no server, a one-off capture holds the lock, and waits for another one", async () => {
    const { store } = await project();
    const other = otherProcess(5_000);
    cleanups.push(() => void other.kill());
    writeLock(store.dir, { pid: other.pid, role: "capture", app: "mcp" });
    const waits: string[] = [];
    await expect(captureProject(store, { app: "cli", port: 4501, waitLimitMs: 600, onWait: (o) => waits.push(o.app) })).rejects.toThrow(/busy/);
    expect(waits).toEqual(["mcp"]);
  });
});

describe("views captured by hand", () => {
  const png = readFileSync(join(F, "web/checkout/screens/cart.png"));
  const raw = { type: "screen", bounds: { x: 0, y: 0, w: 780, h: 1688 }, children: [{ type: "button", id: "pay", label: "Pay", bounds: { x: 40, y: 1500, w: 700, h: 100 }, children: [] }] };
  const device = { name: "Chrome 390×844", width: 390, height: 844, scale: 2 };

  it("web: added to the open round, url kept relative to the app", async () => {
    const { store, n } = await project();
    const r = await saveCapturedView(store, { platform: "web", url: "http://127.0.0.1:5178/cart?step=2", title: "Cart, logged in", device, png, raw });
    expect(r).toEqual({ round: n, screenId: "cart-logged-in", title: "Cart, logged in" });
    const m = await store.readManifest();
    expect(m.screens.find((s) => s.id === "cart-logged-in")).toMatchObject({ url: "/cart?step=2", live: true, group: "Captured" });
    expect(existsSync(join(store.roundDir(n), "screens/cart-logged-in.png"))).toBe(true);
    expect((await store.readCapture(n, "cart-logged-in"))?.root.children[0]?.id).toBe("pay");
  });

  it("android: the first capture into a new project starts round 1, then a second adds to it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scribui-handfirst-"));
    const store = new ReviewStore(dir);
    await store.init({ platform: "android", appId: "com.example.shop" });
    const phone = { name: "Pixel 9a", width: 412, height: 915, scale: 2.625 };
    const a = await saveCapturedView(store, { platform: "android", title: "Booking", device: phone, png, raw, orientation: "portrait" });
    expect(a).toEqual({ round: 1, screenId: "booking", title: "Booking" });
    const b = await saveCapturedView(store, { platform: "android", title: "Booking, time picked", device: phone, png, raw, orientation: "portrait" });
    expect(b.round).toBe(1);
    const m = await store.readManifest();
    expect(m.screens.map((x) => x.id)).toEqual(["booking", "booking-time-picked"]);
    expect(m.screens[0]).toMatchObject({ live: true, device: "Pixel 9a", orientation: "portrait" });
  });

  it("refuses a view from another platform", async () => {
    const { store } = await project();
    await expect(saveCapturedView(store, { platform: "android", device, png, raw })).rejects.toThrow(/web app/);
  });

  it("through the server: POST /api/views goes through the queue", async () => {
    const { store, n } = await project();
    const hosted = await hostProject(store, { app: "cli", port: 4511, server: { saveView: (req) => saveCapturedView(store, req) } });
    if (hosted.kind !== "owner") throw new Error("expected to own the project");
    cleanups.push(() => hosted.server.close());
    const r = await fetch(`http://127.0.0.1:${hosted.server.port}/api/views`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: "web", url: "http://127.0.0.1:5178/thanks", device, png: png.toString("base64"), tree: raw }),
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ round: n, screenId: "thanks", title: "/thanks" });
  });
});

describe("Android and iOS", () => {
  it("never capture on their own: rounds are refused with where to capture instead", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scribui-byhand-"));
    const store = new ReviewStore(dir);
    await store.init({ platform: "android", appId: "com.example.shop" });
    await expect(captureRound(store)).rejects.toThrow(/captured by hand/);
  });
});
