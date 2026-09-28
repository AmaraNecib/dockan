import { defineConfig } from "oxlint";

export default defineConfig({
  ignorePatterns: [
    ".agent/**",
    ".agents/**",
    ".claude/**",
    ".codex/**",
    ".continue/**",
    ".cursor/**",
    ".gemini/**",
    ".opencode/**",
    ".pi/**",
    ".roo/**",
    ".windsurf/**",
    ".scratch/**",
    "tools/oxlint/anti-slop/**",
    "node_modules/**",
    "dist/**",
    "data/**",
    "logs/**",
    "backups/**",
  ],
  jsPlugins: [{ name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" }, "@shadcn/lint"],
  rules: {
    // shadcn design-system rules. See .scratch/implementation/101-design.md for
    // why no-restyle, no-arbitrary-values and no-inline-styles stay disabled.
    "shadcn/no-raw-colors": "error",
    "shadcn/no-unknown-classes": "error",
    "shadcn/require-static-classes": "error",
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-runtime-typeof": "error",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",
  },
  overrides: [
    {
      // items.tsx and stock.tsx are owned by the sibling design-hygiene lane.
      // Remove this override once their raw palette classes are tokenised.
      files: ["apps/web/src/pages/items.tsx", "apps/web/src/pages/stock.tsx"],
      rules: { "shadcn/no-raw-colors": "off" },
    },
  ],
  env: {
    browser: true,
    node: true,
  },
});