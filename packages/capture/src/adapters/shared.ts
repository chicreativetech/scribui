import { mkdir, writeFile } from "node:fs/promises";
import { delimiter, dirname, extname, isAbsolute, join } from "node:path";
import { findTool } from "../tools.js";
import { normalizeTree, type Device, type Platform, type RawElement, type ScreenCapture, type ScreenEntry } from "@intentcue/core";
import { CaptureError, run } from "../exec.js";
import type { CaptureContext } from "../types.js";

export function screenshotPath(ctx: CaptureContext, screenId: string) {
  return { rel: `screens/${screenId}.png`, abs: join(ctx.roundDir, "screens", `${screenId}.png`) };
}

export async function writePng(abs: string, data: Uint8Array) {
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, data);
}

export function toCapture(
  screen: ScreenEntry,
  platform: Platform,
  device: Device,
  screenshot: string,
  raw: RawElement,
  px: { width: number; height: number },
): ScreenCapture {
  // the root always spans the full screenshot
  raw.bounds = { x: 0, y: 0, w: px.width, h: px.height };
  return {
    screenId: screen.id,
    platform,
    device,
    screenshot,
    root: normalizeTree(raw),
    capturedAt: new Date().toISOString(),
  };
}

export function resolveFlowPath(ctx: CaptureContext, p: string): string {
  return isAbsolute(p) ? p : join(ctx.reviewDir, p);
}

/** Run a Maestro flow (.yaml/.yml) or an executable setup script for a screen. */
export async function runFlow(
  ctx: CaptureContext,
  screen: ScreenEntry,
  maestroArgs: string[],
  env: Record<string, string> = {},
): Promise<void> {
  if (!screen.flow) return;
  const path = resolveFlowPath(ctx, screen.flow);
  const ext = extname(path).toLowerCase();
  // flow scripts call adb / maestro by name: put the tools we found on their PATH
  const toolDirs = (await Promise.all([findTool("adb"), findTool("maestro")])).filter((p): p is string => !!p).map((p) => dirname(p));
  const PATH = [...new Set(toolDirs), process.env.PATH ?? ""].join(delimiter);
  const r =
    ext === ".yaml" || ext === ".yml"
      ? await run((await findTool("maestro")) ?? "maestro", [...maestroArgs, "test", path], { timeoutMs: 180_000, cwd: ctx.reviewDir, env: { ...process.env, PATH } })
      : await run(path, [], { timeoutMs: 180_000, cwd: ctx.reviewDir, env: { ...process.env, ...env, PATH } });
  if (r.code !== 0) {
    const tail = (r.stderr || r.stdout.toString()).trim().split("\n").slice(-12).join("\n");
    throw new CaptureError(`flow failed for "${screen.id}" (${screen.flow})`, tail);
  }
}
