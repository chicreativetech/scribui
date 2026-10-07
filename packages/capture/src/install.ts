import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix } from "node:path";
import { run, which } from "./exec.js";
import { extractZip } from "./zip.js";

/**
 * Installing the capture tools without a terminal: what an install does on
 * this system (`installPlan`, pure) and running it (`runInstall`). Only the
 * steps listed here ever run; nothing comes from the caller but a tool id.
 */

export type InstallableTool = "adb" | "emulator" | "xcode" | "axe" | "playwright";

/** ScribUI's own downloads (Android platform tools), outside any project. */
export const TOOLS_DIR = join(homedir(), ".scribui", "tools");
/** The shared Playwright install for projects without their own. */
export const RUNTIME_DIR = join(homedir(), ".scribui", "runtime");

export const PLATFORM_TOOLS_TERMS = "https://developer.android.com/tools/releases/platform-tools";
const PLATFORM_TOOLS_ZIP = (os: string) =>
  `https://dl.google.com/android/repository/platform-tools-latest-${os === "win32" ? "windows" : os === "darwin" ? "darwin" : "linux"}.zip`;

export type InstallStep =
  /** Download Google's platform tools and unpack them into TOOLS_DIR. */
  | { kind: "platform-tools"; url: string }
  /** A program with fixed arguments (no shell, except for npm/npx on Windows, which are .cmd files). */
  | { kind: "run"; label: string; cmd: string; args: string[]; cwd?: string; optional?: boolean }
  /** macOS: commands that need an administrator, run through the system's password prompt. */
  | { kind: "admin"; label: string; script: string }
  /** Create RUNTIME_DIR with a package.json, so npm installs there and not in a parent folder. */
  | { kind: "runtime-dir" };

export type InstallPlan =
  | { auto: true; does: string; steps: InstallStep[]; terms?: string; after?: string }
  | { auto: false; reason: string; command?: string; url?: string };

/** What's on this machine that installs can use. */
export type InstallEnv = {
  os: NodeJS.Platform;
  brew: string | null;
  winget: string | null;
  npm: string | null;
  /** Xcode.app found, though the selected developer folder may be the Command Line Tools'. */
  xcodeApp: string | null;
};

export async function installEnv(os: NodeJS.Platform = process.platform): Promise<InstallEnv> {
  const brewAt = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew", "/home/linuxbrew/.linuxbrew/bin/brew"].find((p) => existsSync(p)) ?? null;
  const [brew, winget, npm] = await Promise.all([
    os === "win32" ? null : which("brew").then((p) => p ?? brewAt),
    os === "win32" ? which("winget") : null,
    which("npm"),
  ]);
  const xcodeApp = os === "darwin" ? (["/Applications/Xcode.app", join(homedir(), "Applications/Xcode.app")].find((p) => existsSync(p)) ?? null) : null;
  return { os, brew, winget, npm, xcodeApp };
}

/** How `id` gets installed here, or why it can't be from the app (with what to do instead). */
export function installPlan(id: InstallableTool, env: InstallEnv): InstallPlan {
  const { os, brew, winget, npm } = env;
  switch (id) {
    case "adb":
      // the same zip on every system, no package manager or administrator needed
      return {
        auto: true,
        does: "Downloads Google's Android platform tools (about 15 MB) into ~/.scribui/tools.",
        steps: [{ kind: "platform-tools", url: PLATFORM_TOOLS_ZIP(os) }],
        terms: PLATFORM_TOOLS_TERMS,
      };
    case "emulator": {
      const after = "Open Android Studio once: its setup downloads the emulator, and Device Manager creates a virtual device.";
      if (os === "darwin" && brew)
        return {
          auto: true,
          does: "Installs Android Studio with Homebrew (about 1.5 GB).",
          steps: [{ kind: "run", label: "brew install --cask android-studio", cmd: brew, args: ["install", "--cask", "android-studio"] }],
          after,
        };
      if (os === "win32" && winget)
        return {
          auto: true,
          does: "Installs Android Studio with winget (about 1.5 GB), accepting its licence.",
          steps: [
            {
              kind: "run",
              label: "winget install Google.AndroidStudio",
              cmd: winget,
              args: ["install", "--id", "Google.AndroidStudio", "--exact", "--silent", "--accept-source-agreements", "--accept-package-agreements"],
            },
          ],
          after,
        };
      return {
        auto: false,
        reason: "Install Android Studio, then create a virtual device in its Device Manager. A phone over USB works without it.",
        ...(os === "linux" ? { command: "sudo snap install android-studio --classic" } : {}),
        url: "https://developer.android.com/studio",
      };
    }
    case "xcode":
      if (os !== "darwin") return { auto: false, reason: "The iOS Simulator only runs on a Mac." };
      // Xcode is there, but the Command Line Tools are selected (or its first launch never ran)
      if (env.xcodeApp)
        return {
          auto: true,
          does: "Points the developer tools at Xcode, accepts its licence and finishes its first launch. macOS asks for your password.",
          steps: [
            {
              kind: "admin",
              label: "xcode-select -s Xcode.app && xcodebuild -license accept && xcodebuild -runFirstLaunch",
              // a macOS path, whatever system builds the plan
              script: `xcode-select -s ${shq(posix.join(env.xcodeApp, "Contents/Developer"))} && xcodebuild -license accept && xcodebuild -runFirstLaunch`,
            },
          ],
        };
      return {
        auto: false,
        reason: "Install Xcode from the App Store (about 10 GB), open it once, then check again.",
        command: 'open "macappstore://apps.apple.com/app/xcode/id497799835"',
        url: "https://developer.apple.com/xcode/",
      };
    case "axe":
      if (os !== "darwin") return { auto: false, reason: "AXe drives the iOS Simulator, which only runs on a Mac." };
      if (!brew) return { auto: false, reason: "AXe installs with Homebrew. Install Homebrew first, then check again.", url: "https://brew.sh" };
      return {
        auto: true,
        does: "Installs AXe from its Homebrew tap (cameroncooke/axe).",
        steps: [
          { kind: "run", label: "brew tap cameroncooke/axe", cmd: brew, args: ["tap", "cameroncooke/axe"] },
          // only current Homebrew has (and asks for) trust; older ones install without it
          { kind: "run", label: "brew trust --formula cameroncooke/axe/axe", cmd: brew, args: ["trust", "--formula", "cameroncooke/axe/axe"], optional: true },
          { kind: "run", label: "brew install cameroncooke/axe/axe", cmd: brew, args: ["install", "cameroncooke/axe/axe"] },
        ],
      };
    case "playwright":
      if (!npm) return { auto: false, reason: "Installing Playwright needs Node.js (npm).", url: "https://nodejs.org" };
      return {
        auto: true,
        does: "Installs Playwright and its Chromium (about 150 MB) into ~/.scribui/runtime, outside your project.",
        steps: [
          { kind: "runtime-dir" },
          { kind: "run", label: "npm install playwright", cmd: "npm", args: ["install", "--no-audit", "--no-fund", "playwright"], cwd: RUNTIME_DIR },
          { kind: "run", label: "npx playwright install chromium", cmd: "npx", args: ["playwright", "install", "chromium"], cwd: RUNTIME_DIR },
        ],
      };
  }
}

