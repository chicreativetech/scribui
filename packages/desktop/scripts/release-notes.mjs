#!/usr/bin/env node
/**
 * Write build/release-notes.md from CHANGELOG.md's section for this version
 * (package.json's, or the one given). electron-builder puts it on the GitHub
 * release and in the update info the app's update dialog shows.
 *   node scripts/release-notes.mjs [version]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { notesFor } from "./changelog.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const version = process.argv[2] ?? JSON.parse(readFileSync(join(here, "../package.json"), "utf8")).version;
const notes = notesFor(readFileSync(join(here, "../../../CHANGELOG.md"), "utf8"), version);
if (!notes) {
  console.error(`CHANGELOG.md has no notes for ${version}: add a "## ${version}" section.`);
  process.exit(1);
}
writeFileSync(join(here, "../build/release-notes.md"), notes + "\n");
console.log(`release notes for ${version}: ${notes.split("\n").length} lines`);
