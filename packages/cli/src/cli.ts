#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cac } from "cac";
import { createAdapter } from "@intentcue/capture";
import { Platform, PRODUCT, ReviewJson } from "@intentcue/core";
import { lanAddress, ReviewStore, startServer } from "@intentcue/server";
import { captureRound, describePlan, type CaptureEvent } from "./capture.js";
import { runMcp } from "./mcp.js";
import { makeRunner } from "./runner.js";
import { detectProject } from "./setup.js";
import { openBrowser, start } from "./start.js";
import { banner, c, errLine, fail, line, okLine, out, warnLine } from "./ui.js";

const VERSION = "0.1.0";
const here = dirname(fileURLToPath(import.meta.url));

type Flags = {
  all?: boolean;
  dryRun?: boolean;
  dir?: string;
  platform?: string;
  device?: string;
  screens?: string;
  port?: number;
  open?: boolean;
  lan?: boolean;
  name?: string;
};

const storeFor = (f: Flags) => new ReviewStore(resolve(f.dir ?? process.cwd()));

function requireInit(store: ReviewStore) {
  if (!store.exists()) fail(`No ${PRODUCT.folder}/ folder in ${store.root}`, "Run: npx intentcue init");
}

function platformFlag(f: Flags): Platform | undefined {
  if (!f.platform) return undefined;
  const p = Platform.safeParse(f.platform);
  if (!p.success) fail(`--platform must be ios, android or web (got "${f.platform}")`);
  return p.data;
}

function canvasDir(): string | undefined {
  const candidates = [join(here, "canvas"), join(here, "../../canvas/dist"), join(here, "../canvas")];
  return candidates.find((p) => existsSync(join(p, "index.html")));
}


/* ─────────────────────────── commands ─────────────────────────── */

async function cmdInit(f: Flags) {
  const store = storeFor(f);
  banner("init");
  const info = detectProject(store.root);
  const platform: Platform = platformFlag(f) ?? info.platform;
  const appId = platform === "android" ? info.android?.appId : platform === "ios" ? info.ios?.bundleId : undefined;
  const build = platform === "android" ? info.android?.build : platform === "ios" ? info.ios?.build : undefined;
  const created = await store.init({ platform, name: f.name ?? info.name, appId, build });
  out();
  line("project", store.root);
  line("platform", `${platform}${f.platform ? "" : c.dim("  (detected; change with --platform)")}`);
  out();
  if (created.length === 0) okLine("Already initialised. Nothing to do.");
  for (const p of created) okLine(p);
  out();
  out(`  Next: run ${c.accent("intentcue")}; it walks you through the rest.`);
  out();
}

async function cmdDoctor(f: Flags) {
  const store = storeFor(f);
  requireInit(store);
  banner("doctor");
  out();
  let manifest;
  try {
    manifest = await store.readManifest();
    okLine(`${PRODUCT.folder}/screens.json  ${c.dim(`${manifest.screens.length} screens, ${manifest.app.platform}`)}`);
  } catch (e) {
    fail((e as Error).message);
  }
  const platform = platformFlag(f) ?? manifest.app.platform;
  const node = Number(process.versions.node.split(".")[0]);
  if (node >= 20) okLine(`node ${process.versions.node}`);
  else errLine(`node ${process.versions.node}; intentcue needs Node 20+`);

  const adapter = createAdapter(platform, { reviewDir: store.dir, roundDir: store.dir, manifest, device: f.device ?? manifest.app.device });
  const r = await adapter.check();
  await adapter.dispose?.();
  if (r.ok) okLine(`${platform} capture ready`);
  for (const p of r.problems) {
    const [first, ...rest] = p.split("\n");
    errLine(first!);
    for (const l of rest) out(`    ${c.dim(l.trim())}`);
  }
  for (const s of manifest.screens) {
    if (platform === "web" && !s.url) warnLine(`screen "${s.id}" has no url`);
    if (platform !== "web" && s.flow && !existsSync(resolve(store.dir, s.flow)))
      warnLine(`screen "${s.id}": flow not found: ${PRODUCT.folder}/${s.flow}`);
    if (platform === "web" && s.setup && !existsSync(resolve(store.dir, s.setup)))
      warnLine(`screen "${s.id}": setup script not found: ${PRODUCT.folder}/${s.setup}`);
  }
  out();
  if (!r.ok) process.exit(1);
}

