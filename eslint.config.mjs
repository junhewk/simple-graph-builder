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
      // The Obsidian review bot also runs these; keep them local so lint
      // catches what the bot would.
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/unbound-method": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "no-restricted-globals": ["error",
        ...["setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame"]
          .map(name => ({ name, message: `Use window.${name}() for popout window compatibility.` })),
        { name: "globalThis", message: "Use window or activeWindow for popout window compatibility." },
      ],
    },
  },
];
