import type { Platform } from "@scribui/core";
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
export { toCapture, writePng } from "./adapters/shared.js";
export { IosAdapter, AndroidAdapter, WebAdapter };
export { readLiveFrame, loadChromium, LIVE_ISOLATE, LIVE_RESTORE } from "./adapters/web.js";

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
export { decodePng, pixelDifference, type DecodedPng } from "./png.js";
export { ScrcpySession, SCRCPY_VERSION, MotionAction, KeyAction, Keycode, avcCodecString, type VideoPacket, type VideoSession } from "./live/scrcpy.js";
export { captureAndroidLive, dumpTree, type AndroidLiveCapture, type AndroidCaptureStep } from "./live/androidCapture.js";
