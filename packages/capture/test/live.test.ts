import { describe, expect, it } from "vitest";
import { normalizeTree, resolveAll, TreeIndex, type RawElement } from "@scribui/core";
import { addKeyboard, chunkText, parseAdbDevices, parseInputShown, parseKeyboardFrame, parseRotation, parseWm, scalePoint } from "../src/index.js";

/** `dumpsys window InputMethod` on an API 37 emulator, keyboard up (trimmed). */
const IME_SHOWN = `WINDOW MANAGER WINDOWS (dumpsys window windows)
  Window #7 Window{a931ebe u0 InputMethod}:
    mDisplayId=0 rootTaskId=1 mSession=Session{e3b 1702:u0a10183} mClient=android.os.BinderProxy@1
    mViewVisibility=0x0 mHaveFrame=true mObscured=false
    mGivenContentInsets=[0,1399][0,0] mGivenVisibleInsets=[0,1399][0,0]
    touchable region=SkRegion((0,1541,1080,2424))
    mHasSurface=true isReadyForDisplay()=true mWindowRemovalAllowed=false
    Frames: parent=[0,142][1080,2424] display=[0,142][1080,2424] frame=[0,142][1080,2424] last=[0,142][1080,2424] insetsChanged=false
    isVisible=true`;

/** The same window with the keyboard down (and landscape from before). */
const IME_HIDDEN = `  Window #7 Window{a931ebe u0 InputMethod}:
    mViewVisibility=0x8 mHaveFrame=true mObscured=false
    mGivenContentInsets=[0,817][0,0] mGivenVisibleInsets=[0,817][0,0]
    touchable region=SkRegion((142,954,2424,1080))
    mHasSurface=false isReadyForDisplay()=false mWindowRemovalAllowed=false
    Frames: parent=[142,137][2424,1080] display=[142,137][2424,1080] frame=[142,137][2424,1080]
    isVisible=false`;

describe("Android screen state from dumpsys", () => {
  it("reads the keyboard's visible area from its touchable region", () => {
    expect(parseKeyboardFrame(IME_SHOWN)).toEqual({ x: 0, y: 1541, w: 1080, h: 883 });
  });

  it("falls back to the window frame below its content inset, old and new spellings", () => {
    const noRegion = IME_SHOWN.replace(/touchable region=.*\n/, "");
    expect(parseKeyboardFrame(noRegion)).toEqual({ x: 0, y: 1541, w: 1080, h: 883 });
    expect(parseKeyboardFrame(noRegion.replace("frame=[0,142]", "mFrame=[0,142]").replace(/parent=\S+ display=\S+ /, ""))).toEqual({
      x: 0,
      y: 1541,
      w: 1080,
      h: 883,
    });
  });

  it("unions a region of several rectangles (a floating or split keyboard)", () => {
    expect(parseKeyboardFrame("touchable region=SkRegion((0,1600,500,2400)(580,1600,1080,2400))")).toEqual({ x: 0, y: 1600, w: 1080, h: 800 });
  });

  it("has no keyboard when its window isn't visible", () => {
    expect(parseKeyboardFrame(IME_HIDDEN)).toBeNull();
    expect(parseKeyboardFrame("nothing here")).toBeNull();
  });

  it("knows whether the keyboard is up", () => {
    expect(parseInputShown("      mImeWindowVis=3\n      mInputShown=true\n")).toBe(true);
    expect(parseInputShown("      mInputShown=false\n  mIsInputViewShown=true")).toBe(false);
  });

  it("reads the display's rotation", () => {
    expect(parseRotation("    mRotation=0 mDeferredRotationPauseCount=0\n      mCurrentRotation=ROTATION_90")).toBe(90);
    expect(parseRotation("  mRotation=3 mAltOrientation=false")).toBe(270);
    expect(parseRotation("nothing")).toBeNull();
  });
});