async function cmdCapture(f: Flags): Promise<number | null> {
  const store = storeFor(f);
  requireInit(store);
  banner("capture");
  out();
  const screens = f.screens ? String(f.screens).split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  const t0 = Date.now();
  let result;
  try {
    result = await captureRound(store, { platform: platformFlag(f), device: f.device, screens, all: f.all, dryRun: f.dryRun, log: printEvent });
  } catch (e) {
    fail((e as Error).message);
  }
  if (!result) {
    out();
    out(c.dim("  Fix the problems above, then run capture again.  npx intentcue doctor"));
    out();
    process.exit(1);
  }
  if (f.dryRun) {
    out();
    for (const i of result.plan.items)
      out(`  ${i.action === "capture" ? c.accent("capture") : c.dim("reuse  ")}  ${i.screenId.padEnd(24)} ${c.dim(i.reason)}`);
    out(c.dim("\n  dry run: nothing was captured\n"));
    return null;
  }
  if (result.skipped) {
    okLine(`Nothing to capture: ${result.plan.why}. Round ${String(result.round).padStart(3, "0")} is current.`);
    out(c.dim("    Recapture anyway with --all, or pick screens with --screens a,b"));
    out();
    return result.round;
  }
  out();
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const reused = result.reused.length ? `, ${result.reused.length} reused` : "";
  line("round", `${c.accent(String(result.round).padStart(3, "0"))}  ${c.dim(`${result.ok.length} captured${reused}, ${result.failed.length} failed, ${secs}s`)}`);
  line("folder", c.dim(`${PRODUCT.folder}/rounds/${String(result.round).padStart(3, "0")}`));
  out();
  if (result.ok.length === 0 && result.reused.length === 0) fail("No screen captured.");
  return result.round;
}

function printEvent(e: CaptureEvent) {
  switch (e.type) {
    case "check-failed":
      errLine("Capture cannot start:");
      for (const p of e.problems) for (const l of p.split("\n")) out(`    ${c.dim(l.trim())}`);
      break;
    case "plan": {
      line("plan", describePlan(e.plan, e.previous));
      const reused = e.plan.items.filter((i) => i.action === "reuse");
      if (reused.length && !e.plan.full)
        out(`  ${" ".repeat(12)} ${c.dim(`reused: ${reused.map((i) => i.screenId).join(", ")}`)}`);
      break;
    }
    case "round":
      line("round", `${String(e.round).padStart(3, "0")}${e.reused ? c.dim("  (refreshing the open, unannotated round)") : ""}`);
      out();
      break;
    case "screen-start":
      process.stdout.write(`  ${c.dim(`[${e.index + 1}/${e.total}]`)} ${e.screenId} ${c.dim(`(${e.reason})`)} `);
      break;
    case "screen-done":
      process.stdout.write(`${c.ok("✓")} ${c.dim(`${e.elements} elements · ${e.ms}ms`)}\n`);
      break;
    case "screen-failed":
      process.stdout.write(`${c.err("✗")} ${e.error}\n`);
      if (e.detail) for (const l of e.detail.split("\n").slice(-6)) out(`      ${c.dim(l)}`);
      break;
  }
}

