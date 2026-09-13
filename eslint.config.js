import js from '@eslint/js';
import tseslint from 'typescript-eslint';
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'test/fixtures/**', '.claude/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }] } },
  // Plain Node ESM helper scripts (no TypeScript, no bundler): give them the globals.
  { files: ['scripts/**/*.mjs'], languageOptions: { globals: { process: 'readonly' } } },
);
