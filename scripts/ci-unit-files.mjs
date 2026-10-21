// Unit slices use the CI database snapshot supplied through DURATIONS_INPUT.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, matchesGlob, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

export function unitFiles(files, suite, heavy = []) {
  const prefix = suite === 'unit-api' ? 'apps/api/' : 'apps/web/'
  if (suite !== 'unit-api' && suite !== 'unit-web') throw new Error(`Unknown unit suite: ${suite}`)
  return files.filter(file => {
    if (!file.startsWith(prefix) || /(?:^|\/)(?:node_modules|dist|\.git)\//.test(file)) return false
    const local = file.slice(prefix.length)
    if (suite === 'unit-api') {
      return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(local)
        && !/\.(?:integration|acceptance)\.test\.ts$/.test(local)
    }
    return /^src\/.*\.(?:test|spec)\.tsx?$/.test(local)
      && !heavy.some(pattern => matchesGlob(local, pattern))
  }).sort()
}

export function durationSlice(files, durations, slice = '') {
  if (!slice) return [...files].sort()
  const match = /^(\d+)\/(\d+)$/.exec(slice)
  const index = Number(match?.[1])
  const count = Number(match?.[2])
  if (!match || !Number.isSafeInteger(count) || index < 1 || index > count || count > files.length) {
    throw new Error(`Invalid unit slice: ${slice}`)
  }
  const valid = value => Number.isFinite(value) && value > 0
  const known = files.map(file => durations[file]).filter(valid).sort((a, b) => a - b)
  const fallback = known.length ? known[Math.floor(known.length / 2)] : 1
  const weight = file => valid(durations[file]) ? durations[file] : fallback
  const loads = Array(count).fill(0)
  const shards = Array.from({ length: count }, () => [])
  const ordered = [...files].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : 1))
  for (const file of ordered) {
    let lightest = 0
    for (let shard = 1; shard < count; shard++) {
      if (loads[shard] < loads[lightest]) lightest = shard
    }
    shards[lightest].push(file)
    loads[lightest] += weight(file)
  }
  return shards[index - 1].sort()
}

export function measuredUnitDurations(report, repository, suite) {
  const prefix = suite === 'unit-api' ? 'apps/api/' : 'apps/web/'
  const durations = {}
  for (const result of report.testResults ?? []) {
    const file = relative(repository, resolve(repository, result.name)).replaceAll('\\', '/')
    const elapsed = result.endTime - result.startTime
    if (file.startsWith(prefix) && result.status === 'passed' && Number.isFinite(elapsed) && elapsed > 0) {
      durations[file] = elapsed
    }
  }
  return durations
}

function readDurations(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

if (process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`) {
  const [command, suite, argument, output] = process.argv.slice(2)
  if (command === 'select') {
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0')
    const heavy = readDurations(resolve(root, 'apps/web/heavy-tests.json')).files
    const files = unitFiles(tracked, suite, heavy)
    const snapshot = process.env.DURATIONS_INPUT || resolve(root, 'scripts/ci-learned-durations.json')
    const durations = existsSync(snapshot) ? readDurations(snapshot) : JSON.parse(process.env.CI_DURATIONS || '{}')
    const prefix = suite === 'unit-api' ? 'apps/api/' : 'apps/web/'
    const selected = durationSlice(files, durations, argument)
    if (!selected.length) throw new Error('This unit slice has no files')
    // NUL delimiters preserve paths as separate shell arguments.
    process.stdout.write(selected.map(file => file.slice(prefix.length)).join('\0') + '\0')
  } else if (command === 'record' && output) {
    const durations = measuredUnitDurations(readDurations(argument), root, suite)
    mkdirSync(dirname(output), { recursive: true })
    writeFileSync(output, `${JSON.stringify(durations, null, 1)}\n`)
  } else {
    throw new Error('Usage: ci-unit-files.mjs select <suite> [i/n] | record <suite> <report> <output>')
  }
}