/** A single-quoted shell word. */
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export type InstallLog = (line: string) => void;

/** Run a plan's steps in order; stops at the first failing step that isn't optional. */
export async function runInstall(plan: InstallPlan, log: InstallLog, signal?: AbortSignal): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!plan.auto) return { ok: false, error: plan.reason };
  for (const step of plan.steps) {
    if (signal?.aborted) return { ok: false, error: "canceled" };
    try {
      if (step.kind === "platform-tools") await installPlatformTools(step.url, log, signal);
      else if (step.kind === "runtime-dir") {
        await mkdir(RUNTIME_DIR, { recursive: true });
        const pkg = join(RUNTIME_DIR, "package.json");
        if (!existsSync(pkg)) await writeFile(pkg, JSON.stringify({ name: "scribui-runtime", private: true }) + "\n");
      } else if (step.kind === "admin") {
        log(`$ ${step.label}`);
        const r = await run("osascript", ["-e", `do shell script ${appleString(step.script)} with administrator privileges`]);
        if (r.code !== 0) {
          const msg = r.stderr.trim();
          throw new Error(/User canceled|-128/.test(msg) ? "canceled at the password prompt" : msg || `exit ${r.code}`);
        }
      } else {
        log(`$ ${step.label}`);
        const code = await streamed(step.cmd, step.args, step.cwd, log, signal);
        if (code !== 0) {
          if (step.optional) log(`(skipped: exit ${code})`);
          else throw new Error(`${step.label} failed (exit ${code})`);
        }
      }
    } catch (e) {
      return { ok: false, error: signal?.aborted ? "canceled" : (e as Error).message };
    }
  }
  return { ok: true };
}

/** An AppleScript string literal. */
const appleString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Run a program, passing its output on line by line (progress bars that redraw with \r count as lines). */
function streamed(cmd: string, args: string[], cwd: string | undefined, log: InstallLog, signal?: AbortSignal): Promise<number> {
  return new Promise((done) => {
    // npm and npx are .cmd scripts on Windows, which only start through a shell
    const shell = process.platform === "win32" && (cmd === "npm" || cmd === "npx");
    const child = spawn(cmd, args, { cwd, shell, env: { ...process.env, NONINTERACTIVE: "1", CI: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    const onAbort = () => child.kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    let rest = "";
    const take = (d: Buffer) => {
      const parts = (rest + d.toString()).split(/\r?\n|\r/);
      rest = parts.pop() ?? "";
      for (const l of parts) if (l.trim()) log(l);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (e) => {
      log(String(e.message));
      done(127);
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (rest.trim()) log(rest);
      done(code ?? 1);
    });
  });
}

async function installPlatformTools(url: string, log: InstallLog, signal?: AbortSignal) {
  log(`Downloading ${url}`);
  const res = await fetch(url, { signal });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  const chunks: Buffer[] = [];
  let got = 0;
  let shown = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
    got += chunk.length;
    if (got - shown > 2_000_000) {
      shown = got;
      log(`${mb(got)}${total ? ` of ${mb(total)}` : ""}`);
    }
  }
  log(`Downloaded ${mb(got)}; unpacking`);
  await mkdir(TOOLS_DIR, { recursive: true });
  const tmp = join(TOOLS_DIR, `.platform-tools-${process.pid}`);
  await rm(tmp, { recursive: true, force: true });
  try {
    const files = await extractZip(Buffer.concat(chunks), tmp);
    if (!existsSync(join(tmp, "platform-tools"))) throw new Error("the download has no platform-tools folder");
    const dest = join(TOOLS_DIR, "platform-tools");
    // a running adb server keeps its binary open on Windows; stop it before replacing
    if (existsSync(dest)) {
      await run(join(dest, process.platform === "win32" ? "adb.exe" : "adb"), ["kill-server"], { timeoutMs: 5000 }).catch(() => null);
      await rm(dest, { recursive: true, force: true });
    }
    await rename(join(tmp, "platform-tools"), dest);
    log(`Unpacked ${files} files into ${dest}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

const mb = (n: number) => `${(n / 1_000_000).toFixed(1)} MB`;
