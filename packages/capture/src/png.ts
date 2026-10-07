import { deflateSync, inflateSync } from "node:zlib";

/** Width and height from a PNG's IHDR chunk. */
export function pngSize(buf: Uint8Array): { width: number; height: number } {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 24 || !sig.every((b, i) => buf[i] === b)) throw new Error("not a PNG file");
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return { width: dv.getUint32(16), height: dv.getUint32(20) };
}

export type DecodedPng = { width: number; height: number; channels: 3 | 4; data: Uint8Array; hasColourProfile: boolean };

/**
 * Raw pixel values of an 8-bit, non-interlaced RGB or RGBA PNG (what Android's
 * screencap and Chromium write), with no colour management: the values tools
 * like resvg and the agent read. Throws on other PNG formats.
 */
export function decodePng(buf: Uint8Array): DecodedPng {
  const { width, height } = pngSize(buf);
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  let i = 8;
  let type = 0;
  let hasColourProfile = false;
  const idat: Buffer[] = [];
  while (i < b.length) {
    const len = b.readUInt32BE(i);
    const t = b.toString("ascii", i + 4, i + 8);
    const d = b.subarray(i + 8, i + 8 + len);
    if (t === "IHDR") {
      type = d[9]!;
      if (d[8] !== 8 || d[12] !== 0) throw new Error("only 8-bit, non-interlaced PNGs are supported");
    } else if (t === "iCCP") hasColourProfile = true;
    else if (t === "IDAT") idat.push(d);
    else if (t === "IEND") break;
    i += 12 + len;
  }
  const channels = type === 6 ? 4 : type === 2 ? 3 : 0;
  if (!channels) throw new Error(`PNG colour type ${type} is not supported`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[row + x - channels]! : 0;
      const up = y > 0 ? out[row - stride + x]! : 0;
      const c = x >= channels && y > 0 ? out[row - stride + x - channels]! : 0;
      let pred = 0;
      if (filter === 1) pred = a;
      else if (filter === 2) pred = up;
      else if (filter === 3) pred = (a + up) >> 1;
      else if (filter === 4) {
        const p = a + up - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      }
      out[row + x] = (raw[src + x]! + pred) & 255;
    }
  }
  return { width, height, channels, data: out, hasColourProfile };
}

/** Share of pixels whose RGB differs by more than `tolerance` (0–255) between two decoded PNGs; 1 when sizes differ. */
export function pixelDifference(a: DecodedPng, b: DecodedPng, tolerance = 8): number {
  if (a.width !== b.width || a.height !== b.height) return 1;
  let differ = 0;
  for (let p = 0, q = 0; p < a.data.length; p += a.channels, q += b.channels) {
    if (Math.abs(a.data[p]! - b.data[q]!) > tolerance || Math.abs(a.data[p + 1]! - b.data[q + 1]!) > tolerance || Math.abs(a.data[p + 2]! - b.data[q + 2]!) > tolerance) differ++;
  }
  return differ / (a.width * a.height);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** An 8-bit RGB(A) PNG of decoded pixels, marked sRGB (as the screenshots it comes from are). */
export function encodePng(img: Omit<DecodedPng, "hasColourProfile">): Buffer {
  const { width, height, channels, data } = img;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("sRGB", Uint8Array.of(0)),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/** Turn decoded pixels clockwise by `degrees` (0, 90, 180 or 270). */
export function rotatePixels(img: DecodedPng, degrees: 0 | 90 | 180 | 270): DecodedPng {
  if (degrees === 0) return img;
  const { width: w, height: h, channels: c, data } = img;
  const turned = degrees !== 180;
  const W = turned ? h : w;
  const H = turned ? w : h;
  const out = new Uint8Array(data.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      // where (x, y) lands after the turn
      const [X, Y] = degrees === 90 ? [h - 1 - y, x] : degrees === 180 ? [w - 1 - x, h - 1 - y] : [y, w - 1 - x];
      out.set(data.subarray((y * w + x) * c, (y * w + x + 1) * c), (Y * W + X) * c);
    }
  return { ...img, width: W, height: H, data: out };
}
