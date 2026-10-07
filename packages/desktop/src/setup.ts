import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { parse, resolve } from "node:path";
import type { Platform } from "@scribui/core";
import { detectDevServers, detectProject, pageTitle } from "@scribui/project";
import type { ReviewStore } from "@scribui/server";

/**
 * First-time setup of a folder in the app: what the CLI asks in the terminal
 * on its first run (platform, where the web app runs or the mobile app's id
 * and build command), as data for the projects window's setup screens.
 * Everything the window sends back is checked here. Screens are captured by
 * hand afterwards, in the App tab (web) or the Device tab (Android, iOS).
 */

export type SetupInfo = {
  dir: string;
  name: string;
  /** The platform detected from the folder's files (mobile projects can usually be either). */
  detected: Platform;
  /** What was found, for the platform cards. */
  found: { web: string | null; android: string | null; ios: string | null };
  /** iOS is only offered on a Mac. */
  iosAvailable: boolean;
  android?: { appId?: string; build?: string };
  ios?: { bundleId?: string; build?: string };
  /** The folder is unlikely to be an app's (the home folder, a drive's root, no project files). */
  warning: string | null;
};

export function setupInfo(dir: string, os: NodeJS.Platform = process.platform): SetupInfo {
  const info = detectProject(dir);
  const has = (p: string) => existsSync(resolve(dir, p));
  const web = info.kind === "web" ? (info.hasPackageJson ? `package.json (${info.packageManager})` : has("index.html") ? "index.html" : null) : null;
  return {
    dir,
    name: info.name,
    detected: info.platform === "ios" && os !== "darwin" ? "android" : info.platform,
    found: {
      web,
      android: info.android ? (info.android.build ? `Android project · ${info.android.build}` : "Android project") : null,
      ios: info.ios ? (info.ios.build ? `iOS project · ${info.ios.build}` : "Xcode project") : null,
    },
    iosAvailable: os === "darwin",
    ...(info.android ? { android: info.android } : {}),
    ...(info.ios ? { ios: info.ios } : {}),
    warning: folderWarning(dir, info.hasPackageJson || !!info.android || !!info.ios),
  };
}

function folderWarning(dir: string, projectFiles: boolean): string | null {
  const root = resolve(dir);
  if (root === resolve(homedir())) return "This is your home folder. ScribUI adds a .scribui folder and an AGENTS.md here; pick your app's own folder instead.";
  if (root === parse(root).root) return "This is the root of a drive; pick your app's own folder instead.";
  if (!projectFiles) {
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {
      /* unreadable: say nothing more */
    }
    if (!entries.some((f) => /\.(html?|jsx?|tsx?|vue|svelte|dart|kt|swift)$/i.test(f) || f === "src" || f === "app"))
      return "No app files were found here (no package.json, Gradle or Xcode project). Set it up anyway if this is your app's folder.";
  }
  return null;
}

/** The window's answers, checked: a known platform, a web URL, an app id and build command that fit on a line. */
export type SetupAnswers = { platform: Platform; baseUrl?: string; appId?: string; build?: string };

export function checkAnswers(v: unknown, os: NodeJS.Platform = process.platform): { ok: true; answers: SetupAnswers } | { ok: false; error: string } {
  const a = (v ?? {}) as Record<string, unknown>;
  const platform = a.platform;
  if (platform !== "web" && platform !== "android" && platform !== "ios") return { ok: false, error: "Pick a platform." };
  if (platform === "ios" && os !== "darwin") return { ok: false, error: "iOS needs a Mac with Xcode (it runs the iOS Simulator)." };
  if (platform === "web") {
    const url = normalizeUrl(a.baseUrl);
    if (!url) return { ok: false, error: "Enter a port (3000) or a URL (http://localhost:3000)." };
    return { ok: true, answers: { platform, baseUrl: url } };
  }
  const appId = typeof a.appId === "string" ? a.appId.trim() : "";
  if (appId && !/^[A-Za-z][\w-]*(\.[A-Za-z0-9_-]+)+$/.test(appId))
    return { ok: false, error: `"${appId}" isn't an app id (like com.example.app).` };
  const build = typeof a.build === "string" ? a.build.trim() : "";
  if (build.length > 500 || /[\r\n]/.test(build)) return { ok: false, error: "The build command must be a single line." };
  return { ok: true, answers: { platform, ...(appId ? { appId } : {}), ...(build ? { build } : {}) } };
}

/** "3000", "localhost:3000" or a full http(s) URL → a base URL without a trailing slash; null when it's none of these. */
export function normalizeUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (/^\d{1,5}$/.test(s)) return Number(s) > 0 && Number(s) < 65536 ? `http://localhost:${s}` : null;
  const withScheme = /^[a-z][\w+.-]*:\/\//i.test(s) ? s : /^[\w.-]+(:\d{1,5})?(\/\S*)?$/.test(s) ? `http://${s}` : null;
  if (!withScheme) return null;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

/** Dev servers answering now (this folder's first), with page titles, plus a few common ports that don't answer yet. */
export async function devServers(dir: string): Promise<{ url: string; running: boolean; title: string | null }[]> {
  const running = await detectDevServers(dir);
  const titles = await Promise.all(running.map(pageTitle));
  const idle = ["http://localhost:3000", "http://localhost:5173", "http://localhost:8080"].filter((u) => !running.includes(u));
  return [...running.map((url, i) => ({ url, running: true, title: titles[i] ?? null })), ...idle.slice(0, Math.max(0, 3 - running.length)).map((url) => ({ url, running: false, title: null }))];
}

/** Write the folder contract (screens.json, the guide, rules, flows, the AGENTS.md section). */
export async function createProject(store: ReviewStore, name: string, a: SetupAnswers): Promise<string[]> {
  return store.init({ ...a, name });
}
