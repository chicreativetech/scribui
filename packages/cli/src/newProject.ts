import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, parse, resolve } from "node:path";
import { createInterface } from "node:readline";
import { emitKeypressEvents } from "node:readline";
import { desktopNewUrl, HANDOFF_DIR, NEW_PROJECT_BRIEF_DIR, NEW_PROJECT_MAX, newProjectPrompt, PRODUCT, renderNewAppVisionMarkdown } from "@scribui/core";
import { hostProject } from "@scribui/project";
import { exportVision, ReviewStore } from "@scribui/server";
import { canvasDir } from "./canvasDir.js";
import { desktopInstalled, openDesktopLink } from "./desktop.js";
import { confirm, interactive, spinner } from "./prompts.js";
import { openBrowser } from "./start.js";
import { banner, c, fail, okLine, out, warnLine } from "./ui.js";

/**
 * `scribui new`: start a new app in a folder with the user's own agent.
 * With the desktop app installed, its new-project dialog opens with the
 * folder filled in; otherwise the description is asked here, and the vision
 * board (optional) opens in the browser. Either way the result is a prompt
 * to paste into the agent; ScribUI is set up afterwards, by running
 * `scribui` again once the app exists, and keeps the board.
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
  if (existsSync(resolve(root, PRODUCT.folder, "screens.json"))) warnLine(`${root} is a ScribUI project already; your agent will add to the app that's there.`);
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
  const vision = await sketchVision(root);
  out();
  out(`  ${c.bold("Paste this into your coding agent")} ${c.dim(`(Claude Code, Codex, Cursor, …) opened in ${root}:`)}`);
  out();
  for (const l of newProjectPrompt(root, description, { vision }).trimEnd().split("\n")) out(`    ${l}`);
  out();
  out(c.dim(`  When the app runs, run ${c.bold("scribui")} in ${root} to set ScribUI up for it.${vision ? " Your sketches are on its Vision tab." : ""}`));
  out();
}

/**
 * The vision step: the folder's vision board, in the browser, until Done
 * there (or Enter here). Returns the path of the export for the agent
 * (.scribui/brief/vision.md), or undefined when skipped or nothing is drawn.
 * The board stays in .scribui/vision/; setting the project up keeps it.
 */
async function sketchVision(root: string): Promise<string | undefined> {
  if (!interactive()) return undefined;
  const canvas = canvasDir();
  if (!canvas) return undefined;
  out();
  if (!(await confirm("Set the vision first? Sketch how the app should look, in your browser", true))) return undefined;

  const store = new ReviewStore(root);
  await mkdir(store.dir, { recursive: true });
  let done: () => void = () => {};
  const pressedDone = new Promise<void>((r) => (done = r));
  const hosted = await hostProject(store, { app: "cli", server: { canvasDir: canvas, onVisionDone: () => done() } });
  if (hosted.kind === "no-port") {
    warnLine("No free port for the vision board; making the prompt without it.");
    return undefined;
  }
  const base = hosted.kind === "owner" ? `http://127.0.0.1:${hosted.server.port}/` : hosted.owner.url;
  if (!base) {
    warnLine("Another ScribUI process owns this folder; making the prompt without the vision board.");
    return undefined;
  }
  const url = `${base}?mode=new`;
  openBrowser(url);
  out(`  ${c.accent("◆")} The vision board is open in your browser: ${c.accent(url)}`);
  out(c.dim(`    Sketch layouts, key screens, colours, words; add reference images. Press ${c.bold("Done")} there, or ${c.bold("Enter")} here.`));
  try {
    await Promise.race([pressedDone, enterPressed()]);
  } finally {
    stopKeys();
    // the board autosaves a moment after the last stroke; Enter here can come first
    await new Promise((r) => setTimeout(r, 700));
    if (hosted.kind === "owner") await hosted.server.close();
  }
  const brief = store.path(NEW_PROJECT_BRIEF_DIR);
  await rm(brief, { recursive: true, force: true });
  const canvases = await exportVision(store, brief, renderNewAppVisionMarkdown);
  if (!canvases) {
    out(`  ${c.dim("Nothing sketched; the prompt is made from the description alone.")}`);
    return undefined;
  }
  okLine(`Vision: ${canvases} canvas${canvases === 1 ? "" : "es"}, for your agent in ${PRODUCT.folder}/${NEW_PROJECT_BRIEF_DIR}/vision.md`);
  return `${PRODUCT.folder}/${NEW_PROJECT_BRIEF_DIR}/vision.md`;
}

let stopKeys: () => void = () => {};

/** Resolves on Enter (Ctrl-C quits). */
function enterPressed(): Promise<void> {
  return new Promise((resolve) => {
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const onKey = (_: string, key: { name?: string; ctrl?: boolean }) => {
      if (key?.ctrl && key.name === "c") {
        stopKeys();
        out();
        process.exit(130);
      }
      if (key?.name === "return" || key?.name === "enter") resolve();
    };
    process.stdin.on("keypress", onKey);
    stopKeys = () => {
      process.stdin.off("keypress", onKey);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      stopKeys = () => {};
    };
  });
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
