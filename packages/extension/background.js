import { capturable, dropAdoptedStyles, keepAdoptedStyles, MAX_SNAPSHOT, renderWidth, scrollThrough } from "./lib.js";

/**
 * Sends a page to ScribUI: scrolls through it (optional), saves it as MHTML (the
 * page with its styles and images, as Chrome's "Webpage, Single File") and posts it
 * to the project's /api/imports. Runs here, not in the popup, so closing the popup
 * doesn't stop it; the badge says how it went.
 */

/** @param {{ tabId: number, server: string, role: "app" | "reference", title?: string, width: number, scroll: boolean }} req */
async function sendPage(req, progress) {
  const tab = await chrome.tabs.get(req.tabId);
  if (!capturable(tab.url)) throw new Error("Chrome's own pages and the Web Store can't be captured: open a web page.");

  if (req.scroll) {
    progress("Scrolling through the page…");
    await chrome.scripting.executeScript({ target: { tabId: req.tabId }, func: scrollThrough }).catch(() => {
      /* a page that won't take scripts is still captured as it is */
    });
  }

  progress("Capturing the page…");
  // the page's own world: that's where its components' stylesheets are
  const inPage = (func) => chrome.scripting.executeScript({ target: { tabId: req.tabId, allFrames: false }, world: "MAIN", func }).catch(() => null);
  await inPage(keepAdoptedStyles);
  let blob;
  try {
    blob = await chrome.pageCapture.saveAsMHTML({ tabId: req.tabId });
  } finally {
    await inPage(dropAdoptedStyles);
  }
  if (!blob) throw new Error("Chrome couldn't capture this page.");
  if (blob.size > MAX_SNAPSHOT) throw new Error(`This page is ${Math.round(blob.size / 1024 / 1024)} MB with its images: more than ScribUI takes (64 MB).`);
  const mhtml = await blob.text();

  progress("Sending it to ScribUI…");
  let r;
  try {
    r = await fetch(`${req.server}api/imports`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "snapshot",
        role: req.role,
        mhtml,
        url: tab.url,
        width: renderWidth(req.width),
        ...(req.title?.trim() ? { title: req.title.trim().slice(0, 120) } : {}),
      }),
    });
  } catch {
    throw new Error("ScribUI stopped answering. Is it still running?");
  }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `ScribUI said ${r.status}`);
  return body;
}

function badge(text, color) {
  void chrome.action.setBadgeText({ text });
  if (color) void chrome.action.setBadgeBackgroundColor({ color });
  if (text) setTimeout(() => void chrome.action.setBadgeText({ text: "" }), 6000);
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== "send") return false;
  const progress = (step) => void chrome.runtime.sendMessage({ type: "progress", step }).catch(() => {});
  badge("…", "#5e5e5e");
  sendPage(msg, progress).then(
    (result) => {
      badge("✓", "#2f9e44");
      reply({ ok: true, result });
    },
    (e) => {
      badge("!", "#e5484d");
      reply({ ok: false, error: e instanceof Error ? e.message : String(e) });
    },
  );
  // the reply comes later
  return true;
});
