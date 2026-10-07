import { describe, expect, it } from "vitest";
import {
  decodePng,
  encodePng,
  HID_USAGE,
  NalGrouper,
  parseDeviceProfile,
  parseIdb,
  parseSimctlDevices,
  rotatePixels,
  simulatorDevices,
  toPortraitPoints,
  turnFor,
  uiOrientation,
} from "../src/index.js";

/** `xcrun simctl list devices -j` (trimmed): two runtimes, a watch, an unavailable device. */
const SIMCTL = JSON.stringify({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-18-2": [
      { udid: "A1", name: "iPhone 16", state: "Shutdown", isAvailable: true, deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16" },
      { udid: "A2", name: "iPhone 16e", state: "Shutdown", isAvailable: false },
    ],
    "com.apple.CoreSimulator.SimRuntime.iOS-26-3": [
      { udid: "B1", name: "iPhone 17", state: "Booted", isAvailable: true, deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17" },
      { udid: "B2", name: "iPhone 16", state: "Shutdown", isAvailable: true },
      { udid: "B3", name: "iPad Air 11-inch (M3)", state: "Booting", isAvailable: true },
    ],
    "com.apple.CoreSimulator.SimRuntime.watchOS-26-0": [{ udid: "W1", name: "Apple Watch Series 11", state: "Booted", isAvailable: true }],
  },
});

