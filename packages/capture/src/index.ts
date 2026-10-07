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
export { decodePng, encodePng, pixelDifference, rotatePixels, type DecodedPng } from "./png.js";
export { ScrcpySession, SCRCPY_VERSION, SCRCPY_SERVER_SHA256, MotionAction, KeyAction, Keycode, avcCodecString, type VideoPacket, type VideoSession } from "./live/scrcpy.js";
export { captureAndroidLive, dumpTree, readKeyboard, readRotation, type AndroidLiveCapture, type AndroidCaptureStep } from "./live/androidCapture.js";
export { addKeyboard, parseInputShown, parseKeyboardFrame, parseRotation } from "./live/androidScreen.js";
export { AndroidTarget, chunkText, parseAdbDevices, parseWm, type AndroidTargetOptions } from "./live/android.js";
export * from "./live/session.js";
export { IosTarget, bootSimulatorHeadless, listSimulatorsLive, listSimulatorsOrWhy, type IosTargetOptions } from "./live/ios.js";
export { captureIosLive, simScreenshot, type IosLiveCapture } from "./live/iosCapture.js";
export { HID_USAGE, parseDeviceProfile, parseSimctlDevices, simulatorDevices, toPortraitPoints, turnFor, uiOrientation, type SimOrientation } from "./live/iosScreen.js";
export { NalGrouper, SimHelper } from "./live/simHelper.js";
export { installEnv, installPlan, runInstall, RUNTIME_DIR, TOOLS_DIR, PLATFORM_TOOLS_TERMS, type InstallableTool, type InstallEnv, type InstallPlan, type InstallStep } from "./install.js";
export { extractZip, readZip } from "./zip.js";
