import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig({
  files: ["src/**/*.ts", "test/**/*.ts"],
  extends: [js.configs.recommended, tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
  languageOptions: {
    globals: { ...globals.browser, ...globals.node },
    parserOptions: { project: "./tsconfig.json", tsconfigRootDir: import.meta.dirname },
  },
  rules: {
    "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
    "@typescript-eslint/strict-boolean-expressions": "error",
    "@typescript-eslint/no-meaningless-void-operator": "off"
  },
});
