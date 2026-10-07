import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { run } from "@scribui/capture";
import type { Platform } from "@scribui/core";

/**
 * What a folder holds before ScribUI is set up there: the kind of app, its
 * platform(s), ids and build commands, and the dev servers answering on this
 * machine. Shared by the CLI's first run and the desktop app's setup.
 */

export type ProjectInfo = {
  name: string;
  kind: "web" | "mobile";
  /** Best guess; for mobile the user confirms. */
  platform: Platform;
  hasPackageJson: boolean;
  packageManager: "npm" | "pnpm" | "yarn" | "bun";
  android?: { appId?: string; build?: string };
  ios?: { bundleId?: string; build?: string };
};

const read = (p: string) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
};

export function detectProject(root: string): ProjectInfo {
  const has = (p: string) => existsSync(join(root, p));
  const pkgText = read(join(root, "package.json"));
  let pkg: { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
  try {
    pkg = pkgText ? JSON.parse(pkgText) : {};
  } catch {
    /* ignore */
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const rn = !!deps["react-native"];
  const expo = !!deps["expo"];
  const flutter = has("pubspec.yaml");

  const packageManager: ProjectInfo["packageManager"] = has("pnpm-lock.yaml")
    ? "pnpm"
    : has("yarn.lock")
      ? "yarn"
      : has("bun.lockb") || has("bun.lock")
        ? "bun"
        : "npm";

  // Android (Windows runs the wrapper's .bat; cmd.exe can't run ./gradlew)
  const gradlew = process.platform === "win32" ? "gradlew.bat" : "gradlew";
  const gradleDirs = ["", "android"].filter((d) => existsSync(join(root, d, "settings.gradle")) || existsSync(join(root, d, "settings.gradle.kts")));
  let android: ProjectInfo["android"];
  if (gradleDirs.length) {
    const dir = gradleDirs[0]!;
    const gradle = read(join(root, dir, "app/build.gradle.kts")) || read(join(root, dir, "app/build.gradle"));
    const appId = /applicationId\s*=?\s*["']([\w.]+)["']/.exec(gradle)?.[1];
    const build = expo
      ? "npx expo run:android"
      : rn
        ? "npx react-native run-android"
        : flutter
          ? "flutter run -d android --debug"
          : existsSync(join(root, dir, gradlew))
            ? `${dir ? `cd ${dir} && ` : ""}${gradlew === "gradlew.bat" ? "" : "./"}${gradlew} installDebug`
            : undefined;
    android = { ...(appId ? { appId } : {}), ...(build ? { build } : {}) };
  }

  // iOS
  let ios: ProjectInfo["ios"];
  const iosDirs = ["", "ios"].filter((d) => {
    try {
      return readdirSync(join(root, d)).some((f) => f.endsWith(".xcodeproj") || f.endsWith(".xcworkspace"));
    } catch {
      return false;
    }
  });
  const appJson = read(join(root, "app.json"));
  if (iosDirs.length || (expo && /"ios"/.test(appJson))) {
    let bundleId = /"bundleIdentifier"\s*:\s*"([\w.-]+)"/.exec(appJson)?.[1];
    for (const d of iosDirs) {
      if (bundleId) break;
      const proj = readdirSync(join(root, d)).find((f) => f.endsWith(".xcodeproj"));
      if (!proj) continue;
      const pbx = read(join(root, d, proj, "project.pbxproj"));
      bundleId = [...pbx.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = "?([\w.-]+)"?;/g)].map((m) => m[1]!).find((id) => !id.includes("Tests"));
    }
    const build = expo ? "npx expo run:ios" : rn ? "npx react-native run-ios" : flutter ? "flutter run -d ios --debug" : undefined;
    ios = { ...(bundleId ? { bundleId } : {}), ...(build ? { build } : {}) };
  }

  const mobile = !!android || !!ios || rn || expo || flutter;
  return {
    name: pkg.name && !pkg.name.startsWith("@") ? pkg.name : basename(root),
    kind: mobile ? "mobile" : "web",
    platform: !mobile ? "web" : android && !ios ? "android" : ios && !android ? "ios" : "android",
    hasPackageJson: !!pkgText,
    packageManager,
    ...(android ? { android } : {}),
    ...(ios ? { ios } : {}),
  };
}

export const DEV_PORTS = [3000, 5173, 5174, 8080, 4200, 8000, 4321, 3001, 5000, 4173, 1234, 9000, 8888, 3030];

/**
 * Find the app's dev servers: first listening processes started from this
 * project folder (any port), then a few common dev-server ports.
 * Returns every URL that answers, the project's own first.
 */
export async function detectDevServers(root?: string): Promise<string[]> {
  const own = root ? await serversStartedIn(root).catch(() => []) : [];
  const probes = DEV_PORTS.map(async (port) => ((await answers(`http://localhost:${port}`)) ? `http://localhost:${port}` : null));
  const common = (await Promise.all(probes)).filter((u): u is string => !!u);
  return [...new Set([...own, ...common])];
}

async function answers(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(900), redirect: "manual" });
    return r.status < 500;
  } catch {
    return false;
  }
}

async function serversStartedIn(root: string): Promise<string[]> {
  const ls = await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"], { timeoutMs: 5000 });
  if (ls.code !== 0) return [];
  // -F output: p<pid> then n<addr:port> lines
  const ports = new Map<string, number[]>();
  let pid = "";
  for (const l of ls.stdout.toString().split("\n")) {
    if (l.startsWith("p")) pid = l.slice(1);
    else if (l.startsWith("n") && pid) {
      const port = Number(/:(\d+)$/.exec(l)?.[1]);
      if (port && port !== 4382) ports.set(pid, [...(ports.get(pid) ?? []), port]);
    }
  }
  const found: string[] = [];
  for (const [p, list] of ports) {
    const cwd = await run("lsof", ["-a", "-p", p, "-d", "cwd", "-Fn"], { timeoutMs: 3000 });
    const dir = cwd.stdout.toString().split("\n").find((l) => l.startsWith("n"))?.slice(1);
    if (!dir || !(dir === root || dir.startsWith(root + "/"))) continue;
    for (const port of [...new Set(list)].sort((a, b) => a - b)) {
      const url = `http://localhost:${port}`;
      if (await answers(url)) found.push(url);
    }
  }
  return found;
}

/** The page's <title>, when it answers with one. */
export async function pageTitle(url: string): Promise<string | null> {
  try {
    const html = await (await fetch(url, { signal: AbortSignal.timeout(1500) })).text();
    const t = /<title[^>]*>([^<]{1,80})<\/title>/i.exec(html)?.[1]?.trim();
    return t || null;
  } catch {
    return null;
  }
}

/** Something answers at the URL (any status). */
export async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2000), redirect: "manual" });
    return true;
  } catch {
    return false;
  }
}
