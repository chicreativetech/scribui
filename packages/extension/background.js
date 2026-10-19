import { capturable, dropAdoptedStyles, frameRule, isScribui, keepAdoptedStyles, MAX_SNAPSHOT, renderWidth, scrollThrough, WEB_ORIGINS } from "./lib.js";

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

/* ───────── other websites in ScribUI's App view ───────── */

const mayShowWebsites = () => chrome.permissions.contains({ origins: WEB_ORIGINS });

/** The tabs showing ScribUI, by tab id → its origin; kept while the worker sleeps. */
async function scribuiTabs() {
  return (await chrome.storage.session.get("scribuiTabs")).scribuiTabs ?? {};
}

async function forgetTab(tabId) {
  const tabs = await scribuiTabs();
  if (!(tabId in tabs)) return;
  delete tabs[tabId];
  await chrome.storage.session.set({ scribuiTabs: tabs });
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tabId] });
}

// ScribUI's canvas asks (through bridge.js) whether other websites can show in its App view
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type !== "frames?" && msg?.type !== "frames-allow") return false;
  const tab = sender.tab;
  if (!tab?.id || !sender.url || sender.frameId !== 0) return false;
  (async () => {
    if (!(await isScribui(sender.url))) return false;
    const tabs = await scribuiTabs();
    tabs[tab.id] = new URL(sender.url).origin;
    await chrome.storage.session.set({ scribuiTabs: tabs });
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tab.id], addRules: [frameRule(tab.id)] });
    if (msg.type === "frames-allow" && !(await mayShowWebsites())) {
      // Chrome asks for a permission only from a click in the extension's own page
      await chrome.windows.create({ url: "grant.html", type: "popup", width: 400, height: 300, focused: true });
    }
    return mayShowWebsites();
  })().then(reply, () => reply(false));
  return true;
});

// the tab closed or left ScribUI: its rule goes
chrome.tabs.onRemoved.addListener((tabId) => void forgetTab(tabId));
chrome.tabs.onUpdated.addListener(async (tabId, change) => {
  if (!change.url) return;
  const origin = (await scribuiTabs())[tabId];
  if (origin && new URL(change.url).origin !== origin) await forgetTab(tabId);
});

// given or taken back: the open ScribUI tabs hear it
const tellTabs = async () => {
  const allowed = await mayShowWebsites();
  for (const id of Object.keys(await scribuiTabs())) void chrome.tabs.sendMessage(Number(id), { type: "frames", allowed }).catch(() => {});
};
chrome.permissions.onAdded.addListener(tellTabs);
chrome.permissions.onRemoved.addListener(tellTabs);
