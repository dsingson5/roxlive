import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // Relative base so the build works at any path (e.g. GitHub Pages /roxlive/)
  base: "./",
  plugins: [react(), tailwindcss()],
  server: {
    port: 5180,
    strictPort: false,
  },
  build: {
    target: "es2022",
    outDir: "docs", // GitHub Pages serves main:/docs
  },
});
