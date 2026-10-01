// Turn one screenshot plus a hierarchy dump into a ScreenCapture (M1).
//
//   tsx packages/capture/scripts/manual-capture.ts \
//     --platform ios --format idb --screenshot shot.png --tree dump.json --id checkout > capture.json
//
// --format: idb | maestro | uiautomator (default: idb for ios, uiautomator for android)
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ScreenCapture } from "@intentcue/core";
import { parseIdb, parseMaestro, parseUiautomator, pngSize, toCapture } from "../src/index.js";

const { values } = parseArgs({
  options: {
    platform: { type: "string", default: "ios" },
    format: { type: "string" },
    screenshot: { type: "string" },
    tree: { type: "string" },
    id: { type: "string", default: "screen" },
    title: { type: "string" },
    scale: { type: "string" },
  },
});
if (!values.screenshot || !values.tree) {
  console.error("usage: manual-capture --platform ios|android --screenshot shot.png --tree dump.(json|xml) [--format idb|maestro|uiautomator] [--id id]");
  process.exit(1);
}
const platform = values.platform as "ios" | "android";
const png = readFileSync(values.screenshot);
const px = pngSize(png);
const dump = readFileSync(values.tree, "utf8");
const format = values.format ?? (platform === "ios" ? "idb" : "uiautomator");

let raw;
let scale: number;
if (format === "uiautomator") {
  raw = parseUiautomator(dump);
  scale = Number(values.scale ?? 1) || 1;
} else {
  const probe = format === "idb" ? parseIdb(dump, 1) : parseMaestro(dump, platform, 1);
  scale = Number(values.scale ?? (platform === "ios" ? px.width / (probe.bounds.w || px.width) : 1));
  raw = format === "idb" ? parseIdb(dump, scale) : parseMaestro(dump, platform, scale);
}
const screen = { id: values.id!, title: values.title ?? values.id! };
const device = { name: "manual", width: Math.round(px.width / scale), height: Math.round(px.height / scale), scale };
const capture = ScreenCapture.parse(toCapture(screen, platform, device, values.screenshot, raw, px));
process.stdout.write(JSON.stringify(capture, null, 2) + "\n");
