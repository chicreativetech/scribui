import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { RUNTIME_DIR } from "@scribui/capture";
import type { ProjectInfo } from "@scribui/project";
import { confirm } from "./prompts.js";
import { c, errLine, okLine, out } from "./ui.js";

/* ─────────────────────────── running installs ─────────────────────────── */

/** Run a shell command with its output streaming to the terminal. */
export function runVisible(cmd: string, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  out(c.dim(`  $ ${cmd}`));
  return new Promise((resolve) => {
    const child = spawn(cmd, { cwd, shell: true, stdio: "inherit", env });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

/* ─────────────────────────── web: Playwright ─────────────────────────── */

type PlaywrightMod = { chromium?: { executablePath(): string }; default?: { chromium?: { executablePath(): string } } };

async function findPlaywright(root: string): Promise<{ dir: string; chromiumPath: string | null } | null> {
  for (const base of [root, RUNTIME_DIR]) {
    try {
      const req = createRequire(join(base, "package.json"));
      const entry = req.resolve("playwright");
      const mod = (await import(pathToFileURL(entry).href)) as PlaywrightMod;
      const chromium = mod.chromium ?? mod.default?.chromium;
      let chromiumPath: string | null = null;
      try {
        const p = chromium?.executablePath();
        chromiumPath = p && existsSync(p) ? p : null;
      } catch {
        chromiumPath = null;
      }
      return { dir: base, chromiumPath };
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Make sure Playwright and Chromium are available; offers to install them. */
export async function ensureWebTools(root: string, info: ProjectInfo): Promise<boolean> {
  let pw = await findPlaywright(root);
  if (!pw) {
    out();
    out(`  Playwright is required to capture web screens ${c.dim("(it drives a headless Chrome).")}`);
    if (!(await confirm("Install Playwright?", true))) {
      errLine("Skipped. Install later with: npm i -D playwright && npx playwright install chromium");
      return false;
    }
    let ok: boolean;
    if (info.hasPackageJson) {
      const add = { npm: "npm install -D playwright", pnpm: "pnpm add -D playwright", yarn: "yarn add -D playwright", bun: "bun add -d playwright" }[
        info.packageManager
      ];
      ok = await runVisible(add, root);
    } else {
      // no package.json (plain HTML, other stacks): keep it out of the project
      await mkdir(RUNTIME_DIR, { recursive: true });
      if (!existsSync(join(RUNTIME_DIR, "package.json")))
        await writeFile(join(RUNTIME_DIR, "package.json"), JSON.stringify({ name: "scribui-runtime", private: true }) + "\n");
      ok = await runVisible("npm install --no-audit --no-fund playwright", RUNTIME_DIR);
    }
    if (!ok) {
      errLine("Installing Playwright failed (see above).");
      return false;
    }
    pw = await findPlaywright(root);
    if (!pw) return false;
  }
  if (!pw.chromiumPath) {
    out();
    out("  Playwright needs its Chromium browser (about 150 MB, once).");
    if (!(await confirm("Download Chromium now?", true))) return false;
    if (!(await runVisible("npx playwright install chromium", pw.dir))) {
      errLine("Downloading Chromium failed (see above).");
      return false;
    }
  }
  okLine("Playwright and Chromium ready");
  return true;
}
