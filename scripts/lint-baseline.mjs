// Shrinks scripts/lint-allowlist.json to the files, test names and import cycles that still break a rule.
//   node scripts/lint-baseline.mjs
// Runs each package's ESLint with the allowlist disabled. It never adds an entry: the allowlist only shrinks.
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiImportGraph, importCycles, newCycles } from './check-import-cycles.mjs'
import { lintFilePaths } from './lint-allowlist.mjs'
import { hasTicketName } from './check-test-names.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const file = `${root}/scripts/lint-allowlist.json`
const allowlist = JSON.parse(readFileSync(file, 'utf8'))

const paths = lintFilePaths(root, allowlist)

const failing = new Map(Object.keys(allowlist.eslint).map(id => [id, new Set()]))
for (const project of ['apps/api', 'apps/web', 'apps/worker', 'packages/contracts']) {
  const result = spawnSync('corepack', ['pnpm', '--dir', project, 'exec', 'eslint', '.', '--format', 'json'], {
    cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, env: { ...process.env, FOREMAN_LINT_BASELINE: '1' },
  })
  if (result.status !== 0 && result.status !== 1) throw new Error(`ESLint failed in ${project}:\n${result.stderr}`)
  for (const report of JSON.parse(result.stdout)) {
    for (const message of report.messages) failing.get(message.ruleId)?.add(relative(root, report.filePath))
  }
}

const before = JSON.stringify(allowlist)
for (const [id, files] of Object.entries(allowlist.eslint)) {
  allowlist.eslint[id] = files.filter(fileId => paths[fileId]?.some(path => failing.get(id).has(path)))
}
allowlist['test-names'] = allowlist['test-names'].filter(id => paths[id]?.some(hasTicketName))
const cycles = importCycles(apiImportGraph())
allowlist['import-cycles'] = allowlist['import-cycles'].filter(ids => {
  const cycle = ids.map(id => paths[id]?.length === 1 ? paths[id][0] : undefined)
  return cycle.every(Boolean) && cycles.some(found => !newCycles([found], [cycle]).length)
})
const retained = new Set([...Object.values(allowlist.eslint).flat(), ...allowlist['test-names'],
  ...allowlist['import-cycles'].flat()])
allowlist.files = Object.fromEntries(Object.entries(allowlist.files).filter(([id]) => retained.has(id)))
writeFileSync(file, `${JSON.stringify(allowlist, null, 2)}\n`)
console.log(before === JSON.stringify(allowlist) ? 'The allowlist is already minimal.' : 'Pruned scripts/lint-allowlist.json.')
