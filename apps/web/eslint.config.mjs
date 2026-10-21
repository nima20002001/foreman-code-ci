import eslint from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import { foremanLint } from '../../scripts/eslint-plugin-foreman/index.mjs'

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/node_modules/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      'react-hooks/exhaustive-deps': 'warn',
      'react-hooks/rules-of-hooks': 'error',
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true, extraHOCs: ['createLink'] },
      ],
    },
  },
  {
    // Feature code renders form fields through the design-system kit (shared/ui/nocturne).
    files: ['src/features/**/*.tsx', 'src/routes/**/*.tsx', 'src/app/**/*.tsx'],
    ignores: ['**/*.test.tsx', '**/fixtures/**'],
    rules: {
      'no-restricted-syntax': ['error', {
        selector: "JSXOpeningElement[name.name=/^(input|select|textarea)$/]",
        message: 'Use TextField, SearchField, Textarea, Select, Checkbox, Switch or Slider from shared/ui/nocturne.',
      }],
    },
  },
  {
    // Terminal output is stripped of control sequences before display.
    files: ['src/features/jobs/model.ts'],
    rules: { 'no-control-regex': 'off' },
  },
  ...foremanLint(import.meta.dirname),
)
