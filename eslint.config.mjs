import obsidian from "eslint-plugin-obsidianmd";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

export default [
  {
    ignores: ["main.js", "*.config.mjs", "version-bump.mjs"],
  },
  {
    files: ["src/**/*.ts"],
    plugins: {
      "obsidianmd": obsidian,
      "@typescript-eslint": tseslint,
    },
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: "./tsconfig.json",
        sourceType: "module",
      },
    },
    rules: {
      ...obsidian.configs.recommended.rules,
      ...tseslint.configs.recommended.rules,
    },
  },
];
