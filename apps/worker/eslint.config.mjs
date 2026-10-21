import js from '@eslint/js'
import globals from 'globals'
import { foremanLint } from '../../scripts/eslint-plugin-foreman/index.mjs'

export default [
  { ignores: ['dist/**'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.node,
    },
  },
  ...foremanLint(import.meta.dirname),
]
