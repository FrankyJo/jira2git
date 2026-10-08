import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', '.idea/**'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' },
      ],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'node:child_process',
              importNames: ['exec', 'execSync'],
              message: 'Shell execution is forbidden. Use execFile with an argument array.',
            },
            {
              name: 'child_process',
              message: 'Import from node:child_process, and never use exec/execSync.',
            },
          ],
        },
      ],
    },
  },
  { files: ['**/*.js'], ...tseslint.configs.disableTypeChecked },
  prettier,
);
