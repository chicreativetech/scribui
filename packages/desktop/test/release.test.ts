import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script, no types
import { dateSection, notesFor } from "../scripts/changelog.mjs";
import { crashesSince, issueUrl } from "../src/crashes.js";
import { updateMode } from "../src/updates.js";

const require = createRequire(import.meta.url);

describe("updates", () => {
  it("updates in place only where the app can replace itself", () => {
    const base = { packaged: true, appImage: false, macDeveloperId: false };
    expect(updateMode({ ...base, packaged: false, platform: "win32" })).toBeNull();
    expect(updateMode({ ...base, platform: "win32" })).toEqual({ auto: true });
    expect(updateMode({ ...base, platform: "linux", appImage: true })).toEqual({ auto: true });
    expect(updateMode({ ...base, platform: "linux" })).toMatchObject({ auto: false });
    expect(updateMode({ ...base, platform: "darwin" })).toMatchObject({ auto: false, reason: expect.stringMatching(/isn't signed/) });
    expect(updateMode({ ...base, platform: "darwin", macDeveloperId: true })).toEqual({ auto: true });
  });
});

describe("crash reports", () => {
  it("links to a prefilled issue without home folder paths", () => {
    const url = issueUrl(
      {
        version: "0.2.0",
        electron: "44.6.0",
        os: "darwin 26.0 arm64",
        records: [{ at: "2026-10-07T10:00:00Z", kind: "exception", message: "boom in /Users/me/app", stack: "Error: boom\n    at x (/Users/me/app/a.js:1:1)" }],
        dumps: 1,
      },
      "/Users/me",
    );
    const q = new URL(url).searchParams;
    expect(url.startsWith("https://github.com/chicreativetech/scribui/issues/new?")).toBe(true);
    expect(q.get("title")).toBe("Crash: boom in ~/app");
    expect(q.get("body")).toContain("ScribUI 0.2.0 · Electron 44.6.0 · darwin 26.0 arm64");
    expect(q.get("body")).toContain("1 crash dump");
    expect(q.get("body")).not.toContain("/Users/me");
  });

  it("keeps long reports within link limits", () => {
    const records = Array.from({ length: 3 }, (_, i) => ({ at: `2026-10-07T10:0${i}:00Z`, kind: "exception" as const, message: "x".repeat(3000) }));
    expect(new URL(issueUrl({ version: "1", electron: "1", os: "x", records, dumps: 0 })).searchParams.get("body")!.length).toBeLessThanOrEqual(5002);
  });

  it("only reports what happened since the last launch", () => {
    const records = [
      { at: "2026-10-07T09:00:00Z", kind: "renderer" as const, message: "old" },
      { at: "2026-10-07T11:00:00Z", kind: "renderer" as const, message: "new" },
    ];
    expect(crashesSince(records, [], Date.parse("2026-10-07T10:00:00Z"))).toEqual({ records: [records[1]], dumps: 0 });
  });
});

describe("release notes", () => {
  const log = "# Changelog\n\n## 0.2.0 (unreleased)\n\n- New thing\n\n## 0.1.0 (2026-10-01)\n\n- First\n";
  it("takes a version's section", () => {
    expect(notesFor(log, "0.2.0")).toBe("- New thing");
    expect(notesFor(log, "0.1.0")).toBe("- First");
    expect(notesFor(log, "0.1")).toBeNull();
    expect(notesFor(log, "0.3.0")).toBeNull();
  });
  it("dates the section when releasing", () => {
    expect(dateSection(log, "0.2.0", "2026-10-08")).toContain("## 0.2.0 (2026-10-08)\n\n- New thing");
  });
});

describe("packaging config", () => {
  const load = (env: Record<string, string>) => {
    const keep = { ...process.env };
    Object.assign(process.env, env);
    try {
      const path = require.resolve("../electron-builder.config.cjs");
      delete require.cache[path];
      return require(path);
    } finally {
      for (const k of Object.keys(env)) if (!(k in keep)) delete process.env[k];
    }
  };

  it("builds unsigned without secrets", () => {
    const c = load({});
    expect(c.mac).toMatchObject({ identity: "-", hardenedRuntime: false });
    expect(c.win.azureSignOptions).toBeUndefined();
    expect(c.publish[0]).toMatchObject({ provider: "github", owner: "chicreativetech", repo: "scribui" });
    expect(c.mac.target.map((t: { target: string }) => t.target)).toEqual(["dmg", "zip"]);
  });

  it("signs and notarises with the secrets", () => {
    const c = load({ CSC_LINK: "x", APPLE_ID: "a", APPLE_APP_SPECIFIC_PASSWORD: "p", APPLE_TEAM_ID: "t" });
    expect(c.mac).toMatchObject({ hardenedRuntime: true, notarize: true, entitlements: "build/entitlements.mac.plist" });
    expect(c.mac.identity).toBeUndefined();
    expect(load({ CSC_LINK: "x" }).mac.notarize).toBe(false);
    const w = load({ AZURE_TENANT_ID: "t", AZURE_CLIENT_ID: "c", AZURE_CLIENT_SECRET: "s", SCRIBUI_AZURE_ENDPOINT: "https://e", SCRIBUI_AZURE_ACCOUNT: "a", SCRIBUI_AZURE_PROFILE: "p", SCRIBUI_AZURE_PUBLISHER: "ScribUI" });
    expect(w.win.azureSignOptions).toEqual({ endpoint: "https://e", codeSigningAccountName: "a", certificateProfileName: "p", publisherName: "ScribUI" });
  });
});
