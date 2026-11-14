// Audit 4.6: dev-only linting (zero npm runtime dependencies are untouched —
// eslint lives in devDependencies). Recommended rules; the codebase predates
// them, so a few stylistic rules are relaxed rather than churning every file.
import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    files: ['core/**/*.mjs', 'bin/**/*.mjs', 'scripts/**/*.mjs', 'tests/**/*.mjs'],
    languageOptions: {
      // 2025: import attributes (`import pkg from './x.json' with { type: 'json' }`).
      ecmaVersion: 2025,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2024 },
    },
    rules: {
      // Unused imports/vars are burn-down territory (79 warnings at adoption);
      // the armed-and-undefined references (no-undef) were fixed at adoption.
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-useless-assignment': 'warn',
      // `catch {}` around best-effort close/kill is a deliberate idiom here.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // The suite intentionally throws inside assertions and re-throws UhErrors.
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-control-regex': 'off',
    },
  },
  {
    ignores: ['runtime/**', 'dist/**', 'android/**', 'node_modules/**', 'desktop/**', '**/*.json'],
  },
];
