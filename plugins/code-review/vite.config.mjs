import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  publicDir: false,
  build: {
    outDir: "dist/browser",
    target: "es2022",
    lib: { entry: "src/browser/index.ts", formats: ["es"], fileName: () => "index.js" },
  },
});
