// Copies the fixture project to a temp dir and serves it for the Playwright suite.
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "../../..");
const dir = mkdtempSync(join(tmpdir(), "scribui-e2e-"));
cpSync(join(root, "fixtures/project"), dir, { recursive: true });
symlinkSync(join("rounds", "001"), join(dir, ".scribui/latest"));
const child = spawn(process.execPath, [join(root, "packages/cli/dist/cli.js"), "open", "--dir", dir, "--port", process.env.PORT ?? "4399", "--no-open"], {
  stdio: "inherit",
});
const stop = () => child.kill();
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
