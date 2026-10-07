import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { desktopOpenUrl } from "@scribui/core";
import { findOpenUrl, parseOpenUrl } from "../src/openUrl.js";
import { RecentProjects } from "../src/recent.js";
import { mergePath } from "../src/shellPath.js";

describe("scribui:// links", () => {
  it("round-trips a project folder, spaces and non-ASCII included", () => {
    for (const dir of ["/Users/me/my app", "/home/ö/proj?x=1&y", "/tmp/100%"]) expect(parseOpenUrl(desktopOpenUrl(dir))).toBe(dir);
  });

  it("accepts Windows paths on Windows", () => {
    const dir = "C:\\Users\\me\\proj";
    expect(parseOpenUrl(desktopOpenUrl(dir), win32.isAbsolute)).toBe(dir);
  });

  it("refuses anything but opening an absolute folder", () => {
    expect(parseOpenUrl("scribui://open?dir=relative/path")).toBeNull();
    expect(parseOpenUrl("scribui://open")).toBeNull();
    expect(parseOpenUrl("scribui://capture?dir=/tmp/x")).toBeNull();
    expect(parseOpenUrl("https://open?dir=/tmp/x")).toBeNull();
    expect(parseOpenUrl("scribui://open?dir=/tmp/x%00y")).toBeNull();
    expect(parseOpenUrl("not a url")).toBeNull();
  });

  it("finds the link among a launch's arguments", () => {
    expect(findOpenUrl(["/app/ScribUI", "--force-color-profile=srgb", desktopOpenUrl("/p")])).toBe("/p");
    expect(findOpenUrl(["/app/ScribUI", "--project=/p"])).toBeNull();
  });
});

describe("RecentProjects", () => {
  const fresh = () => new RecentProjects(join(mkdtempSync(join(tmpdir(), "scribui-recent-")), "sub", "recent.json"));

  it("keeps the newest first, without duplicates", () => {
    const r = fresh();
    r.add({ dir: "/a", name: "A", platform: "web" }, new Date(1000));
    r.add({ dir: "/b", name: "B", platform: "android" }, new Date(2000));
    r.add({ dir: "/a", name: "A2", platform: "web" }, new Date(3000));
    expect(r.list().map((p) => [p.dir, p.name])).toEqual([
      ["/a", "A2"],
      ["/b", "B"],
    ]);
    r.remove("/a");
    expect(r.list().map((p) => p.dir)).toEqual(["/b"]);
  });

  it("keeps at most 20", () => {
    const r = fresh();
    for (let i = 0; i < 25; i++) r.add({ dir: `/p${i}`, name: `p${i}`, platform: null });
    expect(r.list()).toHaveLength(20);
    expect(r.list()[0]!.dir).toBe("/p24");
  });

  it("reads a broken file as empty", () => {
    const file = join(mkdtempSync(join(tmpdir(), "scribui-recent-")), "recent.json");
    writeFileSync(file, "{not json");
    expect(new RecentProjects(file).list()).toEqual([]);
  });
});

describe("mergePath", () => {
  it("puts the shell's entries first and drops duplicates", () => {
    expect(mergePath("/opt/homebrew/bin:/usr/bin", "/usr/bin:/bin")).toBe("/opt/homebrew/bin:/usr/bin:/bin");
  });
});
