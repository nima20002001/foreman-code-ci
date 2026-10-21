import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { afterAll } from 'vitest'
import { startFileCoverage, writeFileCoverage } from '../../../scripts/integration-coverage.mjs'

const directory = process.env.FOREMAN_CODE_INTEGRATION_COVERAGE_DIRECTORY
const file = process.env.FOREMAN_CODE_TEST_FILE
if (directory && file) {
  const root = resolve('../..')
  const tracked = new Set(execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0'))
  const stop = await startFileCoverage()
  afterAll(async () => { writeFileCoverage(directory, file, await stop(root, tracked), stop.requiresStatic) })
}
