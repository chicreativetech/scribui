import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "../../canvas/dist");
const dst = join(here, "../dist/canvas");
if (!existsSync(join(src, "index.html"))) {
  console.error("canvas build missing: run `pnpm --filter @scribui/canvas build` first");
  process.exit(1);
}
rmSync(dst, { recursive: true, force: true });
cpSync(src, dst, { recursive: true });
console.log("copied canvas → dist/canvas");
