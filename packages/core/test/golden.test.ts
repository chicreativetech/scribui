import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AnnotationsFile, compile, resolveAll, ScreenManifest } from "../src/index.js";
import { FIXTURES, webCaptures } from "./helpers.js";

/**
 * Golden files: every fixture round compiles to its checked-in expected output.
 * After an intended output change, regenerate with: UPDATE_GOLDEN=1 pnpm test
 */
const update = process.env.UPDATE_GOLDEN === "1";
const roundsDir = join(FIXTURES, "rounds");
const manifest = ScreenManifest.parse(JSON.parse(readFileSync(join(FIXTURES, "web/checkout/screens.json"), "utf8")));
const captures = webCaptures();
const trees = new Map([...captures].map(([id, c]) => [id, c.root]));

describe("golden rounds", () => {
  for (const name of readdirSync(roundsDir).sort()) {
    it(name, () => {
      const file = AnnotationsFile.parse(JSON.parse(readFileSync(join(roundsDir, name, "annotations.json"), "utf8")));
      const resolved = resolveAll(file.annotations, trees);
      const out = compile({
        round: file.round,
        appName: manifest.app.name,
        date: "2026-09-30",
        screens: manifest.screens.map((s) => ({ id: s.id, title: s.title })),
        captures,
        annotations: resolved,
      });
      const expected = join(roundsDir, name, "expected");
      const files: Record<string, string> = {
        "review.md": out.markdown,
        "review.json": JSON.stringify(out.review, null, 2) + "\n",
        "rules.md": out.rulesMarkdown,
      };
      if (update || !existsSync(expected)) {
        mkdirSync(expected, { recursive: true });
        for (const [f, body] of Object.entries(files)) writeFileSync(join(expected, f), body);
      }
      for (const [f, body] of Object.entries(files)) {
        expect(body, `${name}/${f}`).toBe(readFileSync(join(expected, f), "utf8"));
      }
    });
  }
});
