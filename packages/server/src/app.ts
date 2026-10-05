import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage, Server } from "node:http";
import { extname, join, relative, resolve } from "node:path";
import { createAdaptorServer } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
import { WebSocketServer, type WebSocket } from "ws";
import { Annotation, AnnotationsFile, PRODUCT } from "@intentcue/core";
import { z } from "zod";
import { isLoopback, lanAddress, LanAuth, parseCookies } from "./lan.js";
import { qrSvg } from "./qr.js";
import { resolveRound, sendRound } from "./send.js";
import { ReviewStore, RoundLockedError } from "./store.js";

/** A capture run started from the canvas or triggered by the agent, as the canvas sees it. */
export type CaptureState = {
  running: boolean;
  phase: "idle" | "building" | "capturing" | "done" | "failed";
  trigger?: "gui" | "agent-applied";
  round?: number;
  total?: number;
  done?: number;
  current?: string;
  /** Screens still to capture (the canvas shows skeletons on them). */
  queue?: string[];
  /** Last lines of build output, or the error. */
  log?: string[];
  error?: string;
  /** Short summary when finished, e.g. "2 captured, 5 reused". */
  summary?: string;
};

export type CaptureRequest = {
  /** Recapture into this open round instead of starting a new one. */
  into?: number;
  screens?: string[];
  all?: boolean;
  /** Run app.build first (mobile). */
  build?: boolean;
  trigger?: CaptureState["trigger"];
};

export type CaptureRunner = (
  req: CaptureRequest,
  report: (patch: Partial<CaptureState>) => void,
) => Promise<{ round: number | null; summary: string; failed: { screenId: string; error: string }[] }>;

export type ServerEvent =
  | { type: "round-created"; round: number }
  | {
      type: "capture-progress";
      round: number;
      screens: { screenId: string; ok: boolean; error?: string }[];
      status: string;
      progress?: { total: number; done: number; current?: string; queue: string[] };
    }
  | { type: "capture-state"; state: CaptureState }
  | { type: "status-changed"; round: number; status: string }
  | { type: "lan-changed"; enabled: boolean; paired: number }
  | { type: "annotations-changed"; round: number; by: string };

export type ServerOptions = {
  projectDir: string;
  /** Built canvas (index.html + assets). */
  canvasDir?: string;
  port?: number;
  host?: string;
  lan?: boolean;
  /** Poll interval for the round watcher (ms). */
  watchMs?: number;
  /** Runs captures (provided by the CLI, which owns the capture adapters). Enables capture from the canvas. */
  runner?: CaptureRunner;
  /** Web: recapture automatically when the agent marks a round applied (default true). */
  autoRecapture?: boolean;
};

/** Hooks filled in by startServer once it is listening. */
type Controls = { enableLan?: () => Promise<string | null> };

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

