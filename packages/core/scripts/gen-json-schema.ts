// Writes packages/core/schemas/*.schema.json from the Zod schemas.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { Annotation, AnnotationsFile, ReviewJson, ScreenCapture, ScreenManifest, StatusFile, UIElement } from "../src/schemas.js";

const out = join(import.meta.dirname, "../schemas");
mkdirSync(out, { recursive: true });
const schemas = { UIElement, ScreenCapture, ScreenManifest, Annotation, AnnotationsFile, ReviewJson, StatusFile };
for (const [name, schema] of Object.entries(schemas)) {
  const json = z.toJSONSchema(schema as z.ZodType, { target: "draft-2020-12", cycles: "ref", unrepresentable: "any" });
  const body = { $id: `https://intentcue.dev/schemas/${name}.schema.json`, title: name, ...json };
  writeFileSync(join(out, `${name}.schema.json`), JSON.stringify(body, null, 2) + "\n");
  console.log(`wrote schemas/${name}.schema.json`);
}
