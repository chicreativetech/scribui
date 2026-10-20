import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, parse, resolve } from "node:path";
import { createInterface } from "node:readline";
import { desktopNewUrl, HANDOFF_DIR, NEW_PROJECT_MAX, newProjectPrompt, PRODUCT } from "@scribui/core";
import { desktopInstalled, openDesktopLink } from "./desktop.js";
import { interactive, spinner } from "./prompts.js";
import { banner, c, fail, okLine, out, warnLine } from "./ui.js";

/**
 * `scribui new`: start a new app in a folder with the user's own agent.
 * With the desktop app installed, its new-project dialog opens with the
 * folder filled in; otherwise the description is asked here. Either way the
 * result is a prompt to paste into the agent; ScribUI is set up afterwards,
 * by running `scribui` again once the app exists.
 */

/** No files but dotfiles (.git, .DS_Store): nothing to review yet. */
export function emptyFolder(dir: string): boolean {
  try {
    return readdirSync(dir).every((f) => f.startsWith("."));
  } catch {
    return !existsSync(dir);
  }
}

export async function cmdNew(dir: string, flags: { desktop?: boolean; banner?: boolean } = {}) {
  if (flags.banner !== false) {
    banner("new project");
    out();
  }
  const root = resolve(dir);
  if (root === resolve(homedir()) || root === parse(root).root) fail(`${root} is ${root === parse(root).root ? "a drive's root" : "your home folder"}.`, "Run scribui new in (or with --dir pointing to) a folder for the new app.");
  if (existsSync(root) && !statSync(root).isDirectory()) fail(`${root} is a file, not a folder.`);
  if (existsSync(resolve(root, PRODUCT.folder))) warnLine(`${root} is a ScribUI project already; your agent will add to the app that's there.`);
  else if (!emptyFolder(root)) warnLine(`${root} isn't empty; your agent may change or replace what's there.`);

  if (flags.desktop !== false && interactive() && (await desktopInstalled())) {
    if (await openInApp(root)) {
      okLine("Describe your project in the ScribUI app; it makes the prompt for your agent.");
      out();
      return;
    }
    warnLine("The ScribUI app didn't open the new-project dialog (an older version?). Describe your project here instead.");
    out();
  }

  const description = await readDescription();
  if (!description) fail("No description given.", interactive() ? undefined : "Pipe it in: scribui new < brief.md");
  if (description.length > NEW_PROJECT_MAX) fail(`The description is too long (at most ${NEW_PROJECT_MAX.toLocaleString("en")} characters).`);
  await mkdir(root, { recursive: true });
  out();
  out(`  ${c.bold("Paste this into your coding agent")} ${c.dim(`(Claude Code, Codex, Cursor, …) opened in ${root}:`)}`);
  out();
  for (const l of newProjectPrompt(root, description).trimEnd().split("\n")) out(`    ${l}`);
  out();
  out(c.dim(`  When the app runs, run ${c.bold("scribui")} in ${root} to set ScribUI up for it.`));
  out();
}

/** Open the app's new-project dialog; true once the app confirms it (an older app ignores the link). */
async function openInApp(root: string, timeoutMs = 20_000): Promise<boolean> {
  const ack = randomBytes(8).toString("hex");
  const file = join(homedir(), PRODUCT.folder, HANDOFF_DIR, ack);
  if (!openDesktopLink(desktopNewUrl(root, ack))) return false;
  const spin = spinner("Opening the ScribUI app…");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    if (existsSync(file)) {
      rmSync(file, { force: true });
      spin.stop();
      return true;
    }
  }
  spin.stop();
  return false;
}

/** The description: typed (an empty line ends it), or piped in whole. */
async function readDescription(): Promise<string> {
  if (interactive()) out(`  ${c.accent("?")} Describe your project ${c.dim("(an empty line ends it)")}`);
  const rl = createInterface({ input: process.stdin, ...(interactive() ? { output: process.stdout, prompt: "    " } : {}), terminal: interactive() });
  const lines: string[] = [];
  if (interactive()) rl.prompt();
  for await (const l of rl) {
    if (interactive() && !l.trim() && lines.some((x) => x.trim())) break;
    lines.push(l);
    if (interactive()) rl.prompt();
  }
  rl.close();
  return lines.join("\n").trim();
}
