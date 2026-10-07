import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReviewStore } from "@scribui/server";
import { checkAnswers, normalizeUrl, screensState, setupInfo } from "../src/setup.js";

describe("setup", () => {
  it("normalizes ports and URLs", () => {
    expect(normalizeUrl("3000")).toBe("http://localhost:3000");
    expect(normalizeUrl("localhost:5173/")).toBe("http://localhost:5173");
    expect(normalizeUrl("https://app.test/base/")).toBe("https://app.test/base");
    expect(normalizeUrl("99999")).toBeNull();
    expect(normalizeUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
  });

  it("checks the window's answers", () => {
    expect(checkAnswers({ platform: "web", baseUrl: "3000" })).toEqual({ ok: true, answers: { platform: "web", baseUrl: "http://localhost:3000" } });
    expect(checkAnswers({ platform: "ios" }, "linux").ok).toBe(false);
    expect(checkAnswers({ platform: "android", appId: "not an id" }).ok).toBe(false);
    expect(checkAnswers({ platform: "android", build: "a\nrm -rf /" }).ok).toBe(false);
    expect(checkAnswers({ platform: "android", appId: "com.example.app", build: " ./gradlew installDebug " })).toEqual({
      ok: true,
      answers: { platform: "android", appId: "com.example.app", build: "./gradlew installDebug" },
    });
    expect(checkAnswers({ platform: "desktop" }).ok).toBe(false);
  });

  it("warns about the home folder and folders without app files", () => {
    expect(setupInfo(homedir()).warning).toMatch(/home folder/);
    expect(setupInfo(mkdtempSync(join(tmpdir(), "scribui-empty-"))).warning).toMatch(/No app files/);
    const web = mkdtempSync(join(tmpdir(), "scribui-web-"));
    writeFileSync(join(web, "package.json"), JSON.stringify({ name: "shop" }));
    expect(setupInfo(web)).toMatchObject({ name: "shop", detected: "web", warning: null });
  });

  it("follows screens.json from starter to listed or invalid", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scribui-setup-"));
    const store = new ReviewStore(dir);
    await store.init({ platform: "android", name: "app", appId: "com.example.app" });
    expect(await screensState(store)).toEqual({ state: "starter" });
    const m = JSON.parse(await (await import("node:fs/promises")).readFile(store.path("screens.json"), "utf8"));
    writeFileSync(store.path("screens.json"), JSON.stringify({ ...m, screens: m.screens.slice(0, 1) }));
    expect(await screensState(store)).toEqual({ state: "listed", count: 1 });
    writeFileSync(store.path("screens.json"), JSON.stringify({ version: 1, app: {}, screens: [] }));
    expect((await screensState(store)).state).toBe("invalid");
  });
});
