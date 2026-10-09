import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReviewStore } from "@scribui/server";
import { folderName, projectName, renameGenericProject } from "../src/detect.js";

const dir = (...parts: string[]) => {
  const d = join(mkdtempSync(join(tmpdir(), "scribui-name-")), ...parts);
  mkdirSync(d, { recursive: true });
  return d;
};

describe("project name", () => {
  it("prefers package.json, without its scope", () => {
    expect(projectName(dir("x"), "@acme/shop")).toBe("shop");
  });

  it("reads the Xcode project's name, skipping template names", () => {
    const ios = dir("shelfkeep", "ios");
    mkdirSync(join(ios, "ShelfKeep.xcodeproj"));
    expect(projectName(ios)).toBe("ShelfKeep");
    const flutter = dir("birds");
    mkdirSync(join(flutter, "ios", "Runner.xcodeproj"), { recursive: true });
    expect(projectName(flutter)).toBe("birds");
  });

  it("reads Gradle's root project name", () => {
    const android = dir("notes", "android");
    writeFileSync(join(android, "settings.gradle.kts"), 'rootProject.name = "Notes Pro"\ninclude(":app")\n');
    expect(projectName(android)).toBe("Notes Pro");
  });

  it("names a folder like ios or android after the folder above", () => {
    expect(folderName("/Users/me/shelfkeep/ios")).toBe("shelfkeep");
    expect(folderName("/Users/me/shelfkeep")).toBe("shelfkeep");
  });

  it("renames a project that was named after its ios folder, and leaves chosen names alone", async () => {
    const ios = dir("shelfkeep", "ios");
    mkdirSync(join(ios, "ShelfKeep.xcodeproj"));
    const store = new ReviewStore(ios);
    await store.init({ platform: "ios" });
    expect((await store.readManifest()).app.name).toBe("ios");
    await renameGenericProject(store);
    expect((await store.readManifest()).app.name).toBe("ShelfKeep");
    // still the starter: the rename isn't the agent filling it in
    expect(await store.isStarterManifest()).toBe(true);

    await store.updateApp({ name: "My Shelf" });
    await renameGenericProject(store);
    expect((await store.readManifest()).app.name).toBe("My Shelf");
  });
});
