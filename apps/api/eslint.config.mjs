import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import { foremanLint } from '../../scripts/eslint-plugin-foreman/index.mjs'

export default tseslint.config(
  { ignores: ['dist/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  {
    // Integration tests wait for the condition they need (an event, a readback, an exit), never for a fixed time:
    // fixed waits make the suite slow and flaky. A test proving that something does NOT happen within a window may
    // keep its wait with an eslint-disable-next-line comment saying so.
    files: ['test/**/*.integration.test.ts'],
    rules: {
      'no-restricted-syntax': ['error',
        { selector: "NewExpression[callee.name='Promise'] > :function CallExpression[callee.name='setTimeout'][arguments.0.type='Identifier']",
          message: 'Wait for the observable condition instead of a fixed sleep.' },
        { selector: "NewExpression[callee.name='Promise'] > :function > BlockStatement > ExpressionStatement > CallExpression[callee.name='setTimeout'][arguments.0.type='Identifier']",
          message: 'Wait for the observable condition instead of a fixed sleep.' },
        { selector: "CallExpression[callee.name=/^(sleep|delay|pause)$/]",
          message: 'Wait for the observable condition instead of a fixed sleep.' },
      ],
      'no-restricted-imports': ['error', { paths: [
        { name: 'node:timers/promises', importNames: ['setTimeout', 'setInterval'],
          message: 'Wait for the observable condition instead of a fixed sleep.' },
        { name: 'timers/promises', importNames: ['setTimeout', 'setInterval'],
          message: 'Wait for the observable condition instead of a fixed sleep.' },
      ] }],
    },
  },
  {
    files: ['**/*.cjs'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    // These validators reject control characters in file names on purpose.
    files: [
      'src/modules/harnesses/codexFiles/bytes.ts',
    ],
    rules: { 'no-control-regex': 'off' },
  },
  ...foremanLint(import.meta.dirname),
)
