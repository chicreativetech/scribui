/** Terminal output in the intentcue style: quiet, monospace, one orange accent. */

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (open: string, close = "\x1b[0m") => (s: string | number) => (tty ? `${open}${s}${close}` : String(s));

export const c = {
  accent: wrap("\x1b[38;2;255;79;0m"),
  dim: wrap("\x1b[2m"),
  bold: wrap("\x1b[1m"),
  ok: wrap("\x1b[38;2;158;206;106m"),
  warn: wrap("\x1b[38;2;224;175;104m"),
  err: wrap("\x1b[38;2;247;118;142m"),
  inv: wrap("\x1b[7m"),
};

export const out = (s = "") => process.stdout.write(s + "\n");

export function banner(sub?: string) {
  out(`${c.accent("■")} ${c.bold("intentcue")}${sub ? c.dim(`  ·  ${sub}`) : ""}`);
}

export const line = (label: string, value: string) => out(`  ${c.dim(label.padEnd(12))} ${value}`);
export const okLine = (s: string) => out(`  ${c.ok("✓")} ${s}`);
export const warnLine = (s: string) => out(`  ${c.warn("!")} ${s}`);
export const errLine = (s: string) => out(`  ${c.err("✗")} ${s}`);

export function fail(msg: string, detail?: string): never {
  out();
  errLine(msg);
  if (detail) for (const l of detail.split("\n")) out(`    ${c.dim(l)}`);
  out();
  process.exit(1);
}
