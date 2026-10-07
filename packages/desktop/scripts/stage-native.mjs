// Copies the native PNG renderer (@resvg/resvg-js and its per-platform binary
// for each target architecture) into dist/node_modules, where the bundled main
// process finds it. electron-builder doesn't follow pnpm's layout for optional
// platform packages, so the packaged app gets exactly these instead.
// A binary that isn't installed (another architecture) is fetched with
// `npm pack` at resvg's exact version.
//
//   node scripts/stage-native.mjs [--arch x64,arm64]
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const archArg = process.argv.indexOf("--arch");
const archs = archArg > 0 ? process.argv[archArg + 1].split(",") : [process.arch];
const SUFFIX = { darwin: (a) => `darwin-${a}`, win32: (a) => `win32-${a}-msvc`, linux: (a) => `linux-${a}-gnu` };

const req = createRequire(join(root, "package.json"));
const resvgDir = realpathSync(dirname(req.resolve("@resvg/resvg-js/package.json")));
const version = JSON.parse(readFileSync(join(resvgDir, "package.json"), "utf8")).version;
const out = join(root, "dist", "node_modules", "@resvg");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
// the package itself, without anything nested under it (its node_modules)
cpSync(resvgDir, join(out, "resvg-js"), { recursive: true, dereference: true, filter: (p) => !relative(resvgDir, p).split(sep).includes("node_modules") });

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
for (const arch of archs) {
  const name = `resvg-js-${SUFFIX[process.platform](arch)}`;
  const dest = join(out, name);
  // pnpm keeps the installed platform packages next to resvg
  const installed = join(resvgDir, "..", name);
  if (existsSync(installed)) {
    cpSync(realpathSync(installed), dest, { recursive: true, dereference: true });
    console.log(`staged @resvg/${name} (installed)`);
    continue;
  }
  const tmp = mkdtempSync(join(tmpdir(), "scribui-resvg-"));
  const tgz = execFileSync(npm, ["pack", `@resvg/${name}@${version}`, "--silent"], { cwd: tmp, encoding: "utf8", shell: process.platform === "win32" }).trim().split("\n").pop();
  execFileSync("tar", ["-xzf", tgz], { cwd: tmp });
  cpSync(join(tmp, "package"), dest, { recursive: true });
  rmSync(tmp, { recursive: true, force: true });
  console.log(`staged @resvg/${name} (fetched ${version})`);
}
