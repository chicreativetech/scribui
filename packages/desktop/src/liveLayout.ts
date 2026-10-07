/**
 * Where the reviewed app's view goes. The canvas reports the free area of its
 * app tab and the chosen size; native views can't be clipped or scrolled like
 * an iframe, so a size larger than the free area is shown scaled down (the
 * page still lays out at the chosen size, through its zoom factor) and is
 * captured at full size.
 */

export type Rect = { x: number; y: number; width: number; height: number };
export type Size = { width: number; height: number };
export type LiveLayout = { bounds: Rect; zoom: number };

/** Space kept around a sized app, as the iframe's margin did. */
export const MARGIN = 24;

export function layoutLiveView(area: Rect, size: Size | null): LiveLayout {
  const r = rounded(area);
  if (!size) return { bounds: r, zoom: 1 };
  const room = { width: Math.max(1, r.width - 2 * MARGIN), height: Math.max(1, r.height - 2 * MARGIN) };
  const { width, height, zoom } = fitZoom(size, Math.min(1, room.width / size.width, room.height / size.height));
  return {
    bounds: { x: r.x + Math.round((r.width - width) / 2), y: r.y + (zoom < 1 ? Math.round((r.height - height) / 2) : MARGIN), width, height },
    zoom,
  };
}

/**
 * A zoomed page is laid out at (view size / zoom) CSS pixels, rounded, so a
 * zoom and whole-pixel view size are picked together: the page gets exactly
 * the chosen width and height. Each lands a little above the whole number
 * (+0.05…0.45), which gives it whether Chromium floors or rounds, and keeps
 * clear of the zoom coming back slightly off (it's stored as a zoom level).
 */
const LOW = 0.05;
const HIGH = 0.45;

export function fitZoom(size: Size, want: number): { width: number; height: number; zoom: number } {
  if (want >= 1) return { ...size, zoom: 1 };
  const range = (px: number, css: number) => [px / (css + HIGH), px / (css + LOW)] as const;
  const w0 = Math.max(1, Math.round(size.width * want));
  for (let d = 0; d <= 50; d++) {
    for (const width of d ? [w0 - d, w0 + d] : [w0]) {
      if (width < 1) continue;
      const [wlo, whi] = range(width, size.width);
      for (const height of [Math.round(size.height * whi), Math.round(size.height * wlo), Math.ceil(size.height * wlo)]) {
        const [hlo, hhi] = range(height, size.height);
        const from = Math.max(wlo, hlo);
        const to = Math.min(whi, hhi);
        if (to > from) return { width, height, zoom: (from + to) / 2 };
      }
    }
  }
  return { width: Math.round(size.width * want), height: Math.round(size.height * want), zoom: want };
}

/** CSS pixels of the canvas → window pixels (the canvas may itself be zoomed). */
export function scaleRect(r: Rect, factor: number): Rect {
  return rounded({ x: r.x * factor, y: r.y * factor, width: r.width * factor, height: r.height * factor });
}

const rounded = (r: Rect): Rect => {
  const x = Math.round(r.x);
  const y = Math.round(r.y);
  return { x, y, width: Math.max(0, Math.round(r.x + r.width) - x), height: Math.max(0, Math.round(r.y + r.height) - y) };
};
