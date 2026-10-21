import { spawn } from 'node:child_process'
import { lstatSync, readFileSync, rmSync } from 'node:fs'
import { matchesGlob, posix, resolve } from 'node:path'
import { repositoryFileList, selectByIndexes } from './ci-files.mjs'
import { writeCiTestResults } from './ci-test-results.mjs'

const projects = ['packages/contracts', 'apps/api', 'apps/web', 'apps/worker']
const heavyWebFiles = () => JSON.parse(readFileSync(resolve('apps/web/heavy-tests.json'), 'utf8')).files

/** Commands use argument arrays; supplied file names never become shell code. */
export function affectedCommands(suite, files) {
  const groups = new Map()
  for (const file of files) {
    if (posix.normalize(file) !== file || file.startsWith('/') || file.split('/').includes('..')
      || (!projects.some(project => file.startsWith(`${project}/`)) && !file.startsWith('scripts/'))) {
      throw new Error(`Invalid CI file: ${file}`)
    }
    const project = projects.find(value => file.startsWith(`${value}/`))
    const key = project ?? 'scripts'
    groups.set(key, [...groups.get(key) ?? [], file])
  }
  const commands = []
  for (const [project, selected] of groups) {
    if (suite === 'typecheck') {
      if (project !== 'scripts' && project !== 'apps/worker') commands.push(['corepack', 'pnpm', '--dir', project, 'typecheck'])
    } else if (suite === 'lint') {
      if (project === 'scripts') throw new Error('Scripts have no package lint command.')
      commands.push(['corepack', 'pnpm', '--dir', project, 'exec', 'eslint',
        ...selected.map(file => file.slice(project.length + 1)), '--max-warnings', '0'])
    } else if (suite === 'unit') {
      if (selected.some(file => !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)
        || (file.startsWith('apps/api/') && /\.(?:integration|acceptance)\.test\.ts$/.test(file)))) {
        throw new Error('Unit scope requires unit test files.')
      }
      const nodeFiles = selected.filter(file => file.endsWith('.mjs'))
      const vitestFiles = selected.filter(file => !file.endsWith('.mjs'))
      // Only API tests use the disposable PostgreSQL server, which CI starts for the unit and unit-api parts alone.
      const database = project === 'apps/api' ? [process.execPath, 'scripts/test-command.mjs', '--'] : []
      if (nodeFiles.length) commands.push([...database, process.execPath, '--test', ...nodeFiles])
      const vitest = selected => [...database, 'corepack', 'pnpm', '--dir', project, 'exec', 'vitest', 'run',
        ...selected.map(file => file.slice(project.length + 1))]
      if (project === 'apps/web') {
        // Load-sensitive web suites need the heavy phase's workers and timeouts, as in full runs.
        const heavy = heavyWebFiles()
        const isHeavy = file => heavy.some(pattern => matchesGlob(file.slice(project.length + 1), pattern))
        for (const [phase, phaseFiles] of [['fast', vitestFiles.filter(file => !isHeavy(file))],
          ['heavy', vitestFiles.filter(isHeavy)]]) {
          if (phaseFiles.length) commands.push(['env', `FOREMAN_WEB_TEST_PHASE=${phase}`, ...vitest(phaseFiles)])
        }
      } else if (vitestFiles.length) commands.push(vitest(vitestFiles))
    } else throw new Error(`Unsupported affected suite: ${suite}`)
  }
  return commands
}

async function run(command) {
  const environment = { ...process.env, CI: 'true' }
  // Nested CI commands in tests must not inherit this run's dispatch selection.
  delete environment.SCOPE
  delete environment.SELECTED_FILES
  delete environment.SLICE
  delete environment.DEFAULT_BRANCH
  delete environment.CI_PARTITION
  delete environment.CI_DURATIONS
  delete environment.TEST_RESULTS_OUTPUT
  const child = spawn(command[0], command.slice(1), { stdio: 'inherit', env: environment })
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)))
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [suite, option, value] = process.argv.slice(2)
  let files
  if (option === '--files-from') files = JSON.parse(readFileSync(value, 'utf8'))
  else if (option === '--indexes') files = selectByIndexes(repositoryFileList(process.cwd()), value ?? '')
  else throw new Error('Pass --files-from or --indexes for affected CI.')
  if (!Array.isArray(files) || files.some(file => typeof file !== 'string')) {
    throw new Error('CI selection must contain existing repository files.')
  }
  const missingFiles = files.filter(file => !lstatSync(file, { throwIfNoEntry: false })?.isFile())
  if (missingFiles.length) {
    throw new Error(`CI selection must contain existing repository files: ${missingFiles.join(', ')}`)
  }
  const commands = affectedCommands(suite, files)
  if (commands.length) {
    const code = await run(['corepack', 'pnpm', '--filter', '@foreman-code/contracts', 'build'])
    if (code) process.exit(code)
  }
  // With TEST_RESULTS_OUTPUT, each Vitest and Node test command also writes a JSON report; together they become the results.
  const output = suite === 'unit' && process.env.TEST_RESULTS_OUTPUT ? resolve(process.env.TEST_RESULTS_OUTPUT) : null
  const reports = []
  for (const command of commands) {
    const nodeTest = command.includes('--test')
    const report = output && (command.includes('vitest') || nodeTest) ? `${output}.${reports.length}.report.json` : null
    if (report) reports.push(report)
    const progressReporter = command.includes('vitest') && process.env.CI_PROGRESS_FILE
      ? [`--reporter=${resolve('scripts/ci-progress-reporter.mjs')}`] : []
    let reported = report && !nodeTest
      ? [...command, '--reporter=default', '--reporter=json', `--outputFile.json=${report}`, ...progressReporter]
      : [...command, ...(progressReporter.length ? ['--reporter=default', ...progressReporter] : [])]
    if (nodeTest && (report || process.env.CI_PROGRESS_FILE)) {
      reported = command.flatMap(argument => argument === '--test' ? [argument,
        '--test-reporter=spec', '--test-reporter-destination=stdout',
        `--test-reporter=${resolve('scripts/ci-node-test-reporter.mjs')}`,
        // Node flushes file destinations with fsync, which fails on character devices.
        `--test-reporter-destination=${report ?? resolve(`${process.env.CI_PROGRESS_FILE}.node-report.json`)}`] : [argument])
    }
    const code = await run(reported)
    if (code) { process.exitCode = code; break }
  }
  if (output && reports.length) {
    try { writeCiTestResults(output, reports) }
    catch (error) { console.error(`Test results were not recorded: ${error.message}`) }
    for (const report of reports) rmSync(report, { force: true })
  }
  if (!commands.length) console.log('No affected files for this suite.')
}
