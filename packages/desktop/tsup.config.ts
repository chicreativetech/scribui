import { copyFileSync, mkdirSync } from "node:fs";
import { defineConfig } from "tsup";

/**
 * Electron entry points, bundled to CommonJS: the main process (with the
 * workspace packages and their dependencies) and the preloads; plus the
 * projects window's script for the browser. Only Electron and the native
 * PNG renderer stay outside the bundle (and in the packaged node_modules).
 */
export default defineConfig([
  {
    entry: {
      main: "src/main.ts",
      preload: "src/preload.ts",
      launcherPreload: "src/launcherPreload.ts",
      spikeAndroidPreload: "src/spikeAndroidPreload.ts",
    },
    format: ["cjs"],
    outExtension: () => ({ js: ".cjs" }),
    target: "node22",
    platform: "node",
    outDir: "dist",
    clean: true,
    splitting: false,
    sourcemap: true,
    // everything but these (tsup's noExternal wins over external, so the pattern leaves them out)
    noExternal: [/^(?!(electron|@resvg\/resvg-js|playwright|bufferutil|utf-8-validate)(\/|$))/],
    external: ["electron", "@resvg/resvg-js", "playwright", "bufferutil", "utf-8-validate"],
  },
  {
    entry: { launcher: "src/launcher/launcher.ts" },
    format: ["iife"],
    outExtension: () => ({ js: ".js" }),
    target: "chrome130",
    platform: "browser",
    outDir: "dist",
    clean: false,
    sourcemap: false,
    onSuccess: async () => {
      mkdirSync("dist", { recursive: true });
      copyFileSync("src/launcher/launcher.html", "dist/launcher.html");
    },
  },
]);
