import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import { execSync } from "node:child_process";

// Resolve a version string from the tag that's building (release.yml
// passes VITE_APP_VERSION=${github.ref_name}); fall back to a short
// commit sha for main CI / local dev so the UI chip never shows nothing.
function resolveVersion(): string {
  if (process.env.VITE_APP_VERSION) return process.env.VITE_APP_VERSION;
  try {
    const sha = execSync("git rev-parse --short HEAD").toString().trim();
    return `dev-${sha}`;
  } catch {
    return "dev";
  }
}

export default defineConfig({
  // VITE_BASE is set by the Pages workflow to "/memviz-neo/" so the
  // built bundle links to the right subpath. Local dev + preview stay
  // at "/".
  base: process.env.VITE_BASE || "/",
  plugins: [react(), wasm()],
  define: {
    __APP_VERSION__: JSON.stringify(resolveVersion()),
  },
  server: {
    port: 5173,
  },
});
