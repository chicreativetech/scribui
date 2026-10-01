import { createRequire } from "node:module";

type QRCodeCtor = new (type: number, level: number) => {
  addData(s: string): void;
  make(): void;
  getModuleCount(): number;
  isDark(r: number, c: number): boolean;
};

/** A QR code as a crisp SVG (dark modules on white, 4-module quiet zone). */
export function qrSvg(text: string): string {
  const req = createRequire(import.meta.url);
  const QRCode = req("qrcode-terminal/vendor/QRCode") as QRCodeCtor;
  const Level = req("qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel") as { M: number };
  const qr = new QRCode(-1, Level.M);
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const q = 4;
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + q} ${r + q}h1v1h-1z`;
  const size = n + 2 * q;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
