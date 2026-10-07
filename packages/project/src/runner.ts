import { spawn } from "node:child_process";
import { listAndroidDevices } from "@scribui/capture";
import type { Platform } from "@scribui/core";
import type { CaptureRunner, ReviewStore } from "@scribui/server";
import { captureRound, type CaptureEvent } from "./capture.js";
import { buildEnv } from "./env.js";

/**
 * The capture runner the server calls when the canvas (or the agent marking a
 * round applied) asks for a capture: optional rebuild, then capture, reporting
 * progress as it goes. Terminal output goes through `print`.
 */
export function makeRunner(
  store: ReviewStore,
  defaults: { platform?: Platform; device?: string },
  print?: (e: CaptureEvent) => void,
  onBuildLine?: (line: string) => void,
): CaptureRunner {
  return async (req, report) => {
    const manifest = await store.readManifest();
    const device = defaults.device ?? manifest.app.device;

    if (req.build) {
      const cmd = manifest.app.build;
      if (!cmd) throw new Error('no "build" command under "app" in .scribui/screens.json');
      const lines: string[] = [];
      report({ phase: "building", log: [`$ ${cmd}`] });
      const serial = manifest.app.platform === "android" ? await androidSerial(device) : undefined;
      const ok = await runCommand(cmd, store.root, buildEnv(serial), (line) => {
        lines.push(line);
        onBuildLine?.(line);
        report({ log: [`$ ${cmd}`, ...lines.slice(-14)] });
      });
      if (!ok) throw new Error(`build failed: ${lines.slice(-3).join(" ").slice(0, 300) || cmd}`);
    }

    report({ phase: "capturing" });
    let problems: string[] = [];
    let toCaptureCount = 0;
    let queue: string[] = [];
    const result = await captureRound(store, {
      ...(req.into !== undefined ? { intoRound: req.into } : {}),
      ...(req.screens ? { screens: req.screens } : {}),
      ...(req.all ? { all: true } : {}),
      ...(defaults.platform ? { platform: defaults.platform } : {}),
      ...(device ? { device } : {}),
      log: (e) => {
        print?.(e);
        switch (e.type) {
          case "check-failed":
            problems = e.problems;
            break;
          case "plan":
            queue = e.plan.items.filter((i) => i.action === "capture").map((i) => i.screenId);
            toCaptureCount = queue.length;
            report({ total: toCaptureCount, done: 0, queue: [...queue] });
            break;
          case "round":
            report({ round: e.round });
            break;
          case "screen-start":
            report({ current: e.screenId, done: e.index });
            break;
          case "screen-done":
          case "screen-failed":
            queue = queue.filter((id) => id !== e.screenId);
            report({ done: toCaptureCount - queue.length, queue: [...queue] });
            break;
        }
      },
    });
    if (!result) throw new Error(problems.join("\n") || "capture tools are not ready; run `scribui doctor`");
    if (result.skipped) return { round: null, summary: `nothing to capture: ${result.plan.why}`, failed: [], ok: [], reused: result.reused, skipped: true };
    const reused = result.reused.length ? `, ${result.reused.length} reused` : "";
    return { round: result.round, summary: `${result.ok.length} captured${reused}`, failed: result.failed, ok: result.ok, reused: result.reused };
  };
}

async function androidSerial(device?: string): Promise<string | undefined> {
  const devices = await listAndroidDevices();
  if (!device) return devices.length === 1 ? devices[0]!.serial : undefined;
  const w = device.toLowerCase();
  return devices.find((d) => d.serial === device || d.model.toLowerCase() === w || (w === "emulator" && d.emulator))?.serial;
}

function runCommand(cmd: string, cwd: string, env: NodeJS.ProcessEnv, onLine: (l: string) => void): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, { cwd, shell: true, env });
    let buf = "";
    const feed = (d: Buffer) => {
      buf += d.toString();
      const parts = buf.split(/\r?\n/);
      buf = parts.pop() ?? "";
      for (const p of parts) if (p.trim()) onLine(p.replace(/\x1b\[[0-9;]*m/g, ""));
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    const timer = setTimeout(() => child.kill("SIGKILL"), 20 * 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (buf.trim()) onLine(buf);
      resolve(code === 0);
    });
    child.on("error", () => resolve(false));
  });
}
