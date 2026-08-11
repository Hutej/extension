// B7: ESLint config — the compile gate that was missing.
// Configured to fail on: unused exports (no-unused-vars), unreachable code,
// floating promises, and bare any casts. Scoped to src/ only.
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module', project: './tsconfig.json' },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      // Unused variables/exports
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Unreachable code
      'no-unreachable': 'error',
      // Floating promises — must be awaited or voided
      '@typescript-eslint/no-floating-promises': 'error',
      // Bare any casts — use unknown instead
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    // Test files — relax no-explicit-any (test fixtures often use any)
    files: ['tests/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module', project: './tsconfig.json' },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // Tool + agent layer — the boundary between model JSON and our code.
    // The model returns arbitrary JSON; these modules must accept it as-is.
    files: ['src/tools/**/*.ts', 'src/agent/**/*.ts', 'src/entrypoints/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module', project: './tsconfig.json' },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
];
