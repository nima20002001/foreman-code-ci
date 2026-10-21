import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dirname, join, matchesGlob, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { affectedSnapshot } from './ci-affected.mjs'
import { integrationPartition } from '../packages/contracts/src/ciPartition.mjs'
import { integrationFileList } from './ci-files.mjs'
import { expandIntegrationCoverage } from '../packages/contracts/src/ciCoverage.mjs'

export function executionFiles(files, executionSuite, cwd) {
  const [suite, part] = executionSuite.split('-')
  if (!part) return files
  const heavyPath = join(cwd, 'apps/web/heavy-tests.json')
  const heavy = existsSync(heavyPath) ? JSON.parse(readFileSync(heavyPath, 'utf8')).files : []
  return files.filter(file => {
    if (part === 'api') return file.startsWith('apps/api/')
    if (part === 'other') return !file.startsWith('apps/api/') && (suite !== 'unit' || !file.startsWith('apps/web/'))
    const isHeavy = heavy.some(pattern => matchesGlob(file.slice('apps/web/'.length), pattern))
    return file.startsWith('apps/web/') && (executionSuite === 'unit-web-heavy' ? isHeavy : !isHeavy)
  })
}

/** Learned timings travel with the immutable cloud snapshot, outside provider parameter limits. */
export function executionDurations(suite, cwd, learned = {}) {
  const learnedPath = join(cwd, 'scripts/ci-learned-durations.json')
  const snapshot = existsSync(learnedPath) ? JSON.parse(readFileSync(learnedPath, 'utf8')) : learned
  return snapshot
}

/** Selection and partitioning happen in the checked-out repository on the cloud runner. */
export function executionSelection({ commit, baseCommit, executionSuite, defaultRef, partition, learned = {}, cwd = process.cwd() }) {
  const suite = executionSuite.split('-')[0]
  const coveragePath = join(cwd, 'ci-integration-coverage.json')
  const coverage = existsSync(coveragePath) ? JSON.parse(readFileSync(coveragePath, 'utf8')) : undefined
  // Main validates source ancestry before copying this input into the mirror's synthetic Git history.
  const prepared = coverage ? { changedFiles: coverage.changedFiles, coverageReason: coverage.reason,
    coverageMap: coverage.map ? expandIntegrationCoverage(JSON.parse(gunzipSync(Buffer.from(coverage.map, 'base64'),
      { maxOutputLength: 64 * 1024 * 1024 }).toString())) : undefined } : undefined
  const selection = affectedSnapshot(commit, suite, cwd, defaultRef, baseCommit, [], prepared)
  let files = executionFiles(selection.files, executionSuite, cwd)
  if (selection.scope === 'full' && suite === 'integration' && partition) files = integrationFileList(cwd)
  if (partition && (selection.scope === 'affected' || suite === 'integration')) {
    files = integrationPartition(files, executionDurations(suite, cwd, learned), partition)
  }
  return { ...selection, files,
    ...(selection.staticFallbackFiles ? { staticFallbackFiles: selection.staticFallbackFiles.filter(file => files.includes(file)) } : {}) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === '--dispatch-inputs') {
    const data = readFileSync('ci-dispatch-inputs.json')
    const hash = createHash('sha256').update(data).digest('hex')
    if (process.env.CI_PARTITION !== `sha256:${hash}`) throw new Error('CI dispatch inputs hash mismatch')
    const inputs = JSON.parse(data.toString())
    if (Object.keys(inputs).sort().join(',') !== 'commit,files,partition,slice'
      || Object.values(inputs).some(value => typeof value !== 'string')
      || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(inputs.commit)
      || inputs.partition.startsWith('sha256:')) throw new Error('Invalid CI dispatch inputs')
    const result = spawnSync('bash', process.argv.slice(3), { stdio: 'inherit', env: { ...process.env,
      SLICE: inputs.slice, SELECTED_FILES: inputs.files, CI_PARTITION: inputs.partition,
      CI_SELECTION_COMMIT: inputs.commit } })
    if (result.error) throw result.error
    if (result.signal) process.kill(process.pid, result.signal)
    process.exit(result.status ?? 1)
  }
  const [executionSuite, defaultRef, partition, output] = process.argv.slice(2)
  const selection = executionSelection({ commit: process.env.CI_SELECTION_COMMIT || 'HEAD', executionSuite, defaultRef,
    baseCommit: process.env.BASE_COMMIT || undefined,
    partition: partition ? JSON.parse(partition) : undefined, learned: JSON.parse(process.env.CI_DURATIONS || '{}') })
  writeFileSync(output, JSON.stringify(selection.files))
  if (process.env.CI_SELECTION_OUTPUT) {
    mkdirSync(dirname(process.env.CI_SELECTION_OUTPUT), { recursive: true })
    writeFileSync(process.env.CI_SELECTION_OUTPUT, JSON.stringify(selection))
  }
  console.error(selection.scope === 'full' ? `Running full suite: ${selection.reason}`
    : `Selected ${selection.files.length} affected files for ${executionSuite}: ${selection.reason}`)
  console.log(selection.scope)
}
