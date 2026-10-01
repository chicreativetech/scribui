import { spawn } from "node:child_process";

export type ExecResult = { code: number; stdout: Buffer; stderr: string };

/** Run a command without a shell; resolves with exit code and output, never throws on non-zero. */
export function run(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env });
    } catch (e) {
      resolve({ code: 127, stdout: Buffer.alloc(0), stderr: String(e) });
      return;
    }
    const out: Buffer[] = [];
    let err = "";
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          err += `\n[timed out after ${opts.timeoutMs} ms]`;
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : null;
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 127, stdout: Buffer.concat(out), stderr: err + String(e) });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: err });
    });
  });
}

export async function which(cmd: string): Promise<string | null> {
  const r = await run("/usr/bin/env", ["which", cmd]);
  return r.code === 0 ? r.stdout.toString().trim() || null : null;
}

export class CaptureError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
  }
}