export function createApp(opts: ServerOptions) {
  const store = new ReviewStore(opts.projectDir);
  const lan = new LanAuth();
  const lanState = { enabled: !!opts.lan, url: null as string | null };
  const controls: Controls = {};
  const sockets = new Set<WebSocket>();
  /** Sockets of paired devices, closed when they are unpaired. */
  const lanSockets = new Set<WebSocket>();
  const broadcast = (e: ServerEvent) => {
    const msg = JSON.stringify(e);
    for (const s of sockets) if (s.readyState === 1) s.send(msg);
  };

  /* ─────────── captures started from the canvas or by the agent ─────────── */
  let capture: CaptureState = { running: false, phase: "idle" };
  const setCapture = (patch: Partial<CaptureState>) => {
    capture = { ...capture, ...patch };
    broadcast({ type: "capture-state", state: capture });
  };
  /** Start a capture in the background; throws if one is running or no runner exists. */
  const runCapture = (req: CaptureRequest): void => {
    if (!opts.runner) throw new HttpError(501, "capture from the canvas needs `intentcue` or `intentcue open`");
    if (capture.running) throw new HttpError(409, "a capture is already running");
    capture = { running: true, phase: req.build ? "building" : "capturing", trigger: req.trigger ?? "gui", log: [] };
    broadcast({ type: "capture-state", state: capture });
    void opts
      .runner(req, setCapture)
      .then((r) => {
        setCapture({
          running: false,
          phase: r.failed.length && r.summary.startsWith("0 captured") ? "failed" : "done",
          summary: r.summary,
          ...(r.round !== null ? { round: r.round } : {}),
          ...(r.failed.length ? { error: r.failed.map((f) => `${f.screenId}: ${f.error}`).join("\n") } : {}),
          queue: [],
        });
        if (r.round !== null) broadcast({ type: "status-changed", round: r.round, status: "open" });
      })
      .catch((e: Error) => setCapture({ running: false, phase: "failed", error: e.message, queue: [] }));
  };

  const app = new Hono();

  /* ─────────── LAN guard ─────────── */
  const remoteOf = (c: Context) => {
    try {
      return getConnInfo(c).remote.address;
    } catch {
      return undefined;
    }
  };
  app.use("*", async (c, next) => {
    if (isLoopback(remoteOf(c))) return next();
    if (!lanState.enabled) return c.text("forbidden", 403);
    // pairing controls stay with the computer that runs intentcue
    if (new URL(c.req.url).pathname.startsWith("/api/lan")) return c.text("forbidden", 403);
    const url = new URL(c.req.url);
    if (url.pathname === "/pair") return next();
    const cookies = parseCookies(c.req.header("cookie"));
    if (lan.valid(cookies[lan.cookieName])) return next();
    return c.text("Not paired. On the computer running intentcue, click ▣ tablet and scan the new code.", 403);
  });

  app.get("/pair", (c) => {
    const session = lan.redeem(c.req.query("token"));
    if (!session) return c.text("Pairing link expired or already used. Show a new code with the ▣ tablet button in intentcue.", 403);
    c.header("Set-Cookie", `${lan.cookieName}=${session}; Path=/; HttpOnly; SameSite=Strict`);
    broadcast({ type: "lan-changed", enabled: true, paired: lan.paired });
    return c.redirect("/");
  });

  /* ─────────── API ─────────── */
  const roundParam = (c: Context) => {
    const n = Number(c.req.param("n"));
    if (!Number.isInteger(n) || n < 1) throw new HttpError(400, "bad round number");
    if (!existsSync(store.roundDir(n))) throw new HttpError(404, `round ${n} not found`);
    return n;
  };

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
    if (err instanceof RoundLockedError) return c.json({ error: err.message }, 409);
    if (err instanceof z.ZodError) return c.json({ error: "invalid body", issues: err.issues }, 400);
    console.error(err);
    return c.json({ error: String(err.message ?? err) }, 500);
  });

  app.get("/api/project", async (c) => {
    const manifest = await store.readManifest().catch((e: Error) => ({ error: e.message }));
    return c.json({
      folder: PRODUCT.folder,
      root: store.root,
      manifest,
      rounds: await store.listRounds(),
      latest: await store.latestRound(),
      lan: { enabled: lanState.enabled, paired: lan.paired },
      canCapture: !!opts.runner,
      autoRecapture: opts.autoRecapture !== false,
      capture,
    });
  });

  /* ─────────── capture ─────────── */
  app.get("/api/capture", (c) => c.json(capture));
  app.post("/api/capture", async (c) => {
    const body = z
      .object({ screens: z.array(z.string()).optional(), all: z.boolean().optional(), build: z.boolean().optional() })
      .parse(await c.req.json().catch(() => ({})));
    runCapture({ ...body, trigger: "gui" });
    return c.json(capture, 202);
  });

  /* ─────────── tablet pairing ─────────── */
  app.get("/api/lan", (c) => c.json({ enabled: lanState.enabled, paired: lan.paired, url: lanState.url, expiresAt: lan.tokenExpiresAt }));
  app.post("/api/lan", async (c) => {
    if (!controls.enableLan) return c.json({ error: "LAN mode is not available" }, 501);
    const base = await controls.enableLan();
    if (!base) return c.json({ error: "No local network address found. Is Wi-Fi on?" }, 503);
    lanState.enabled = true;
    const token = lan.issueToken();
    lanState.url = `${base}/pair?token=${token}`;
    broadcast({ type: "lan-changed", enabled: true, paired: lan.paired });
    return c.json({ enabled: true, paired: lan.paired, url: lanState.url, expiresAt: lan.tokenExpiresAt, qr: qrSvg(lanState.url) });
  });
  app.delete("/api/lan", (c) => {
    lan.revokeAll();
    lanState.url = null;
    for (const s of lanSockets) s.close(4001, "unpaired");
    broadcast({ type: "lan-changed", enabled: lanState.enabled, paired: 0 });
    return c.json({ enabled: lanState.enabled, paired: 0, url: null, expiresAt: 0 });
  });

  app.get("/api/rounds", async (c) => {
    const rounds = await store.listRounds();
    const out = [];
    for (const n of rounds) {
      const s = await store.readStatus(n).catch(() => null);
      const anns = await store.readAnnotations(n).catch(() => []);
      out.push({ round: n, status: s?.status ?? "unknown", createdAt: s?.createdAt, annotations: anns.length });
    }
    return c.json(out);
  });

  app.get("/api/rounds/:n", async (c) => {
    const n = roundParam(c);
    const manifest = await store.readManifest().catch(() => null);
    const status = await store.readStatus(n);
    const captures = await store.readCaptures(n);
    const annotations = await store.readAnnotations(n);
    const entries = manifest?.screens ?? [];
    const known = new Set(entries.map((s) => s.id));
    const failures = new Map((status.screens ?? []).filter((s) => !s.ok).map((s) => [s.screenId, s.error]));
    const capInfo = new Map((status.screens ?? []).map((s) => [s.screenId, s]));
    const screens = [
      ...entries,
      ...[...captures.keys()].filter((id) => !known.has(id)).map((id) => ({ id, title: id, group: undefined })),
    ]
      .filter((s) => captures.has(s.id) || failures.has(s.id) || status.status === "capturing")
      .map((s) => {
        const cap = captures.get(s.id);
        return {
          id: s.id,
          title: s.title,
          group: s.group ?? "Screens",
          captured: !!cap,
          error: failures.get(s.id),
          reusedFrom: capInfo.get(s.id)?.reusedFrom,
          reason: capInfo.get(s.id)?.reason,
          platform: cap?.platform,
          device: cap?.device,
          size: cap ? { width: cap.root.bounds.w, height: cap.root.bounds.h } : undefined,
          // cache-buster: a recapture rewrites the same file name
          screenshot: cap
            ? `/files/rounds/${String(n).padStart(3, "0")}/${cap.screenshot}?v=${Date.parse(cap.capturedAt) || 0}`
            : undefined,
        };
      });
    return c.json({ round: n, status, app: manifest?.app, screens, annotations, canRecapture: !!opts.runner });
  });

  app.post("/api/rounds/:n/recapture", async (c) => {
    const n = roundParam(c);
    const body = z.object({ screens: z.array(z.string()).min(1) }).parse(await c.req.json());
    runCapture({ into: n, screens: body.screens, trigger: "gui" });
    return c.json(capture, 202);
  });

  app.get("/api/rounds/:n/screens/:id", async (c) => {
    const n = roundParam(c);
    const cap = await store.readCapture(n, c.req.param("id"));
    if (!cap) return c.json({ error: "screen not captured" }, 404);
    return c.json(cap);
  });

  app.put("/api/rounds/:n/annotations", async (c) => {
    const n = roundParam(c);
    const body = await c.req.json();
    const list = Array.isArray(body) ? z.array(Annotation).parse(body) : AnnotationsFile.parse({ version: 1, round: n, ...body }).annotations;
    await store.writeAnnotations(n, list);
    broadcast({ type: "annotations-changed", round: n, by: c.req.header("x-client-id") ?? "" });
    return c.json({ ok: true, count: list.length });
  });

  app.delete("/api/rounds/:n/screens/:id", async (c) => {
    const n = roundParam(c);
    const id = c.req.param("id");
    if (!(await store.readCapture(n, id)) && !(await store.readStatus(n)).screens?.some((s) => s.screenId === id))
      throw new HttpError(404, `no screen "${id}" in round ${n}`);
    const { notes } = await store.removeScreen(n, id);
    broadcast({ type: "annotations-changed", round: n, by: "server" });
    return c.json({ removed: id, notes });
  });

  app.post("/api/rounds/:n/resolve", async (c) => {
    const n = roundParam(c);
    return c.json({ annotations: await resolveRound(store, n) });
  });

  app.post("/api/rounds/:n/send", async (c) => {
    const n = roundParam(c);
    const result = await sendRound(store, n);
    broadcast({ type: "status-changed", round: n, status: "sent" });
    return c.json(result);
  });

  app.get("/api/rounds/:n/review", async (c) => {
    const n = roundParam(c);
    const md = await store.readText(join("rounds", String(n).padStart(3, "0"), "review.md"));
    if (md === null) return c.json({ error: "not sent yet" }, 404);
    return c.text(md);
  });

  app.get("/api/rules", async (c) => c.text((await store.readText("rules.md")) ?? ""));

  /* ─────────── files from .intentcue (read-only) ─────────── */
  app.get("/files/*", async (c) => {
    const rel = decodeURIComponent(new URL(c.req.url).pathname.slice("/files/".length));
    const p = store.safePath(rel);
    const ext = extname(rel).toLowerCase();
    if (!p || ![".png", ".json", ".md"].includes(ext)) return c.text("not found", 404);
    return sendFile(c, p);
  });

  /* ─────────── canvas ─────────── */
  app.get("*", async (c) => {
    if (!opts.canvasDir) return c.text("intentcue server running; canvas build not found", 200);
    const url = new URL(c.req.url);
    const p = resolve(opts.canvasDir, "." + decodeURIComponent(url.pathname));
    const inside = !relative(opts.canvasDir, p).startsWith("..");
    if (inside && existsSync(p) && (await stat(p)).isFile()) return sendFile(c, p, url.pathname.startsWith("/assets/"));
    return sendFile(c, join(opts.canvasDir, "index.html"));
  });

  return { app, store, lan, lanState, controls, sockets, lanSockets, broadcast, runCapture, getCapture: () => capture };
}

