import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** The built canvas: next to the CLI when published, packages/canvas/dist from the repo. */
export function canvasDir(): string | undefined {
  const candidates = [join(here, "canvas"), join(here, "../../canvas/dist"), join(here, "../canvas")];
  return candidates.find((p) => existsSync(join(p, "index.html")));
}
