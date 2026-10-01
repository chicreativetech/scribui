import type { Platform } from "@intentcue/core";
import { AndroidAdapter } from "./adapters/android.js";
import { IosAdapter } from "./adapters/ios.js";
import { WebAdapter } from "./adapters/web.js";
import type { CaptureAdapter, CaptureContext } from "./types.js";

export * from "./types.js";
export { CaptureError, run, which } from "./exec.js";
export { pngSize } from "./png.js";
export * from "./tools.js";
export { parseIdb, buildByContainment } from "./parsers/idb.js";
export { parseMaestro } from "./parsers/maestro.js";
export { parseUiautomator } from "./parsers/uiautomator.js";
export { iosType, androidType } from "./parsers/typeMaps.js";
export { toCapture } from "./adapters/shared.js";
export { IosAdapter, AndroidAdapter, WebAdapter };

export function createAdapter(platform: Platform, ctx: CaptureContext): CaptureAdapter {
  switch (platform) {
    case "ios":
      return new IosAdapter(ctx);
    case "android":
      return new AndroidAdapter(ctx);
    case "web":
      return new WebAdapter(ctx);
  }
}