async function sendFile(c: Context, p: string, immutable = false) {
  if (!existsSync(p)) return c.text("not found", 404);
  const body = await readFile(p);
  c.header("Content-Type", MIME[extname(p).toLowerCase()] ?? "application/octet-stream");
  c.header("Cache-Control", immutable ? "public, max-age=31536000, immutable" : "no-cache");
  return c.body(body);
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Start the HTTP + WebSocket server and the round watcher.
 * Resolves once listening.
 */
export async function startServer(opts: ServerOptions) {
  const { app, store, lan, lanState, controls, sockets, lanSockets, broadcast, runCapture, getCapture } = createApp(opts);
  const port = opts.port ?? PRODUCT.defaultPort;
  const host = opts.host ?? (opts.lan ? "0.0.0.0" : "127.0.0.1");

  const wss = new WebSocketServer({ noServer: true });
  const onUpgrade = (req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname !== "/ws") return socket.destroy();
    const remote = req.socket.remoteAddress;
    const cookies = parseCookies(req.headers.cookie);
    if (!isLoopback(remote) && !(lanState.enabled && lan.valid(cookies[lan.cookieName]))) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      if (!isLoopback(remote)) lanSockets.add(ws);
      ws.on("close", () => {
        sockets.delete(ws);
        lanSockets.delete(ws);
      });
      ws.send(JSON.stringify({ type: "hello" }));
    });
  };
  const listen = async (h: string, p: number) => {
    const srv = createAdaptorServer({ fetch: app.fetch }) as unknown as Server;
    srv.on("upgrade", onUpgrade);
    await new Promise<void>((res, rej) => {
      srv.once("error", rej);
      srv.listen(p, h, () => res());
    });
    return srv;
  };

  const server = await listen(host, port);
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  const servers = [server];

  // LAN on demand: a second listener on the local network address, same port
  controls.enableLan = async () => {
    const ip = lanAddress();
    if (!ip) return null;
    if (host !== "0.0.0.0" && !servers.some((s) => (s.address() as { address?: string } | null)?.address === ip)) {
      servers.push(await listen(ip, actualPort));
    }
    return `http://${ip}:${actualPort}`;
  };

  // web: the agent marking a round applied triggers the next capture
  const onStatus = async (round: number, status: string) => {
    if (status !== "applied" || !opts.runner || opts.autoRecapture === false || getCapture().running) return;
    const manifest = await store.readManifest().catch(() => null);
    if (manifest?.app.platform !== "web") return;
    setTimeout(() => {
      try {
        runCapture({ trigger: "agent-applied" });
      } catch {
        /* already running */
      }
    }, 1500); // give the dev server a moment to hot-reload
    void round;
  };
  const stopWatch = watchRounds(store, broadcast, opts.watchMs ?? 700, onStatus);

  return {
    port: actualPort,
    host,
    store,
    lan,
    broadcast,
    enableLan: () => controls.enableLan!(),
    runCapture,
    close: async () => {
      stopWatch();
      for (const s of sockets) s.close();
      wss.close();
      await Promise.all(servers.map((srv) => new Promise<void>((r) => srv.close(() => r()))));
    },
  };
}

