import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { desktopOpenUrl } from "@scribui/core";
import { findOpenUrl, parseOpenUrl } from "../src/openUrl.js";
import { RecentProjects } from "../src/recent.js";
import { mergePath } from "../src/shellPath.js";
import { placeWindow, readWindowState, writeWindowState } from "../src/windowState.js";

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

describe("window placement", () => {
  const screen = { x: 0, y: 25, width: 1512, height: 920 };

  it("opens maximized the first time", () => {
    expect(placeWindow({}, [screen])).toEqual({ maximized: true, fullScreen: false });
  });

  it("opens the way the last window was left", () => {
    const bounds = { x: 100, y: 80, width: 1200, height: 800 };
    expect(placeWindow({ bounds }, [screen])).toEqual({ bounds, maximized: false, fullScreen: false });
    expect(placeWindow({ bounds, maximized: true }, [screen])).toEqual({ maximized: true, fullScreen: false });
    expect(placeWindow({ bounds, fullScreen: true }, [screen]).fullScreen).toBe(true);
  });

  it("cascades further windows and keeps them on the display", () => {
    const bounds = { x: 100, y: 80, width: 1200, height: 800 };
    expect(placeWindow({ bounds }, [screen], 2).bounds).toEqual({ x: 156, y: 136, width: 1200, height: 800 });
    // near the bottom: stops at the display's edge
    expect(placeWindow({ bounds: { ...bounds, y: 130 } }, [screen], 2).bounds).toEqual({ x: 156, y: 145, width: 1200, height: 800 });
  });

  it("moves a window from an unplugged display onto one that's there, and fits it", () => {
    const p = placeWindow({ bounds: { x: 3000, y: 100, width: 2400, height: 1300 } }, [screen]);
    expect(p.bounds).toEqual({ x: 0, y: 25, width: 1512, height: 920 });
  });

  it("survives a damaged file", () => {
    const dir = mkdtempSync(join(tmpdir(), "scribui-win-"));
    writeFileSync(join(dir, "w.json"), "{nope");
    expect(placeWindow(readWindowState(join(dir, "w.json")), [screen]).maximized).toBe(true);
    writeWindowState(join(dir, "w.json"), { maximized: false, bounds: { x: 1, y: 30, width: 900, height: 700 } });
    expect(readWindowState(join(dir, "w.json")).bounds?.width).toBe(900);
  });
});
