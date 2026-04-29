// Flat config for ESLint v9+
// Standardized across all Girls Network bots.
//
// Layout:
//   - src/**/*.ts          → TypeScript bot source (linted via typescript-eslint)
//   - *.cjs (root)         → standalone CommonJS utility scripts
//   - dist/, node_modules/ → ignored

const tseslint = require("typescript-eslint");

// Globals available to anything running on Node.
const nodeGlobals = {
  process: "readonly",
  console: "readonly",
  Buffer: "readonly",
  __dirname: "readonly",
  __filename: "readonly",
  global: "readonly",
  module: "readonly",
  require: "readonly",
  exports: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  setImmediate: "readonly",
  clearImmediate: "readonly",
  queueMicrotask: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  AbortController: "readonly",
  AbortSignal: "readonly",
  fetch: "readonly",
  performance: "readonly",
};

// Rules shared across every file we lint.
const sharedRules = {
  "no-unused-vars": [
    "warn",
    { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
  ],
  "no-undef": "error",
  "no-console": "off", // bots log to stdout intentionally
  eqeqeq: ["error", "always"],
  "prefer-const": "warn",
  "no-var": "error",
};

module.exports = [
  // 1) Global ignores
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "package-lock.json",
      "assets/**",
      "src/configs/**/*.json",
    ],
  },

  // 2) TypeScript bot source (src/**/*.ts)
  ...tseslint.configs.recommended.map((cfg) => ({
    ...cfg,
    files: ["src/**/*.ts"],
    languageOptions: {
      ...(cfg.languageOptions ?? {}),
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...nodeGlobals,
        ...((cfg.languageOptions && cfg.languageOptions.globals) || {}),
      },
    },
    rules: {
      ...(cfg.rules ?? {}),
      ...sharedRules,
      // TypeScript handles undefined-identifier checking far better than ESLint.
      "no-undef": "off",
      // Defer to the TS-aware variant so generics / type-only imports aren't flagged.
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // discord.js callbacks frequently take args you don't need; don't be noisy.
      "@typescript-eslint/no-explicit-any": "off",
    },
  })),

  // 3) Standalone CommonJS scripts at the repo root (e.g. renamer.cjs)
  {
    files: ["*.js", "*.cjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: nodeGlobals,
    },
    rules: sharedRules,
  },
];
