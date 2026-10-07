import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { app, crashReporter, dialog, shell } from "electron";

/**
 * Crash reporting that stays on this computer: Electron's crash dumps (never
 * uploaded), and a log of errors and crashed processes. When something
 * crashed, the next launch offers to show the files or open a GitHub issue
 * the user can read and edit before sending. Nothing is sent by the app.
 */

export const ISSUES = "https://github.com/chicreativetech/scribui/issues/new";

export type CrashRecord = { at: string; kind: "exception" | "rejection" | "renderer" | "child"; message: string; stack?: string };

let logFile = "";
let recordsFile = "";
let reviewedFile = "";

/** Call first thing in the app's own process (after the sRGB relaunch), before `ready`. */
export function startCrashReporting() {
  // named explicitly: before the app is ready a development run would be called "Electron"
  app.setAppLogsPath(process.platform === "darwin" ? join(homedir(), "Library/Logs/ScribUI") : join(app.getPath("userData"), "logs"));
  const logs = app.getPath("logs");
  mkdirSync(logs, { recursive: true });
  logFile = join(logs, "main.log");
  recordsFile = join(app.getPath("userData"), "crashes.json");
  reviewedFile = join(app.getPath("userData"), "crashes-reviewed.json");
  rotate(logFile);
  crashReporter.start({ uploadToServer: false, compress: true });
  log(`start ScribUI ${app.getVersion()} (Electron ${process.versions.electron}, ${process.platform} ${process.arch})`);

  process.on("uncaughtException", (e) => record({ kind: "exception", message: e.message, ...(e.stack ? { stack: e.stack } : {}) }));
  process.on("unhandledRejection", (r) => {
    const e = r instanceof Error ? r : new Error(String(r));
    record({ kind: "rejection", message: e.message, ...(e.stack ? { stack: e.stack } : {}) });
  });
  app.on("render-process-gone", (_e, wc, d) => {
    if (d.reason !== "clean-exit") record({ kind: "renderer", message: `a window's page ${d.reason} (exit ${d.exitCode}) at ${safeUrl(wc.getURL())}` });
  });
  app.on("child-process-gone", (_e, d) => {
    if (d.reason !== "clean-exit") record({ kind: "child", message: `${d.type}${d.name ? ` (${d.name})` : ""} ${d.reason} (exit ${d.exitCode})` });
  });
}

/** Only the origin and path: query strings can hold tokens. */
const safeUrl = (u: string) => {
  try {
    const x = new URL(u);
    return x.protocol === "file:" ? "file" : `${x.origin}${x.pathname}`;
  } catch {
    return "";
  }
};

export function log(line: string) {
  if (!logFile) return;
  try {
    appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* no log is better than a crash in the crash handler */
  }
}

/** Keep one older log; start a new one past 1 MB. */
function rotate(file: string) {
  try {
    if (existsSync(file) && statSync(file).size > 1_000_000) renameSync(file, `${file}.1`);
  } catch {
    /* keep appending */
  }
}

function record(r: Omit<CrashRecord, "at">) {
  const rec: CrashRecord = { at: new Date().toISOString(), ...r };
  log(`${rec.kind}: ${rec.message}${rec.stack ? `\n${rec.stack}` : ""}`);
  try {
    const list = readRecords().slice(-19);
    writeFileSync(recordsFile, JSON.stringify([...list, rec], null, 1));
  } catch {
    /* logged above */
  }
}

function readRecords(): CrashRecord[] {
  try {
    return JSON.parse(readFileSync(recordsFile, "utf8")) as CrashRecord[];
  } catch {
    return [];
  }
}

/** Crash dumps newer than `since` (ms): native crashes of the app's own processes. */
function dumpsSince(since: number): string[] {
  const dir = app.getPath("crashDumps");
  const found: string[] = [];
  const walk = (d: string) => {
    let entries: string[] = [];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const f of entries) {
      const p = join(d, f);
      try {
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else if (/\.dmp$/.test(f) && st.mtimeMs > since) found.push(p);
      } catch {
        /* gone meanwhile */
      }
    }
  };
  walk(dir);
  return found;
}

/** What happened since the last launch that's worth telling: recorded errors and new crash dumps. */
export function crashesSince(records: CrashRecord[], dumps: string[], since: number): { records: CrashRecord[]; dumps: number } {
  return { records: records.filter((r) => Date.parse(r.at) > since), dumps: dumps.length };
}

/**
 * At launch: when something crashed since the last launch (in the last run,
 * however it ended), say so once and offer the files or a prefilled issue.
 */
export async function reviewCrashes() {
  let since = 0;
  try {
    since = (JSON.parse(readFileSync(reviewedFile, "utf8")) as { at: number }).at;
  } catch {
    /* first launch: nothing to report yet */
  }
  try {
    writeFileSync(reviewedFile, JSON.stringify({ at: Date.now() }));
  } catch {
    /* asks again next time */
  }
  if (!since) return;
  const found = crashesSince(readRecords(), dumpsSince(since), since);
  if (!found.records.length && !found.dumps) return;
  const what = found.records.length ? found.records[found.records.length - 1]!.message : "it crashed";
  const { response } = await dialog.showMessageBox({
    type: "warning",
    message: "ScribUI had a problem last time",
    detail: `${what}\n\nThe crash report stays on your computer. You can open a GitHub issue with the details below filled in (you see and edit everything before sending), or look at the files.`,
    buttons: ["Report on GitHub…", "Show Crash Files", "Close"],
    defaultId: 0,
    cancelId: 2,
  });
  if (response === 0) void shell.openExternal(issueUrl({ ...environment(), records: found.records, dumps: found.dumps }));
  if (response === 1) showCrashFiles();
}

const environment = () => ({ version: app.getVersion(), electron: process.versions.electron, os: `${process.platform} ${process.getSystemVersion()} ${process.arch}` });

export const showCrashFiles = () => void shell.openPath(app.getPath("logs"));

/** "Report a Problem…" from the Help menu: an issue with the environment filled in. */
export const reportProblem = () => void shell.openExternal(issueUrl({ ...environment(), records: [], dumps: 0 }));

/** A new-issue link with the environment and recent errors; home folders become ~, and it stays within URL limits. */
export function issueUrl(o: { version: string; electron: string; os: string; records: CrashRecord[]; dumps: number }, home = homedir()): string {
  const scrub = (s: string) => s.split(home).join("~");
  const crashed = o.records.length || o.dumps;
  const lines = [
    crashed ? "**What were you doing when ScribUI crashed?**" : "**What happened, and what did you expect?**",
    "",
    "",
    "---",
    `ScribUI ${o.version} · Electron ${o.electron} · ${o.os}`,
  ];
  if (o.dumps) lines.push(`${o.dumps} crash dump${o.dumps === 1 ? "" : "s"} on this computer (attach if asked)`);
  for (const r of o.records.slice(-3)) {
    lines.push("", `${r.kind} at ${r.at}: ${scrub(r.message)}`);
    if (r.stack) lines.push("```", scrub(r.stack).split("\n").slice(0, 12).join("\n"), "```");
  }
  let body = lines.join("\n");
  const title = crashed ? `Crash: ${scrub(o.records[o.records.length - 1]?.message ?? "native crash").slice(0, 80)}` : "";
  // browsers and GitHub cut very long links; keep the start (the question and the environment)
  if (body.length > 5000) body = body.slice(0, 5000) + "\n…";
  return `${ISSUES}?${new URLSearchParams({ ...(title ? { title } : {}), body }).toString()}`;
}
