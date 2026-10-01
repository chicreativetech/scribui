import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { c, out } from "./ui.js";

/** Small interactive prompts in the intentcue terminal style. Non-TTY: defaults are used. */

export const interactive = () => !!process.stdin.isTTY && !!process.stdout.isTTY && !process.env.CI;

type Key = { name?: string; ctrl?: boolean; sequence?: string };

function readKey(): Promise<Key> {
  return new Promise((resolve) => {
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const onKey = (_: string, key: Key) => {
      process.stdin.off("keypress", onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      if (key?.ctrl && key.name === "c") {
        out();
        process.exit(130);
      }
      resolve(key ?? {});
    };
    process.stdin.on("keypress", onKey);
  });
}

/** Y/n question; Enter takes the default. */
export async function confirm(question: string, def = true): Promise<boolean> {
  const hint = def ? "Y/n" : "y/N";
  if (!interactive()) {
    out(`  ${c.accent("?")} ${question} ${c.dim(`(${hint})`)} ${c.dim(def ? "yes" : "no")}`);
    return def;
  }
  process.stdout.write(`  ${c.accent("?")} ${question} ${c.dim(`(${hint})`)} `);
  for (;;) {
    const k = await readKey();
    const ch = (k.sequence ?? "").toLowerCase();
    if (k.name === "return" || k.name === "enter") {
      process.stdout.write(`${def ? "yes" : "no"}\n`);
      return def;
    }
    if (ch === "y" || ch === "n") {
      process.stdout.write(`${ch === "y" ? "yes" : "no"}\n`);
      return ch === "y";
    }
    if (k.name === "escape") {
      process.stdout.write("no\n");
      return false;
    }
  }
}

/** Pick one option with ↑↓ (or the first letter); Enter confirms. */
export async function select<T extends string>(question: string, options: { value: T; label: string; hint?: string }[], def: T): Promise<T> {
  let i = Math.max(0, options.findIndex((o) => o.value === def));
  if (!interactive()) {
    out(`  ${c.accent("?")} ${question} ${c.dim(options[i]!.label)}`);
    return options[i]!.value;
  }
  out(`  ${c.accent("?")} ${question} ${c.dim("↑↓ enter")}`);
  const draw = (first: boolean) => {
    if (!first) process.stdout.write(`\x1b[${options.length}A`);
    for (const [j, o] of options.entries()) {
      const on = j === i;
      process.stdout.write(`\x1b[2K    ${on ? c.accent("›") : " "} ${on ? c.bold(o.label) : c.dim(o.label)}${o.hint ? c.dim(`  ${o.hint}`) : ""}\n`);
    }
  };
  draw(true);
  for (;;) {
    const k = await readKey();
    if (k.name === "up" || k.name === "k") i = (i - 1 + options.length) % options.length;
    else if (k.name === "down" || k.name === "j" || k.name === "tab") i = (i + 1) % options.length;
    else if (k.name === "return" || k.name === "enter") {
      // replace the question and the list with the answer
      process.stdout.write(`\x1b[${options.length + 1}A\x1b[0J`);
      out(`  ${c.ok("✓")} ${question} ${options[i]!.label}`);
      return options[i]!.value;
    } else {
      const ch = (k.sequence ?? "").toLowerCase();
      const hit = options.findIndex((o) => o.label.toLowerCase().startsWith(ch));
      if (ch && hit >= 0) i = hit;
    }
    draw(false);
  }
}

/** Free text with a default. */
export async function input(question: string, def: string): Promise<string> {
  if (!interactive()) return def;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`  ${c.accent("?")} ${question} ${c.dim(`(${def})`)} `);
  rl.close();
  return answer.trim() || def;
}

/** Wait for Enter, or for `until()` to become true (checked every second). Returns how it ended. */
export async function waitFor(message: string, until: () => Promise<boolean>): Promise<"enter" | "detected"> {
  const spin = spinner(message);
  let done = false;
  const enter = new Promise<"enter">((resolve) => {
    if (!interactive()) return;
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const onKey = (_: string, key: Key) => {
      if (key?.ctrl && key.name === "c") {
        spin.stop();
        out();
        process.exit(130);
      }
      if (key?.name === "return" || key?.name === "enter") {
        process.stdin.off("keypress", onKey);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        resolve("enter");
      }
    };
    process.stdin.on("keypress", onKey);
  });
  const detected = new Promise<"detected">((resolve) => {
    const tick = async () => {
      if (done) return;
      if (await until().catch(() => false)) resolve("detected");
      else setTimeout(tick, 1000);
    };
    void tick();
  });
  const how = await Promise.race([enter, detected]);
  done = true;
  if (how === "detected" && interactive()) {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdin.removeAllListeners("keypress");
  }
  spin.stop();
  return how;
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function spinner(text: string) {
  if (!interactive()) {
    out(`  ${c.dim("…")} ${text}`);
    return { update: (_t: string) => {}, stop: (_final?: string) => {} };
  }
  let i = 0;
  let current = text;
  const draw = () => process.stdout.write(`\r\x1b[2K  ${c.accent(FRAMES[i++ % FRAMES.length]!)} ${current}`);
  draw();
  const t = setInterval(draw, 90);
  return {
    update(t2: string) {
      current = t2;
    },
    stop(final?: string) {
      clearInterval(t);
      process.stdout.write("\r\x1b[2K");
      if (final) out(final);
    },
  };
}
