import type { RawElement } from "@intentcue/core";
import { androidType, iosType } from "./typeMaps.js";
import { parseBoundsPair } from "./uiautomator.js";

type MaestroNode = {
  attributes?: Record<string, string | undefined>;
  children?: MaestroNode[];
  clickable?: boolean;
  enabled?: boolean;
};

/**
 * Parse `maestro hierarchy` JSON. On iOS bounds are points (pass the
 * screenshot scale); on Android they are pixels (scale 1).
 */
export function parseMaestro(output: string, platform: "ios" | "android", scale: number): RawElement {
  const start = output.indexOf("{");
  if (start < 0) throw new Error("maestro hierarchy: no JSON in output");
  const node = JSON.parse(output.slice(start)) as MaestroNode;
  const root = toRaw(node, platform, scale);
  if (root.bounds.w === 0 || root.bounds.h === 0) {
    let w = 0;
    let h = 0;
    for (const c of root.children) {
      w = Math.max(w, c.bounds.x + c.bounds.w);
      h = Math.max(h, c.bounds.y + c.bounds.h);
    }
    root.bounds = { x: 0, y: 0, w, h };
  }
  return { ...root, type: "screen" };
}

function toRaw(n: MaestroNode, platform: "ios" | "android", scale: number): RawElement {
  const a = n.attributes ?? {};
  const b = parseBoundsPair(a["bounds"]);
  const native = a["elementType"] ?? a["class"] ?? a["type"];
  const children = (n.children ?? []).map((c) => toRaw(c, platform, scale));
  const text = (a["text"] || a["title"] || a["value"] || "").trim();
  const accText = (a["accessibilityText"] || a["hintText"] || "").trim();
  const clickable = n.clickable ?? a["clickable"] === "true";

  let type: string;
  if (platform === "android") type = androidType(native, { clickable });
  else if (native) type = iosType(isNaN(Number(native)) ? native : iosElementTypeByNumber(Number(native)));
  else type = children.length === 0 && (text || accText) ? (clickable ? "button" : "text") : "container";

  const el: RawElement = {
    type,
    bounds: { x: b.x * scale, y: b.y * scale, w: b.w * scale, h: b.h * scale },
    children,
  };
  if (native) el.nativeType = native;
  const rawId = a["resource-id"] ?? a["identifier"] ?? "";
  const id = rawId.includes(":id/") ? rawId.slice(rawId.indexOf(":id/") + 4) : rawId;
  if (id) {
    el.id = id;
    el.idSource = platform === "ios" ? "accessibility" : "testId";
  }
  const label = accText || text;
  if (label) el.label = label;
  if (a["visible"] === "false") el.visible = false;
  return el;
}

/** XCUIElement.ElementType raw values, as emitted by some Maestro versions. */
function iosElementTypeByNumber(n: number): string {
  const t: Record<number, string> = {
    2: "Application", 4: "Window", 9: "Button", 12: "Toggle", 14: "SegmentedControl", 15: "Picker",
    21: "PageIndicator", 25: "Switch", 26: "Slider", 30: "Tab", 35: "TabBar", 43: "Image", 44: "Icon",
    45: "SearchField", 46: "ScrollView", 48: "StaticText", 49: "TextField", 50: "SecureTextField",
    52: "TextView", 54: "Table", 55: "Cell", 56: "Other", 57: "Link", 61: "NavigationBar",
    64: "Toolbar", 75: "CollectionView", 1: "Other",
  };
  return t[n] ?? "Other";
}
