import assert from 'node:assert/strict'
import { test } from 'node:test'
import { importCycles, newCycles, runtimeImports } from './check-import-cycles.mjs'

test('runtime imports skip type-only and dynamic imports', () => {
  const text = [
    "import { a } from './a.js'",
    'export function local() {\n  return 1\n}',
    "import type { B } from './b.js'",
    "import { type C, type D } from './c.js'",
    "import { type E, f } from './e.js'",
    "export * from './g.js'",
    "import './h.js'",
    "const lazy = await import('./i.js')",
    'import {\n  j,\n  k,\n} from "./j.js"',
  ].join('\n')
  assert.deepEqual(runtimeImports(text), ['./a.js', './e.js', './g.js', './h.js', './j.js'])
})

test('cycles are strongly connected modules and self-imports', () => {
  const graph = new Map([['a', ['b']], ['b', ['c']], ['c', ['a']], ['d', ['a']], ['e', ['e']], ['f', []]])
  assert.deepEqual(importCycles(graph).sort(), [['a', 'b', 'c'], ['e']])
})

test('only cycles outside one allowlisted cycle are new', () => {
  const allowed = [['a', 'b', 'c']]
  assert.deepEqual(newCycles([['a', 'b'], ['a', 'd']], allowed), [['a', 'd']])
})
