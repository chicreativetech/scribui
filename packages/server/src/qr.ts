/// <reference path="./shims.d.ts" />
// Static imports (not createRequire) so bundlers inline them: the desktop app
// bundles to CommonJS, where import.meta.url is undefined.
import QRCodeImpl from "qrcode-terminal/vendor/QRCode/index.js";
import QRErrorCorrectLevel from "qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js";

type QRCodeCtor = new (type: number, level: number) => {
  addData(s: string): void;
  make(): void;
  getModuleCount(): number;
  isDark(r: number, c: number): boolean;
};

/** A QR code as a crisp SVG (dark modules on white, 4-module quiet zone). */
export function qrSvg(text: string): string {
  const QRCode = QRCodeImpl as QRCodeCtor;
  const Level = QRErrorCorrectLevel as { M: number };
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
