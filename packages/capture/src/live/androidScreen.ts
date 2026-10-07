import type { RawElement, Rect } from "@scribui/core";
import type { Rotation } from "./session.js";

/**
 * What `uiautomator dump` leaves out, read from `dumpsys`: the display's
 * rotation and the on-screen keyboard. The dump covers the app's window only,
 * so a keyboard shown over the app is in the screenshot but not the tree; a
 * mark on it would resolve to the app's element underneath.
 */

/** `dumpsys window displays`: `mCurrentRotation=ROTATION_90` (API 29+) or `mRotation=1`. */
export function parseRotation(dumpsys: string): Rotation | null {
  const named = /mCurrentRotation=ROTATION_(0|90|180|270)\b/.exec(dumpsys);
  if (named) return Number(named[1]) as Rotation;
  const quarter = /\bmRotation=([0-3])\b/.exec(dumpsys);
  return quarter ? ((Number(quarter[1]) * 90) as Rotation) : null;
}

/** `dumpsys input_method`: the keyboard is up. */
export const parseInputShown = (dumpsys: string) => /\bmInputShown=true\b/.test(dumpsys);

/**
 * The keyboard's visible area from `dumpsys window InputMethod`, in screen
 * pixels. Its window spans most of the screen; the keys are its touchable
 * region (one or more rectangles, "SkRegion((l,t,r,b)(…))"), or else the
 * window's frame below its content inset ("frame=[l,t][r,b]" with
 * "mGivenContentInsets=[0,top][0,0]"; older releases print "mFrame=").
 */
export function parseKeyboardFrame(dumpsys: string): Rect | null {
  if (/\bisVisible=false\b/.test(dumpsys) || /\bmHasSurface=false\b/.test(dumpsys)) return null;
  const region = /touchable region=SkRegion\(((?:\(-?\d+,-?\d+,-?\d+,-?\d+\))+)\)/.exec(dumpsys);
  if (region) {
    const rects = [...region[1]!.matchAll(/\((-?\d+),(-?\d+),(-?\d+),(-?\d+)\)/g)].map((m) => m.slice(1).map(Number) as [number, number, number, number]);
    const l = Math.min(...rects.map((r) => r[0])), t = Math.min(...rects.map((r) => r[1]));
    const r = Math.max(...rects.map((r) => r[2])), b = Math.max(...rects.map((r) => r[3]));
    if (r > l && b > t) return { x: l, y: t, w: r - l, h: b - t };
  }
  const frame = /\b(?:m[Ff]rame|frame)=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(dumpsys);
  if (!frame) return null;
  const [l, t, r, b] = frame.slice(1).map(Number) as [number, number, number, number];
  const inset = /mGivenContentInsets=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(dumpsys);
  const top = t + (inset ? Number(inset[2]) : 0);
  return r > l && b > top ? { x: l, y: top, w: r - l, h: b - top } : null;
}

/**
 * Put the keyboard into the tree, on top of the app: an element of its own,
 * with the app's elements it hides removed and the ones it partly hides cut
 * back to what's visible above it.
 */
export function addKeyboard(raw: RawElement, kb: Rect): RawElement {
  const covers = (b: Rect) => b.x >= kb.x && b.x + b.w <= kb.x + kb.w && b.y >= kb.y && b.y + b.h <= kb.y + kb.h;
  // a keyboard as wide as the element and below its top: the element shows above it
  const cutsBottom = (b: Rect) => kb.x <= b.x && kb.x + kb.w >= b.x + b.w && kb.y > b.y && kb.y < b.y + b.h;
  const visit = (e: RawElement): RawElement | null => {
    if (covers(e.bounds) && e.bounds.w > 0 && e.bounds.h > 0) return null;
    const bounds = cutsBottom(e.bounds) ? { ...e.bounds, h: kb.y - e.bounds.y } : e.bounds;
    return { ...e, bounds, children: e.children.map(visit).filter((c): c is RawElement => !!c) };
  };
  const keyboard: RawElement = { type: "container", nativeType: "InputMethod", label: "On-screen keyboard", bounds: kb, children: [] };
  const children = raw.children.map(visit).filter((c): c is RawElement => !!c);
  return { ...raw, children: [...children, keyboard] };
}
