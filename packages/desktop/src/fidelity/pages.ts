import { createServer, type Server } from "node:http";
import type { Rgb } from "./checks.js";

/**
 * The probe page every fidelity suite captures: elements filled with pure
 * colours found nowhere else on the page, so their pixels can be located in
 * a screenshot and compared with the element tree. Each has an id (the web
 * tree) and an accessible label (Android's and iOS's trees).
 */

export type Probe = { name: string; match: RegExp; rgb: Rgb; tolerancePx?: number };

export const PROBES: Record<"probe" | "turned" | "header" | "low", Probe> = {
  probe: { name: "plain box", match: /^(probe|magenta probe)$/, rgb: [255, 0, 255] as Rgb },
  turned: { name: "rotated 12°", match: /^(turned|turned probe)$/, rgb: [0, 255, 255] as Rgb, tolerancePx: 2 },
  header: { name: "sticky header", match: /^(top|sticky header)$/, rgb: [255, 255, 0] as Rgb },
  low: { name: "below the fold", match: /^(low|low probe)$/, rgb: [255, 128, 0] as Rgb },
};

export const FADE_RGB: Rgb = [0, 255, 0];
export const SPIN_RGB: Rgb = [0, 0, 255];

/** Scroll position (CSS px) that puts the low probe on screen with the header stuck on top. */
export const SCROLL_TO = 1000;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fidelity probe</title><style>
  body { margin: 0; font: 16px/1.4 Helvetica, Arial, sans-serif; background: #ffffff; color: #222; }
  #top { position: sticky; top: 0; height: 56px; background: #ffff00; z-index: 2; }
  #probe { position: absolute; left: 40px; top: 120px; width: 160px; height: 80px; background: #ff00ff; }
  #turned { position: absolute; left: 240px; top: 120px; width: 90px; height: 90px; background: #00ffff; transform: rotate(12deg); }
  #fade { position: absolute; left: 40px; top: 250px; width: 200px; height: 40px; background: #00ff00; opacity: 0.2; transition: opacity 30s linear; }
  #fade.on { opacity: 1; }
  #spin { position: absolute; left: 280px; top: 250px; width: 40px; height: 40px; background: #0000ff; animation: spin 2s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  #field { position: absolute; left: 40px; top: 320px; width: 240px; height: 32px; font-size: 16px; }
  #low { position: absolute; left: 40px; top: 1200px; width: 200px; height: 60px; background: #ff8000; }
  .tall { height: 2400px; }
</style></head><body>
  <div id="top" role="img" aria-label="sticky header"></div>
  <div id="probe" role="img" aria-label="magenta probe"></div>
  <div id="turned" role="img" aria-label="turned probe"></div>
  <div id="fade"></div>
  <div id="spin"></div>
  <input id="field" aria-label="probe field" value="caret here">
  <div id="low" role="img" aria-label="low probe"></div>
  <div class="tall"></div>
  <script>/*MOTION*/</script>
</body></html>`;

/** The page with motion (a 30 s transition, a spinner, a focused field): a web capture must freeze it. */
export const PROBE_PAGE = PAGE.replace(
  "/*MOTION*/",
  `requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById("fade").classList.add("on"))); document.getElementById("field").focus();`,
);

/**
 * The page standing still (/still): what a device shows can't be frozen, so a
 * capture of a moving page rightly never settles. No spinner, no caret.
 */
export const STILL_PAGE = PAGE.replace("animation: spin 2s linear infinite;", "").replace("opacity: 0.2; transition: opacity 30s linear;", "");

/** Still, but a box glides across for MOVING_MS after loading: a capture taken meanwhile must notice. */
export const MOVING_MS = 5000;
export const MOVING_PAGE = STILL_PAGE.replace(
  "</body>",
  `<div id="mover" style="position:absolute;left:40px;top:400px;width:60px;height:60px;background:#808080;animation:glide ${MOVING_MS}ms linear 1 forwards"></div>
<style>@keyframes glide { to { transform: translateX(240px); } }</style></body>`,
);

/** Serve the probe page on all interfaces (an Android emulator reaches the host at 10.0.2.2). */
export type ProbeServer = {
  server: Server;
  port: number;
  /** Resolves once the browser has asked for a page under `path` after `since` (ms epoch); false when `ms` pass first. */
  requested(path: string, since: number, ms: number): Promise<boolean>;
};

export function serveProbe(host = "127.0.0.1"): Promise<ProbeServer> {
  const seen: { path: string; at: number }[] = [];
  return new Promise((done) => {
    const server = createServer((req, res) => {
      seen.push({ path: req.url ?? "/", at: Date.now() });
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      res.end(req.url?.startsWith("/still") ? STILL_PAGE : req.url?.startsWith("/moving") ? MOVING_PAGE : PROBE_PAGE);
    });
    const requested = async (path: string, since: number, ms: number) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        if (seen.some((r) => r.at >= since && r.path.startsWith(path))) return true;
        await new Promise((r) => setTimeout(r, 200));
      }
      return false;
    };
    server.listen(0, host, () => done({ server, port: (server.address() as { port: number }).port, requested }));
  });
}
