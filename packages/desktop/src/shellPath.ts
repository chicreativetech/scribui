import { execFile } from "node:child_process";

/**
 * Apps started from the Dock, Finder or a desktop launcher get a minimal PATH
 * (/usr/bin:/bin…), so Homebrew's and the Android SDK's tools aren't found.
 * Ask the user's login shell for its PATH once at startup, as a terminal sees it.
 */
export function loadShellPath(timeoutMs = 3000): Promise<void> {
  if (process.platform === "win32") return Promise.resolve();
  const shell = process.env.SHELL || "/bin/zsh";
  const mark = "__SCRIBUI_PATH__";
  return new Promise((done) => {
    execFile(shell, ["-ilc", `printf '${mark}%s${mark}' "$PATH"`], { timeout: timeoutMs, env: { ...process.env, DISABLE_AUTO_UPDATE: "true" } }, (err, stdout) => {
      const m = !err || stdout ? new RegExp(`${mark}(.*?)${mark}`, "s").exec(String(stdout)) : null;
      if (m?.[1]) process.env.PATH = mergePath(m[1], process.env.PATH ?? "");
      done();
    });
  });
}

/** The shell's entries first, then any the app had that the shell doesn't. */
export function mergePath(shell: string, current: string, sep = ":"): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [...shell.split(sep), ...current.split(sep)]) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out.join(sep);
}
