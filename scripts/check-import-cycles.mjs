import { resolveLintAllowlist } from './lint-allowlist.mjs'
// Fails on runtime import cycles among apps/api/src modules.
//   node scripts/check-import-cycles.mjs
// Type-only imports and dynamic import() do not count. Cycles listed in scripts/lint-allowlist.json
// ("import-cycles", one array of files per cycle) predate the check: a cycle passes only when all its files belong
// to one listed cycle, so that list may only shrink.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = /\.(?:[cm]?ts|tsx)$/
const statement = /^\s*(import|export)\s+(type\s+)?([\w$*\s,]*(?:\{[^}]*\})?)\s*from\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm

/** Runtime import specifiers of one module; `import type`, all-`type` named lists and dynamic import() are skipped. */
export function runtimeImports(text) {
  const specifiers = []
  for (const match of text.matchAll(statement)) {
    if (match[5]) { specifiers.push(match[5]); continue }
    if (match[2]) continue
    const names = /^\{([^}]*)\}$/.exec(match[3].trim())?.[1]
    if (names !== undefined) {
      const list = names.split(',').map(name => name.trim()).filter(Boolean)
      if (list.length && list.every(name => name.startsWith('type '))) continue
    }
    specifiers.push(match[4])
  }
  return specifiers
}

/** Strongly connected components with more than one module, or a module importing itself, as sorted file lists. */
export function importCycles(graph) {
  let counter = 0
  const index = new Map(), low = new Map(), stack = [], onStack = new Set(), cycles = []
  const visit = start => {
    // Iterative Tarjan: deep import chains must not overflow the call stack.
    const work = [[start, 0]]
    index.set(start, counter); low.set(start, counter++); stack.push(start); onStack.add(start)
    while (work.length) {
      const frame = work[work.length - 1]
      const [node] = frame
      const next = (graph.get(node) ?? [])[frame[1]++]
      if (next !== undefined) {
        if (!index.has(next)) {
          index.set(next, counter); low.set(next, counter++); stack.push(next); onStack.add(next)
          work.push([next, 0])
        } else if (onStack.has(next)) low.set(node, Math.min(low.get(node), index.get(next)))
        continue
      }
      work.pop()
      if (work.length) {
        const parent = work[work.length - 1][0]
        low.set(parent, Math.min(low.get(parent), low.get(node)))
      }
      if (low.get(node) !== index.get(node)) continue
      const component = []
      let member
      do { member = stack.pop(); onStack.delete(member); component.push(member) } while (member !== node)
      if (component.length > 1 || (graph.get(node) ?? []).includes(node)) cycles.push(component.sort())
    }
  }
  for (const node of graph.keys()) if (!index.has(node)) visit(node)
  return cycles
}

export function newCycles(cycles, allowed) {
  return cycles.filter(cycle => !allowed.some(list => cycle.every(file => list.includes(file))))
}

function files(directory) {
  return readdirSync(`${root}/${directory}`, { withFileTypes: true }).flatMap(entry => {
    const path = `${directory}/${entry.name}`
    return entry.isDirectory() ? files(path) : source.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name) ? [path] : []
  })
}

/** The runtime import graph of apps/api/src, with repository-relative file names. */
export function apiImportGraph() {
  const modules = new Set(files('apps/api/src'))
  const graph = new Map()
  for (const file of modules) {
    const targets = new Set()
    for (const specifier of runtimeImports(readFileSync(`${root}/${file}`, 'utf8'))) {
      if (!specifier.startsWith('.')) continue
      const stem = posix.join(posix.dirname(file), specifier).replace(/\.[cm]?js$/, '')
      const target = ['.ts', '.tsx', '.mts', '/index.ts'].map(extension => `${stem}${extension}`).find(path => modules.has(path))
      if (target) targets.add(target)
    }
    graph.set(file, [...targets])
  }
  return graph
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const allowed = resolveLintAllowlist(root, JSON.parse(readFileSync(`${root}/scripts/lint-allowlist.json`, 'utf8')))['import-cycles']
  const rejected = newCycles(importCycles(apiImportGraph()), allowed)
  if (rejected.length) {
    console.error('Import cycles in apps/api/src (move the shared code into a module both sides import):')
    for (const cycle of rejected) console.error(`  ${cycle.join(' <-> ')}`)
    process.exit(1)
  }
}
