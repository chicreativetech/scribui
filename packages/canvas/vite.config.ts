import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = process.env.INTENTCUE_API ?? "http://127.0.0.1:4382";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5183,
    proxy: {
      "/api": api,
      "/files": api,
      "/ws": { target: api.replace(/^http/, "ws"), ws: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 900 },
});
