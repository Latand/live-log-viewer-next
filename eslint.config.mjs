import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Publish artifact assembled by scripts/prepack.mjs; gitignored.
    "dist/**",
    // Agent worktrees created by Claude Code sessions; each lints itself.
    ".claude/**",
    // Research artifacts dropped by tmux-multi-agent sessions; third-party code.
    ".tmux-multi-agent/**",
  ]),
  {
    // `.cjs` names CommonJS, and these files mean it: they are mounted into the
    // pinned puppeteer image and run by plain `node`, where `puppeteer` and
    // `sharp` resolve through NODE_PATH — which Node honours for `require` and
    // not for ESM `import`. Rewriting them as modules would break resolution in
    // the container, so `require()` is the correct module style here rather than
    // a lapse, and the rule that forbids it does not apply.
    files: ["**/*.cjs"],
    languageOptions: { sourceType: "commonjs" },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
]);

export default eslintConfig;
