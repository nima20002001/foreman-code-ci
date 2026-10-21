import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const sourceExtensions = /\.(?:ts|tsx|js|jsx|mjs|cjs|css|html|sql)$/
const testFile = /\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)$/
const smokeFile = /\.smoke\.(?:ts|tsx|js|jsx|mjs|cjs)$/
const testSupportDirectory = /(?:^|\/)(?:test|tests|testing|__tests__|fixtures|mocks)(?:\/|$)/

export function classify(path) {
  if (/\.acceptance\.test\./.test(path)) return 'acceptance'
  if (/\.integration\.test\./.test(path)) return 'integration'
  if (smokeFile.test(path)) return 'smoke'
  if (testFile.test(path)) return 'unit'
  if (testSupportDirectory.test(path) || /(?:^|\/)[^/]*fixtures?\.(?:ts|tsx|js|jsx|mjs|cjs)$/i.test(path)) return 'support'
  if (/^(?:apps\/(?:api|web)|packages\/contracts)\/src\//.test(path) || /^apps\/web\/[^/]+\.html$/.test(path)) return 'source'
  return 'tooling'
}

export function physicalLines(content) {
  if (content.length === 0) return 0
  const newlines = content.match(/\n/g)?.length ?? 0
  return newlines + (content.endsWith('\n') ? 0 : 1)
}

function report() {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root })
    .toString('utf8').split('\0').filter(Boolean)
  const totals = Object.fromEntries(['source', 'unit', 'integration', 'acceptance', 'smoke', 'support', 'tooling'].map((kind) => [kind, 0]))
  const areas = new Map()

  for (const path of files) {
    if (!sourceExtensions.test(path)) continue
    const lines = physicalLines(readFileSync(join(root, path), 'utf8'))
    const kind = classify(path)
    const area = path.match(/^(apps\/[^/]+|packages\/[^/]+)\//)?.[1] ?? 'root tooling'
    totals[kind] += lines
    areas.set(area, (areas.get(area) ?? 0) + lines)
  }

  const tests = totals.unit + totals.integration + totals.acceptance + totals.smoke + totals.support
  const all = totals.source + tests + totals.tooling
  const width = Math.max(...Object.values(totals), all).toLocaleString().length
  const row = (label, count) => console.log(`  ${label.padEnd(18)} ${count.toLocaleString().padStart(width)}`)

  console.log('Tracked physical lines (.ts, .tsx, .js, .jsx, .mjs, .cjs, .css, .html, .sql)')
  row('Source code', totals.source)
  row('Tests + support', tests)
  for (const [label, kind] of [['Default tests', 'unit'], ['Integration', 'integration'], ['Acceptance', 'acceptance'], ['Smoke', 'smoke'], ['Test support', 'support']]) row(`  ${label}`, totals[kind])
  row('Tooling', totals.tooling)
  row('Total', all)
  console.log('\nBy area (all categories):')
  for (const [area, count] of [...areas].sort(([a], [b]) => a.localeCompare(b))) row(area, count)
  console.log('\nPhysical lines include comments and blank lines. Default tests are other .test/.spec files; test directories, fixtures, and mocks count as test support.')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) report()