async function cmdOpen(f: Flags) {
  const store = storeFor(f);
  requireInit(store);
  const dir = canvasDir();
  if (!dir) warnLine("canvas build not found; run `pnpm build` in the intentcue repo");
  let srv;
  try {
    srv = await startServer({
      projectDir: store.root,
      canvasDir: dir,
      port: f.port,
      lan: f.lan,
      runner: makeRunner(store, { platform: platformFlag(f), device: f.device }, printEvent),
    });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "EADDRINUSE")
      fail(`Port ${f.port ?? PRODUCT.defaultPort} is in use.`, "Is intentcue already open? Otherwise pass --port <n>.");
    throw e;
  }
  const url = `http://127.0.0.1:${srv.port}/`;
  const latest = await store.latestRound();
  banner("open");
  if (latest === null) {
    out();
    warnLine(`No rounds yet. Run ${c.accent("npx intentcue capture")} in another terminal; the canvas updates live.`);
  }
  out();
  line("canvas", c.accent(url));
  if (latest !== null) line("round", String(latest).padStart(3, "0"));
  if (f.lan) {
    const ip = lanAddress();
    if (!ip) warnLine("No LAN address found; --lan needs a network connection.");
    else {
      const token = srv.lan.issueToken();
      const pairUrl = `http://${ip}:${srv.port}/pair?token=${token}`;
      line("lan", `${pairUrl}  ${c.dim("(one-time, 10 min)")}`);
      out();
      try {
        const qr = (await import("qrcode-terminal")) as unknown as { default?: QR } & QR;
        (qr.default ?? qr).generate(pairUrl, { small: true }, (s: string) => out(s.replace(/^/gm, "  ")));
      } catch {
        /* no QR */
      }
    }
  }
  out();
  out(c.dim("  ctrl+c to stop"));
  if (f.open !== false) openBrowser(url);
  const stop = async () => {
    await srv.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
type QR = { generate(s: string, o: { small: boolean }, cb: (s: string) => void): void };

async function cmdStatus(f: Flags) {
  const store = storeFor(f);
  requireInit(store);
  const n = await store.latestRound();
  banner("status");
  out();
  if (n === null) {
    line("round", c.dim("none yet"));
    out(`\n  Run ${c.accent("npx intentcue capture")}\n`);
    return;
  }
  const s = await store.readStatus(n);
  const anns = await store.readAnnotations(n);
  const caps = await store.readCaptures(n);
  const stateColor = { capturing: c.warn, open: c.accent, sent: c.ok, applied: c.dim }[s.status] ?? c.dim;
  line("round", `${String(n).padStart(3, "0")}  ${stateColor(s.status)}`);
  line("screens", `${caps.size} captured${(s.screens ?? []).some((x) => !x.ok) ? c.err(`, ${(s.screens ?? []).filter((x) => !x.ok).length} failed`) : ""}`);
  line("annotations", String(anns.length));
  const reviewPath = store.path("rounds", String(n).padStart(3, "0"), "review.json");
  if (existsSync(reviewPath)) {
    const r = ReviewJson.parse(JSON.parse(readFileSync(reviewPath, "utf8")));
    line("instructions", `${r.counts.instructions}  ${c.dim(`unresolved ${r.counts.unresolved} · rules ${r.counts.rules}`)}`);
  }
  if (s.status === "sent") out(`\n  ${c.dim("agent prompt:")} Implement ${PRODUCT.folder}/latest/review.md`);
  out();
}

/* ─────────────────────────── wiring ─────────────────────────── */

const cli = cac("intentcue");
const common = (cmd: ReturnType<typeof cli.command>) =>
  cmd
    .option("--dir <path>", "Project directory (default: current directory)")
    .option("--platform <platform>", "ios | android | web (default: from screens.json)")
    .option("--device <name>", "Simulator / emulator name, udid or serial");

common(cli.command("init", "Create .intentcue/ and add the agent section to AGENTS.md"))
  .option("--name <name>", "App name for screens.json")
  .action((f: Flags) => cmdInit(f));

common(cli.command("doctor", "Check platform tools and devices, print fixes")).action((f: Flags) => cmdDoctor(f));

common(cli.command("capture", "Create a new round: run every screen's flow, capture screenshot and tree"))
  .option("--screens <ids>", "Comma-separated screen ids to capture; the rest are reused")
  .option("--all", "Recapture every screen (default: only screens that may have changed)")
  .option("--dry-run", "Show which screens would be captured or reused, then stop")
  .action(async (f: Flags) => {
    await cmdCapture(f);
  });

common(cli.command("open", "Start the server and open the canvas on the latest round"))
  .option("--port <port>", "Port", { default: PRODUCT.defaultPort })
  .option("--no-open", "Do not open a browser")
  .option("--lan", "Also listen on the local network, paired with a one-time QR code")
  .action((f: Flags) => cmdOpen(f));

common(cli.command("status", "Print the latest round's state and counts")).action((f: Flags) => cmdStatus(f));

cli
  .command("mcp", "Start the MCP server over stdio")
  .option("--dir <path>", "Project directory")
  .action((f: Flags) => runMcp(storeFor(f)));

common(cli.command("", "Set up on first run, then open the canvas (captures when there is nothing yet)"))
  .option("--port <port>", "Port", { default: PRODUCT.defaultPort })
  .option("--no-open", "Do not open a browser")
  .option("--lan", "Also listen on the local network")
  .action(async (f: Flags) => {
    await start(storeFor(f), {
      platform: platformFlag(f),
      device: f.device,
      port: f.port,
      open: f.open,
      lan: f.lan,
      canvasDir: canvasDir(),
      printEvent,
    });
  });

cli.help();
cli.version(VERSION);

try {
  cli.parse(process.argv, { run: false });
  await cli.runMatchedCommand();
} catch (e) {
  fail((e as Error).message);
}
