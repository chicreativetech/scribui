import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: ["esm"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: false,
  // bundle the workspace packages, keep real dependencies external
  noExternal: [/^@scribui\//],
  external: ["playwright", "@resvg/resvg-js", "hono", "@hono/node-server", "ws", "zod", "cac", "qrcode-terminal", "perfect-freehand"],
});
