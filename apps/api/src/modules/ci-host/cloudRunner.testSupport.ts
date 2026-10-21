import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const parameter = (args: string[], name: string) => args.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1)

const root = fileURLToPath(new URL('../../../../../', import.meta.url))
export async function cloudSuiteRunner(checkout: string, command: string[], provider: 'github' | 'circleci') {
  const path = provider === 'github' ? '.github/workflows/ci.yml' : '.circleci/config.yml'
  const workflow = parse(await readFile(join(root, path), 'utf8'))
  const declarations = provider === 'github' ? workflow.on.workflow_dispatch.inputs : workflow.parameters
  const parameters = Object.fromEntries(Object.entries(declarations).map(([name, value]) => [name,
    parameter(command, name) ?? (value as { default?: string }).default ?? '']))
  const template = workflow.jobs.ci.env ?? workflow.jobs.ci.environment
  const environment = Object.fromEntries(Object.entries(template).map(([name, value]) => [name,
    String(value).replace(/\$\{\{\s*inputs\.(\w+)\s*\}\}|<<\s*pipeline.parameters\.(\w+)\s*>>/g,
      (_match, github: string | undefined, circle: string | undefined) => String(parameters[github ?? circle!])),
  ]))
  // Install runtime modules without changing the miniature repository's tracked file inventory.
  for (const file of ['scripts/ci-suite.sh', 'scripts/ci-files.mjs', 'scripts/ci-selection.mjs',
    'scripts/ci-affected.mjs', 'scripts/ci-affected-run.mjs', 'scripts/ci-test-results.mjs',
    'scripts/worker-snapshot-policy.mjs',
    'packages/contracts/src/ciPartition.mjs', 'packages/contracts/src/ciCoverage.mjs',
    'packages/contracts/src/integrationScheduling.mjs', 'packages/contracts/src/ciImportGraph.mjs']) {
    await mkdir(dirname(join(checkout, file)), { recursive: true })
    await copyFile(join(root, file), join(checkout, file))
  }
  const bin = join(checkout, 'bin')
  await mkdir(bin)
  const calls = join(checkout, 'calls.jsonl')
  await writeFile(calls, '')
  await writeFile(join(bin, 'corepack'), `#!${process.execPath}
require('node:fs').appendFileSync(process.env.CALLS_FILE, JSON.stringify(process.argv.slice(2)) + String.fromCharCode(10))
`, { mode: 0o755 })
  // The API command wrapper is the recording boundary; selection and suite scripts execute unchanged.
  await writeFile(join(checkout, 'scripts/test-command.mjs'), `
import { appendFileSync } from 'node:fs'
appendFileSync(process.env.CALLS_FILE, JSON.stringify(process.argv.slice(2)) + '\\n')
`)
  const run = () => spawnSync('bash', ['scripts/ci-suite.sh'], { cwd: checkout, encoding: 'utf8', env: {
    ...process.env, ...environment, PATH: `${bin}:${process.env.PATH}`, CALLS_FILE: calls,
    // Enclosing CI shell startup can prepend the real toolchain ahead of the recording boundary.
    BASH_ENV: '',
    CI_HOST_RUNNER: '1', CI_PREREQUISITES_UNTRACKED: '1', CI_USER_SYSTEMD: '0',
    CI_EXPECTED_DURATION_MS: '', TEST_RESULTS_OUTPUT: '', CI_STATE: join(checkout, 'state'),
    DURATIONS_OUTPUT: join(checkout, 'durations.json'),
    FOREMAN_CODE_CI_CLIS_PREFIX: '', FOREMAN_CODE_CI_TYPECHECK_CACHE: '',
    // The outer CI watchdog's progress channel would add reporter flags to the recorded command.
    CI_WATCHDOG_ACTIVE: '', CI_PROGRESS_FILE: '', CI_REPOSITORY_ROOT: '',
  } })
  return { run, calls }
}

