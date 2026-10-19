import { describe, expect, it } from "vitest";
import { parseMhtml, withShadowRoots } from "../src/mhtml.js";

const B = "----MultipartBoundary--abc----";
const snapshot = [
  "From: <Saved by Blink>",
  "Snapshot-Content-Location: https://shop.example/cart",
  "Subject: =?utf-8?Q?Cart?=",
  "MIME-Version: 1.0",
  "Content-Type: multipart/related;",
  '\ttype="text/html";',
  `\tboundary="${B}"`,
  "",
  "",
  `--${B}`,
  "Content-Type: text/html",
  "Content-ID: <frame-1@mhtml.blink>",
  "Content-Transfer-Encoding: quoted-printable",
  "Content-Location: https://shop.example/cart",
  "",
  '<html><head><link rel=3D"stylesheet" href=3D"cid:css-1@mhtml.blink"></head><body><p>F=C3=B6r din s=',
  "=C3=A4kerhet</p></body></html>",
  `--${B}`,
  "Content-Type: text/css",
  "Content-Transfer-Encoding: quoted-printable",
  "Content-Location: cid:css-1@mhtml.blink",
  "",
  "p { color: red; }",
  `--${B}`,
  "Content-Type: image/png",
  "Content-Transfer-Encoding: base64",
  "Content-Location: https://shop.example/logo.png",
  "",
  Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"),
  `--${B}--`,
  "",
].join("\r\n");

describe("MHTML snapshots", () => {
  it("reads the page and each saved part, decoded, by address", () => {
    const m = parseMhtml(snapshot);
    expect(m.url).toBe("https://shop.example/cart");
    expect(m.page.body.toString("utf8")).toBe('<html><head><link rel="stylesheet" href="cid:css-1@mhtml.blink"></head><body><p>För din säkerhet</p></body></html>');
    expect(m.parts.map((p) => [p.type, p.location])).toEqual([
      ["text/html", "https://shop.example/cart"],
      ["text/css", "cid:css-1@mhtml.blink"],
      ["image/png", "https://shop.example/logo.png"],
    ]);
    expect([...m.parts[2]!.body]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("refuses what isn't a snapshot", () => {
    expect(() => parseMhtml("<html></html>")).toThrow(/not an MHTML snapshot/);
    expect(() => parseMhtml(`Content-Type: multipart/related; boundary="x"\r\n\r\n--x\r\nContent-Type: text/css\r\n\r\np{}\r\n--x--`)).toThrow(/no page/);
  });

  it("Chrome's saved shadow roots become standard declarative shadow DOM", () => {
    expect(withShadowRoots('<gds-link><template shadowmode="open" shadowdelegatesfocus=""><a><slot></slot></a></template>Hi</gds-link>')).toBe(
      '<gds-link><template shadowrootmode="open" shadowrootdelegatesfocus=""><a><slot></slot></a></template>Hi</gds-link>',
    );
    // markup that only mentions it is left alone
    expect(withShadowRoots("<p>shadowmode=open</p>")).toBe("<p>shadowmode=open</p>");
  });
});
