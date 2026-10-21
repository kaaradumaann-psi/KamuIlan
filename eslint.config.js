import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'data/**',
      // Git dışı canlı staging verisi ve yerel inceleme betikleri (.gitignore ile aynı).
      '.staging/**',
      'fixtures/live/**',
      'playwright-report/**',
      'test-results/**',
      'public/**',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
    },
  },
  {
    files: ['scripts/**/*.ts', 'src/worker/**/*.ts', 'tests/**/*.ts', 'tests/**/*.tsx', 'e2e/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
);
