import type { ScreenInfo } from "./api";

/** World units are device points; a tile's screenshot pixels = world × scale. */
export type TileLayout = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** screenshot pixels per world unit */
  scale: number;
  group: string;
};

export type GroupLayout = { name: string; index: number; x: number; y: number; w: number; count: number };

export const TILE_GAP = 64;
export const GROUP_GAP = 180;
export const GROUP_HEADER = 170;

export function layoutBoard(screens: ScreenInfo[]): { tiles: TileLayout[]; groups: GroupLayout[] } {
  const order: string[] = [];
  const byGroup = new Map<string, ScreenInfo[]>();
  for (const s of screens) {
    if (!byGroup.has(s.group)) {
      byGroup.set(s.group, []);
      order.push(s.group);
    }
    byGroup.get(s.group)!.push(s);
  }
  const tiles: TileLayout[] = [];
  const groups: GroupLayout[] = [];
  let y = 0;
  order.forEach((name, gi) => {
    const list = byGroup.get(name)!;
    let x = 0;
    let rowH = 0;
    const top = y + GROUP_HEADER;
    for (const s of list) {
      const scale = s.device?.scale ?? 1;
      const w = s.size ? s.size.width / scale : 390;
      const h = s.size ? s.size.height / scale : 844;
      tiles.push({ id: s.id, x, y: top, w, h, scale, group: name });
      x += w + TILE_GAP;
      rowH = Math.max(rowH, h);
    }
    groups.push({ name, index: gi + 1, x: 0, y, w: Math.max(0, x - TILE_GAP), count: list.length });
    y = top + rowH + GROUP_GAP;
  });
  return { tiles, groups };
}

export type Camera = { x: number; y: number; zoom: number };

export const worldToScreen = (cam: Camera, wx: number, wy: number): [number, number] => [
  (wx - cam.x) * cam.zoom,
  (wy - cam.y) * cam.zoom,
];

export const screenToWorld = (cam: Camera, sx: number, sy: number): [number, number] => [
  sx / cam.zoom + cam.x,
  sy / cam.zoom + cam.y,
];

export function fitCamera(
  rect: { x: number; y: number; w: number; h: number },
  viewport: { w: number; h: number },
  pad = 64,
  maxZoom = 2,
): Camera {
  const zoom = Math.min(maxZoom, Math.max(0.02, Math.min((viewport.w - 2 * pad) / rect.w, (viewport.h - 2 * pad) / rect.h)));
  return {
    zoom,
    x: rect.x + rect.w / 2 - viewport.w / 2 / zoom,
    y: rect.y + rect.h / 2 - viewport.h / 2 / zoom,
  };
}

export function boardBounds(tiles: TileLayout[], groups: GroupLayout[]) {
  if (tiles.length === 0) return { x: 0, y: 0, w: 800, h: 600 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const t of tiles) {
    minX = Math.min(minX, t.x);
    minY = Math.min(minY, t.y);
    maxX = Math.max(maxX, t.x + t.w);
    maxY = Math.max(maxY, t.y + t.h);
  }
  for (const g of groups) minY = Math.min(minY, g.y);
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Zoom snapped to 1/8 octave steps so SVG strings are not rebuilt every frame. */
export function quantize(z: number): number {
  return Math.pow(2, Math.round(Math.log2(z) * 8) / 8);
}
