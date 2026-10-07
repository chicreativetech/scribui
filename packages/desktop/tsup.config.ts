import { defineConfig } from "tsup";

/**
 * Electron entry points, bundled to CommonJS: the main process (with the
 * workspace packages and the CLI modules it reuses) and the canvas preload.
 */
export default defineConfig({
  entry: { main: "src/main.ts", preload: "src/preload.ts", spikeAndroidPreload: "src/spikeAndroidPreload.ts" },
  format: ["cjs"],
  outExtension: () => ({ js: ".cjs" }),
  target: "node22",
  platform: "node",
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: true,
  noExternal: [/^@scribui\//],
  external: ["electron", "playwright", "@resvg/resvg-js", "hono", "@hono/node-server", "ws", "zod", "perfect-freehand"],
});
