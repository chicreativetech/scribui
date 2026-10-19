// Zips the extension for the Chrome Web Store (or to hand to someone): dist/scribui-extension-<version>.zip
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const { version } = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const out = join(root, "dist", `scribui-extension-${version}.zip`);
mkdirSync(join(root, "dist"), { recursive: true });
rmSync(out, { force: true });
execFileSync("zip", ["-r", "-X", out, "manifest.json", "background.js", "bridge.js", "lib.js", "grant.html", "grant.js", "popup.html", "popup.css", "popup.js", "icons"], { cwd: root, stdio: "inherit" });
console.log(`wrote ${out}`);
