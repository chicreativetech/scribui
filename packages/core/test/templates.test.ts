import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { androidFlowHelper, androidFlowScript, screensGuide, screensPrompt, starterManifest, ScreenManifest } from "../src/index.js";

describe("templates", () => {
  it("the generated Android helper is valid JavaScript", () => {
    const dir = mkdtempSync(join(tmpdir(), "intentcue-tpl-"));
    const f = join(dir, "adb.mjs");
    writeFileSync(f, androidFlowHelper("com.example.app"));
    expect(() => execFileSync(process.execPath, ["--check", f])).not.toThrow();
  });

  it("flow scripts call the helper in order", () => {
    expect(androidFlowScript(["Shop", 'Say "hi"'])).toContain('node adb.mjs launch\nnode adb.mjs tap "Shop"\nnode adb.mjs tap "Say \\"hi\\""');
  });

  it("starter manifests are valid for every platform", () => {
    for (const p of ["web", "android", "ios"] as const) expect(ScreenManifest.safeParse(starterManifest(p, "App")).success).toBe(true);
  });

  it("guides and prompts mention the right things", () => {
    expect(screensGuide("android")).toContain("node adb.mjs tap");
    expect(screensGuide("web", { baseUrl: "http://localhost:5173" })).toContain("http://localhost:5173");
    expect(screensPrompt("web", "http://localhost:5173")).toContain("The app runs at http://localhost:5173.");
  });
});
