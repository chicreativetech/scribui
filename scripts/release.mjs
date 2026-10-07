#!/usr/bin/env node
/**
 * Prepare a release: set the version of the desktop app and the CLI, date
 * its CHANGELOG.md section, commit and tag. Pushing is left to you; the tag
 * starts the release workflow (a draft GitHub release). See RELEASING.md.
 *   node scripts/release.mjs 0.2.0
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dateSection, notesFor } from "../packages/desktop/scripts/changelog.mjs";

const version = process.argv[2];
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) fail("usage: node scripts/release.mjs <version>, e.g. 0.2.0");
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

if (git("status", "--porcelain", "--untracked-files=no")) fail("Commit or stash your changes first.");
if (git("rev-parse", "--abbrev-ref", "HEAD") !== "main") fail("Release from main.");
if (git("tag", "--list", `v${version}`)) fail(`v${version} exists already.`);

const changelog = readFileSync("CHANGELOG.md", "utf8");
if (!notesFor(changelog, version)) fail(`CHANGELOG.md has no notes for ${version}: add a "## ${version}" section first.`);
writeFileSync("CHANGELOG.md", dateSection(changelog, version, new Date().toISOString().slice(0, 10)));

const files = ["packages/desktop/package.json", "packages/cli/package.json"];
for (const f of files) {
  const text = readFileSync(f, "utf8");
  writeFileSync(f, text.replace(/"version": "[^"]+"/, `"version": "${version}"`));
}
git("add", "CHANGELOG.md", ...files);
git("commit", "-m", `Release v${version}`);
git("tag", "-a", `v${version}`, "-m", `ScribUI ${version}`);
console.log(`Tagged v${version}. To build the draft release:\n  git push origin main v${version}`);
