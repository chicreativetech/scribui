import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeTree, TreeIndex, type UIElement } from "@scribui/core";
import { androidType, iosType, parseIdb, parseMaestro, parseUiautomator, pngSize } from "../src/index.js";

const F = join(import.meta.dirname, "../../../fixtures");
const read = (p: string) => readFileSync(join(F, p), "utf8");
const ids = (t: UIElement) => new TreeIndex(t).all.map((f) => f.el.id);
const find = (t: UIElement, id: string) => new TreeIndex(t).get(id);

describe("idb (iOS)", () => {
  it("builds a tree from the flat list and converts points to pixels", () => {
    const t = normalizeTree(parseIdb(read("ios/idb-checkout.json"), 3));
    expect(t.type).toBe("screen");
    expect(t.bounds).toEqual({ x: 0, y: 0, w: 1179, h: 2556 });
    const pay = find(t, "payButton")!;
    expect(pay).toMatchObject({ type: "button", label: "Pay now", idSource: "accessibility", nativeType: "Button" });
    expect(pay.bounds).toEqual({ x: 48, y: 2100, w: 1083, h: 150 });
    // containment: the name field sits inside the shipping form
    expect(find(t, "shippingForm")!.children.map((c) => c.id)).toContain("nameField");
  });

  it("drops zero-size elements and de-duplicates repeated ids", () => {
    const t = normalizeTree(parseIdb(read("ios/idb-settings.json"), 3));
    const all = ids(t);
    expect(all.filter((i) => i.startsWith("settingsRow"))).toEqual(["settingsRow", "settingsRow#2", "settingsRow#3"]);
    expect(all.some((i) => i.includes("hidden-icon"))).toBe(false);
    expect(find(t, "wifiSwitch")!.type).toBe("toggle");
  });

  it("reads --nested output and collapses identical wrappers", () => {
    const t = normalizeTree(parseIdb(read("ios/idb-login-nested.json"), 3));
    // Application > Window > Other all span the screen and collapse into the root
    expect(t.children.map((c) => c.id)).toEqual(["logo", expect.stringContaining("welcome-back"), "emailField", "passwordField", "loginButton", "forgotLink"]);
    expect(find(t, "passwordField")!.type).toBe("input");
    expect(find(t, "forgotLink")!.type).toBe("link");
  });

  it("maps XCUIElement types", () => {
    expect(iosType("XCUIElementTypeButton")).toBe("button");
    expect(iosType("StaticText")).toBe("text");
    expect(iosType("Mystery")).toBe("other");
  });
});

describe("uiautomator (Android)", () => {
  it("parses nodes, strips package prefixes from resource ids", () => {
    const t = normalizeTree(parseUiautomator(read("android/uiautomator-checkout.xml")));
    expect(t.bounds).toEqual({ x: 0, y: 0, w: 1080, h: 2400 });
    expect(find(t, "pay_button")).toMatchObject({ type: "button", label: "Pay now", idSource: "testId" });
    expect(find(t, "name_input")!.type).toBe("input");
    expect(find(t, "promo_banner")!.bounds).toEqual({ x: 42, y: 252, w: 996, h: 168 });
  });

  it("uses content-desc as label and decodes entities", () => {
    const t = normalizeTree(parseUiautomator(read("android/uiautomator-settings.xml")));
    const labels = new TreeIndex(t).all.map((f) => f.el.label).filter(Boolean);
    expect(labels).toContain("Network & internet");
    expect(labels).toContain("Bluetooth");
  });

  it("handles Compose test tags and clickable views", () => {
    const t = normalizeTree(parseUiautomator(read("android/uiautomator-compose.xml")));
    expect(find(t, "loginButton")!.type).toBe("button");
    expect(find(t, "title")!.label).toBe("Welcome back");
    expect(androidType("android.view.View", { clickable: true })).toBe("button");
  });
});

describe("maestro hierarchy", () => {
  it("parses iOS output with log lines and numeric element types", () => {
    const t = normalizeTree(parseMaestro(read("maestro/ios-checkout-hierarchy.json"), "ios", 3));
    expect(find(t, "payButton")).toMatchObject({ type: "button", idSource: "accessibility", label: "Pay now" });
    expect(find(t, "payButton")!.bounds).toEqual({ x: 48, y: 2100, w: 1083, h: 150 });
    expect(find(t, "totalValue")!.type).toBe("text");
  });
});

describe("png", () => {
  it("reads PNG dimensions", () => {
    expect(pngSize(readFileSync(join(F, "web/checkout/screens/cart.png")))).toEqual({ width: 780, height: 1688 });
    expect(() => pngSize(new Uint8Array(30))).toThrow();
  });
});
