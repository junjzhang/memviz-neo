import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";

export default defineConfig({
  // VITE_BASE is set by the Pages workflow to "/memviz-neo/" so the
  // built bundle links to the right subpath. Local dev + preview stay
  // at "/".
  base: process.env.VITE_BASE || "/",
  plugins: [react(), wasm()],
  server: {
    port: 5173,
  },
});