describe("iOS simulators", () => {
  it("lists available iOS simulators only", () => {
    const sims = parseSimctlDevices(SIMCTL);
    expect(sims.map((s) => s.udid)).toEqual(["A1", "B1", "B2", "B3"]);
    expect(sims[1]).toEqual({ udid: "B1", name: "iPhone 17", state: "Booted", runtime: "iOS 26.3", deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17" });
  });

  it("shows booted ones, offers shut-down ones newest iOS first, and names twins by version", () => {
    const { devices, startable } = simulatorDevices(parseSimctlDevices(SIMCTL));
    expect(devices).toEqual([
      { id: "B3", name: "iPad Air 11-inch (M3)", kind: "simulator", state: "booting" },
      { id: "B1", name: "iPhone 17", kind: "simulator", state: "ready" },
    ]);
    expect(startable).toEqual([
      { id: "B2", name: "iPhone 16 (iOS 26.3)" },
      { id: "A1", name: "iPhone 16 (iOS 18.2)" },
    ]);
  });

  it("reads the screen from a device type's profile", () => {
    expect(parseDeviceProfile(JSON.stringify({ mainScreenWidth: 1206, mainScreenHeight: 2622, mainScreenScale: 3 }))).toEqual({ width: 1206, height: 2622, scale: 3 });
    // iPads list their screen landscape
    expect(parseDeviceProfile(JSON.stringify({ mainScreenWidth: 2420, mainScreenHeight: 1668, mainScreenScale: 2 }))).toEqual({ width: 1668, height: 2420, scale: 2 });
    expect(parseDeviceProfile(JSON.stringify({ mainScreenScale: 3 }))).toBeNull();
  });
});

describe("a turned simulator screen", () => {
  const portrait = { width: 402, height: 874 };

  it("turns the portrait framebuffer upright", () => {
    expect([turnFor("portrait"), turnFor("landscapeLeft"), turnFor("landscapeRight"), turnFor("portraitUpsideDown")]).toEqual([0, 90, 270, 180]);
  });

  it("maps a point on the upright screen to the HID's portrait points", () => {
    expect(toPortraitPoints({ x: 0.5, y: 0.25 }, "portrait", portrait)).toEqual({ x: 201, y: 218.5 });
    // landscape left (measured: Safari's address field at landscape 437,32 was hit at portrait 32,437)
    expect(toPortraitPoints({ x: 437 / 874, y: 32 / 402 }, "landscapeLeft", portrait)).toEqual({ x: 32, y: 437 });
    expect(toPortraitPoints({ x: 437 / 874, y: 32 / 402 }, "landscapeRight", portrait)).toEqual({ x: 370, y: 437 });
    expect(toPortraitPoints({ x: 0, y: 0 }, "portraitUpsideDown", portrait)).toEqual({ x: 402, y: 874 });
    expect(toPortraitPoints({ x: Number.NaN, y: 2 }, "portrait", portrait)).toEqual({ x: 0, y: 874 });
  });

  it("reads the UI's orientation from the frontmost app's frame", () => {
    expect(uiOrientation({ width: 402, height: 874 }, "landscapeLeft")).toBe("portrait"); // the app stayed upright
    expect(uiOrientation({ width: 874, height: 402 }, "landscapeRight")).toBe("landscapeRight");
    expect(uiOrientation({ width: 874, height: 402 }, "portrait")).toBe("landscapeLeft"); // a landscape-only app
    expect(uiOrientation(null, "landscapeLeft")).toBe("landscapeLeft");
  });

  it("reads elements whose value is a number (scroll bars)", () => {
    const tree = JSON.stringify([{ type: "Application", frame: { x: 0, y: 0, width: 402, height: 874 }, children: [{ type: "Slider", AXValue: 0.5, frame: { x: 1, y: 2, width: 3, height: 4 }, children: [] }] }]);
    expect(parseIdb(tree, 1).children[0]).toMatchObject({ type: "slider", label: "0.5" });
  });

  it("places a landscape tree on the turned screenshot", () => {
    // what the tree says in landscape (points) and where the turned screenshot has it (pixels, ×3)
    const tree = JSON.stringify([
      { type: "Application", AXLabel: "Safari", frame: { x: 0, y: 0, width: 874, height: 402 }, children: [{ type: "Button", AXLabel: "magenta probe", frame: { x: 102, y: 269, width: 120, height: 60 }, children: [] }] },
    ]);
    const raw = parseIdb(tree, 3);
    expect(raw.bounds).toEqual({ x: 0, y: 0, w: 2622, h: 1206 });
    expect(raw.children[0]!.bounds).toEqual({ x: 306, y: 807, w: 360, h: 180 });
  });
});

describe("PNG turning", () => {
  // 3×2 RGB: each pixel's red is its index
  const img = { width: 3, height: 2, channels: 3 as const, data: Uint8Array.from([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 0, 0, 5, 0, 0]), hasColourProfile: false };
  const reds = (i: { data: Uint8Array; channels: number }) => [...i.data].filter((_, k) => k % i.channels === 0);

  it("turns clockwise", () => {
    const r = rotatePixels(img, 90);
    expect([r.width, r.height]).toEqual([2, 3]);
    // 0 1 2      3 0
    // 3 4 5  →   4 1
    //            5 2
    expect(reds(r)).toEqual([3, 0, 4, 1, 5, 2]);
    expect(reds(rotatePixels(img, 270))).toEqual([2, 5, 1, 4, 0, 3]);
    expect(reds(rotatePixels(img, 180))).toEqual([5, 4, 3, 2, 1, 0]);
    expect(rotatePixels(img, 0)).toBe(img);
  });

  it("writes PNGs that read back the same, marked sRGB", () => {
    const png = encodePng(rotatePixels(img, 90));
    const back = decodePng(png);
    expect([back.width, back.height, back.channels, back.hasColourProfile]).toEqual([2, 3, 3, false]);
    expect(reds(back)).toEqual([3, 0, 4, 1, 5, 2]);
    expect(png.includes(Buffer.from("sRGB"))).toBe(true);
  });
});

describe("the simulator's H.264 stream", () => {
  const nal = (type: number, ...rest: number[]) => Buffer.from([0, 0, 0, 1, type, ...rest]);

  it("makes decoder packets from single NAL units", () => {
    const g = new NalGrouper();
    expect(g.push(nal(0x27, 0x64, 0x00, 0x1f))).toBeNull(); // SPS waits for its PPS
    const config = g.push(nal(0x28, 0xee))!;
    expect(config).toMatchObject({ config: true, key: false, codec: "avc1.64001f" });
    expect(config.data.length).toBe(8 + 6);
    expect(g.push(nal(0x06, 1))).toBeNull(); // SEI goes in front of the next picture
    const key = g.push(nal(0x25, 0xb8))!;
    expect(key).toMatchObject({ config: false, key: true });
    expect(key.data.length).toBe(6 + 6);
    expect(g.push(nal(0x21, 0xe0))).toMatchObject({ config: false, key: false });
  });
});

describe("typing on the simulator", () => {
  it("sends physical keys as HID usages", () => {
    expect([HID_USAGE.KeyA, HID_USAGE.KeyZ, HID_USAGE.Digit1, HID_USAGE.Digit0, HID_USAGE.Space, HID_USAGE.Slash]).toEqual([4, 29, 30, 39, 44, 56]);
    expect(HID_USAGE.F1).toBeUndefined();
  });
});
