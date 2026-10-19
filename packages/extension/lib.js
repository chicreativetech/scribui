// Shared by the popup and the background worker; no Chrome APIs here, so it can be tested on its own.

/** ScribUI serves each project on the first free port from 4382 (see packages/project/src/instances.ts). */
export const DEFAULT_PORT = 4382;
export const PORT_RANGE = 10;

/** The largest snapshot the ScribUI server takes (its /api/imports limit). */
export const MAX_SNAPSHOT = 64 * 1024 * 1024;

/**
 * @typedef {{ port: number, url: string, root: string, name: string, platform?: string, baseUrl?: string, canRenderPages: boolean }} Project
 */

/**
 * The ScribUI projects running on this computer: every port in the range, plus any
 * the user added (a server started with --port). A project has one server.
 * @param {number[]} extra
 * @param {typeof fetch} get
 * @returns {Promise<Project[]>}
 */
export async function findProjects(extra = [], get = fetch) {
  const ports = [...new Set([...Array.from({ length: PORT_RANGE }, (_, i) => DEFAULT_PORT + i), ...extra])];
  const found = await Promise.all(
    ports.map(async (port) => {
      const url = `http://127.0.0.1:${port}/`;
      try {
        const r = await get(`${url}api/project`, { signal: AbortSignal.timeout(800) });
        if (!r.ok) return null;
        const p = await r.json();
        // something else on the port
        if (typeof p?.root !== "string" || typeof p?.folder !== "string") return null;
        const app = p.manifest && "app" in p.manifest ? p.manifest.app : undefined;
        return {
          port,
          url,
          root: p.root,
          name: app?.name || p.root.split(/[\\/]/).filter(Boolean).pop() || p.root,
          platform: app?.platform,
          baseUrl: app?.baseUrl,
          canRenderPages: p.canRenderPages !== false,
        };
      } catch {
        return null;
      }
    }),
  );
  const seen = new Set();
  return found.filter((p) => p && !seen.has(p.root) && seen.add(p.root));
}

/**
 * A page of the app being reviewed (on its `baseUrl`, or on this computer for a web
 * project) is most likely a screen of it; anything else is a reference.
 * @param {string} pageUrl
 * @param {Project | undefined} project
 * @returns {"app" | "reference"}
 */
export function defaultRole(pageUrl, project) {
  let page;
  try {
    page = new URL(pageUrl);
  } catch {
    return "reference";
  }
  if (project?.baseUrl) {
    try {
      if (new URL(project.baseUrl).origin === page.origin) return "app";
    } catch {
      /* not a URL */
    }
  }
  const local = page.hostname === "localhost" || page.hostname === "127.0.0.1" || page.hostname.endsWith(".localhost");
  return local && project?.platform === "web" ? "app" : "reference";
}

/** Only web pages can be captured: not Chrome's own pages, the Web Store or files. */
export const capturable = (url) => /^https?:\/\//i.test(url ?? "") && !/^https:\/\/chromewebstore\.google\.com\//i.test(url);

/** The page's width as ScribUI renders it: within what the server takes. */
export const renderWidth = (w) => Math.min(2560, Math.max(320, Math.round(w || 1440)));

/**
 * Runs in the page: scroll down through it and back, so images that load when
 * they come into view and content that fades in on scroll are there for the
 * snapshot. Returns where the page was scrolled to, to put it back after.
 */
export async function scrollThrough() {
  const start = { x: scrollX, y: scrollY };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const step = Math.max(200, Math.round(innerHeight * 0.8));
  const until = Date.now() + 8000;
  for (let y = 0; y < document.documentElement.scrollHeight && Date.now() < until; y += step) {
    scrollTo(0, y);
    await wait(120);
  }
  scrollTo(0, document.documentElement.scrollHeight);
  await wait(300);
  scrollTo(start.x, start.y);
  await wait(150);
  return start;
}

/**
 * Runs in the page, just before it's saved: stylesheets that scripts attach to the page
 * and to web components (`adoptedStyleSheets`, how Lit and most design systems style
 * their components) aren't in a saved page. Linking each where it applies keeps them:
 * as a `data:` stylesheet, because Chrome leaves `<style>` elements out of the shadow
 * roots it saves but keeps links. `dropAdoptedStyles` takes them out again. Returns how many.
 */
export function keepAdoptedStyles() {
  const roots = [document];
  const walk = (root) => {
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) {
        roots.push(el.shadowRoot);
        walk(el.shadowRoot);
      }
    }
  };
  walk(document);
  let kept = 0;
  for (const root of roots) {
    const sheets = root.adoptedStyleSheets ?? [];
    if (!sheets.length) continue;
    const css = sheets
      .map((sheet) => {
        try {
          return [...sheet.cssRules].map((r) => r.cssText).join("\n");
        } catch {
          return "";
        }
      })
      .join("\n");
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.setAttribute("data-scribui-adopted", "");
    link.href = `data:text/css;charset=utf-8,${encodeURIComponent(css)}`;
    // adopted sheets come after the root's own styles
    (root === document ? document.head : root).append(link);
    kept++;
  }
  return kept;
}

/** Runs in the page after it's saved: takes out what `keepAdoptedStyles` put in. */
export function dropAdoptedStyles() {
  const drop = (root) => {
    for (const el of root.querySelectorAll("*")) {
      if (el.matches("link[data-scribui-adopted]")) el.remove();
      else if (el.shadowRoot) drop(el.shadowRoot);
    }
  };
  drop(document);
}

/** Runs in the page: what the popup shows and sends along. */
export function pageInfo() {
  return { title: document.title, width: innerWidth };
}

/** Every website: what the extension needs to show other sites in ScribUI's App view. Asked for only then. */
export const WEB_ORIGINS = ["http://*/*", "https://*/*"];

/**
 * The rule that lets pages show inside ScribUI's App view, in that one tab: the
 * headers that tell a browser not to show a page in a frame are dropped, for the
 * pages in its frames only. A rule per tab, numbered by it.
 * @param {number} tabId
 */
export function frameRule(tabId) {
  return {
    id: tabId,
    priority: 1,
    action: {
      type: "modifyHeaders",
      responseHeaders: [
        { header: "x-frame-options", operation: "remove" },
        { header: "content-security-policy", operation: "remove" },
      ],
    },
    condition: { tabIds: [tabId], resourceTypes: ["sub_frame"] },
  };
}

/**
 * Whether a page on this computer is ScribUI's canvas: its server answers like ScribUI.
 * @param {string} pageUrl
 * @param {typeof fetch} get
 */
export async function isScribui(pageUrl, get = fetch) {
  try {
    const r = await get(new URL("/api/project", pageUrl).toString(), { signal: AbortSignal.timeout(800) });
    if (!r.ok) return false;
    const p = await r.json();
    return typeof p?.root === "string" && typeof p?.folder === "string";
  } catch {
    return false;
  }
}
