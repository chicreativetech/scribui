/**
 * Reading an MHTML snapshot (Chrome's "Webpage, Single File", what Figma's Chrome
 * extension copies): the page and each resource it saved, by address.
 */

export type MhtmlPart = {
  type: string;
  /** Where the part was loaded from: its URL, or `cid:…` for stylesheets Chrome made up (adopted ones). */
  location?: string;
  body: Buffer;
};

export type Mhtml = {
  /** The address the page was saved from. */
  url?: string;
  title?: string;
  /** The page itself: the first HTML part. */
  page: MhtmlPart;
  parts: MhtmlPart[];
};

/** Headers of a MIME block, folded lines joined, names lowercased. */
function headers(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of block.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) out.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  return out;
}

function decode(body: string, encoding: string | undefined): Buffer {
  const enc = (encoding ?? "").toLowerCase();
  if (enc === "base64") return Buffer.from(body.replace(/\s+/g, ""), "base64");
  if (enc === "quoted-printable") {
    // =XX are bytes (UTF-8 text split up); everything else is plain ASCII
    const bytes = body.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
    return Buffer.from(bytes, "latin1");
  }
  return Buffer.from(body, "latin1");
}

/** Throws when the text isn't a multipart MHTML snapshot with a page in it. */
export function parseMhtml(text: string): Mhtml {
  const split = text.search(/\r?\n\r?\n/);
  if (split < 0) throw new Error("not an MHTML snapshot");
  const top = headers(text.slice(0, split));
  const boundary = /boundary="?([^";\r\n]+)"?/i.exec(top.get("content-type") ?? "")?.[1];
  if (!boundary) throw new Error("not an MHTML snapshot: no parts");

  const parts: MhtmlPart[] = [];
  for (const chunk of text.split(`--${boundary}`).slice(1)) {
    if (chunk.startsWith("--")) break;
    const body = chunk.replace(/^\r?\n/, "");
    const end = body.search(/\r?\n\r?\n/);
    if (end < 0) continue;
    const h = headers(body.slice(0, end));
    const content = body.slice(end).replace(/^\r?\n\r?\n/, "").replace(/\r?\n$/, "");
    const id = h.get("content-id")?.replace(/^<|>$/g, "");
    parts.push({
      type: (h.get("content-type") ?? "application/octet-stream").split(";")[0]!.trim().toLowerCase(),
      location: h.get("content-location") ?? (id ? `cid:${id}` : undefined),
      body: decode(content, h.get("content-transfer-encoding")),
    });
  }
  const page = parts.find((p) => p.type === "text/html");
  if (!page) throw new Error("the MHTML snapshot has no page in it");
  return { url: top.get("snapshot-content-location") ?? page.location, title: top.get("subject"), page, parts };
}

/**
 * Chrome saves shadow roots as `<template shadowmode="open">`, a form of declarative
 * shadow DOM browsers no longer read: the standard `shadowrootmode` attaches them
 * again, without scripts.
 */
export const withShadowRoots = (html: string): string =>
  html.replace(/<template(\s[^>]*?)?\sshadowmode=/gi, (m) => m.replace(/shadowmode=/i, "shadowrootmode=")).replace(/(<template\s[^>]*?)\sshadowdelegatesfocus/gi, "$1 shadowrootdelegatesfocus");