describe("the keyboard in the element tree", () => {
  const el = (label: string, x: number, y: number, w: number, h: number, children: RawElement[] = []): RawElement => ({
    type: "button",
    label,
    bounds: { x, y, w, h },
    children,
  });
  const raw: RawElement = {
    type: "screen",
    bounds: { x: 0, y: 0, w: 1080, h: 2424 },
    children: [
      el("list", 0, 300, 1080, 2124, [el("Wi-Fi", 0, 400, 1080, 160), el("Hidden row", 0, 1800, 1080, 160), el("Half row", 0, 1480, 1080, 160)]),
    ],
  };
  const kb = { x: 0, y: 1541, w: 1080, h: 883 };

  it("adds the keyboard on top, drops what it hides and cuts back what it half hides", () => {
    const t = addKeyboard(raw, kb);
    const list = t.children[0]!;
    expect(list.bounds).toEqual({ x: 0, y: 300, w: 1080, h: 1241 });
    expect(list.children.map((c) => c.label)).toEqual(["Wi-Fi", "Half row"]);
    expect(list.children[1]!.bounds).toEqual({ x: 0, y: 1480, w: 1080, h: 61 });
    expect(t.children.at(-1)).toMatchObject({ label: "On-screen keyboard", nativeType: "InputMethod", bounds: kb });
    // the input tree is left as it was
    expect(raw.children[0]!.children).toHaveLength(3);
  });

  const circleAround = (root: ReturnType<typeof normalizeTree>, rx: number, ry: number, cy: number) => {
    const points: [number, number][] = Array.from({ length: 24 }, (_, i) => [540 + Math.cos((i / 24) * 2 * Math.PI) * rx, cy + Math.sin((i / 24) * 2 * Math.PI) * ry]);
    const [a] = resolveAll([{ id: "m", screenId: "s", kind: "circle", geometry: { type: "path", points } }], new Map([["s", root]]));
    return { status: a!.resolution!.status, labels: a!.resolution!.elements.map((id) => new TreeIndex(root).get(id)?.label) };
  };

  it("resolves a circle around the keyboard to the keyboard, not the row hidden underneath", () => {
    // spike A's finding: without the keyboard in the tree the mark lands on the app
    expect(circleAround(normalizeTree(raw), 560, 470, 1982)).toEqual({ status: "resolved", labels: ["Hidden row"] });
    expect(circleAround(normalizeTree(addKeyboard(raw, kb)), 560, 470, 1982)).toEqual({ status: "resolved", labels: ["On-screen keyboard"] });
  });

  it("leaves a circle around some keys as a region of the keyboard", () => {
    expect(circleAround(normalizeTree(addKeyboard(raw, kb)), 300, 200, 1900)).toEqual({ status: "region", labels: [] });
  });
});

describe("live session helpers", () => {
  it("maps a point on the shown screen to pixels, clamped", () => {
    expect(scalePoint({ x: 0.5, y: 0.25 }, 1080, 2424)).toEqual({ x: 540, y: 606 });
    expect(scalePoint({ x: 1, y: 1 }, 1080, 2424)).toEqual({ x: 1079, y: 2423 });
    expect(scalePoint({ x: -3, y: Number.NaN }, 1080, 2424)).toEqual({ x: 0, y: 0 });
    // landscape: the same point lands on the rotated screen
    expect(scalePoint({ x: 0.5, y: 0.25 }, 2424, 1080)).toEqual({ x: 1212, y: 270 });
  });

  it("lists devices with why they can't be shown", () => {
    const out = `List of devices attached
emulator-5554          device product:sdk_gphone16k_arm64 model:sdk_gphone16k_arm64 device:emu64a16k transport_id:25
R58N12ABCDE            unauthorized usb:1-1 transport_id:3
0123456789             offline transport_id:4
`;
    expect(parseAdbDevices(out)).toEqual([
      { serial: "emulator-5554", state: "ready", model: "sdk gphone16k arm64" },
      { serial: "R58N12ABCDE", state: "unauthorized", model: "" },
      { serial: "0123456789", state: "offline", model: "" },
    ]);
  });

  it("prefers the override size and density", () => {
    expect(parseWm("Physical size: 1080x2424")).toEqual([1080, 2424]);
    expect(parseWm("Physical size: 1080x2424\nOverride size: 720x1616")).toEqual([720, 1616]);
    expect(parseWm("Physical density: 420\nOverride density: 480")).toEqual([480]);
  });

  it("splits text into scrcpy-sized pieces without breaking characters", () => {
    expect(chunkText("hello", 300)).toEqual(["hello"]);
    const parts = chunkText("åäö".repeat(60), 100);
    expect(parts.join("")).toBe("åäö".repeat(60));
    for (const p of parts) expect(Buffer.byteLength(p)).toBeLessThanOrEqual(100);
  });
});
