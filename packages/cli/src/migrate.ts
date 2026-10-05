import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { PRODUCT, upsertAgentSection } from "@scribui/core";

/**
 * ScribUI was called intentcue. Projects and the home folder set up under the
 * old name are moved over once, the first time scribui runs there. Messages
 * go to stderr so `scribui mcp` keeps stdout for its protocol.
 */

const LEGACY = ".intentcue";
const say = (msg: string) => process.stderr.write(`  \x1b[2m${msg}\x1b[0m\n`);

/** ~/.intentcue (Playwright runtime, Chrome profiles, server records) → ~/.scribui. */
export async function migrateHome() {
  const from = join(homedir(), LEGACY);
  const to = join(homedir(), PRODUCT.folder);
  if (!existsSync(from) || existsSync(to)) return;
  try {
    await rename(from, to);
    say(`moved ~/${LEGACY} to ~/${PRODUCT.folder} (intentcue is now ScribUI)`);
  } catch {
    /* in use or not ours to move: the new folder is set up fresh */
  }
}

/** <project>/.intentcue → .scribui, and the agent section in AGENTS.md / CLAUDE.md pointed at it. */
export async function migrateProject(root: string) {
  const from = join(root, LEGACY);
  const to = join(root, PRODUCT.folder);
  if (!existsSync(from) || existsSync(to)) return;
  await rename(from, to);
  const updated: string[] = [];
  for (const f of ["AGENTS.md", "CLAUDE.md"]) {
    const p = join(root, f);
    if (!existsSync(p)) continue;
    const before = await readFile(p, "utf8");
    const after = upsertAgentSection(before);
    if (after !== before) {
      await writeFile(p, after);
      updated.push(f);
    }
  }
  say(`renamed ${LEGACY}/ to ${PRODUCT.folder}/${updated.length ? ` and updated ${updated.join(" and ")}` : ""} (intentcue is now ScribUI)`);
}