/** Poll the latest round pointer and its status.json; broadcast changes. */
export function watchRounds(
  store: ReviewStore,
  broadcast: (e: ServerEvent) => void,
  everyMs: number,
  onStatus?: (round: number, status: string) => void,
) {
  let lastRound: number | null = null;
  let lastMtime = 0;
  let lastStatus = "";
  let busy = false;
  let initialized = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const n = await store.latestRound();
      if (n === null) return;
      if (initialized && n !== lastRound) broadcast({ type: "round-created", round: n });
      if (n !== lastRound) {
        lastRound = n;
        lastMtime = 0;
      }
      const m = await store.statusMtime(n);
      if (m !== lastMtime) {
        lastMtime = m;
        const s = await store.readStatus(n).catch(() => null);
        if (s) {
          if (s.status === "capturing")
            broadcast({ type: "capture-progress", round: n, screens: s.screens ?? [], status: s.status, ...(s.progress ? { progress: s.progress } : {}) });
          if (initialized && s.status !== lastStatus) {
            broadcast({ type: "status-changed", round: n, status: s.status });
            onStatus?.(n, s.status);
          }
          lastStatus = s.status;
        }
      }
      initialized = true;
    } finally {
      busy = false;
    }
  };
  void tick();
  const t = setInterval(() => void tick(), everyMs);
  return () => clearInterval(t);
}
