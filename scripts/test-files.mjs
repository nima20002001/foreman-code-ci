import { spawn } from 'node:child_process'
import { lstatSync } from 'node:fs'
import { posix } from 'node:path'
import { nativeAcceptanceEnvironment } from './test-native-acceptance.mjs'

const modes = ['scripts', 'unit', 'integration', 'acceptance']
const arguments_ = process.argv.slice(2)
if (arguments_[0] === '--') arguments_.shift()
const explicitMode = modes.includes(arguments_[0]) ? arguments_.shift() : undefined
if (!arguments_.length) throw new Error('Pass explicit repository-relative test files.')
const projects = ['apps/api', 'apps/web', 'packages/contracts', 'scripts']
const selections = new Map()
for (const file of arguments_) {
  const project = projects.find(folder => file.startsWith(`${folder}/`))
  if (!project || posix.normalize(file) !== file || file.split('/').includes('..')
    || !/\.test\.(?:ts|tsx|mjs)$/.test(file) || !lstatSync(file).isFile()) {
    throw new Error(`Invalid test file: ${file}`)
  }
  let mode = project === 'scripts' ? 'scripts' : 'unit'
  if (project === 'apps/api' && file.endsWith('.integration.test.ts')) mode = 'integration'
  if (project === 'apps/api' && file.endsWith('.acceptance.test.ts')) mode = 'acceptance'
  if (explicitMode && explicitMode !== mode) throw new Error(`Test file requires ${mode} mode: ${file}`)
  const key = `${project}:${mode}`
  const selected = selections.get(key) ?? { project, mode, files: new Set() }
  selected.files.add(file)
  selections.set(key, selected)
}

async function run(command, args, environment = process.env) {
  const child = spawn(command, args, { stdio: 'inherit', env: environment })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (value, signal) => resolve(value ?? (signal === 'SIGINT' ? 130 : 143)))
  })
  if (code !== 0) process.exitCode = code
  return code
}

const built = await run('corepack', ['pnpm', '--filter', '@foreman-code/contracts', 'build'])
if (built !== 0) throw new Error('Selected tests require the contracts build.')
for (const { project, mode, files } of selections.values()) {
  const selected = [...files]
  if (mode === 'scripts') {
    await run(process.execPath, ['--test', '--test-concurrency=12', ...selected])
  } else if (mode === 'integration') {
    await run(process.execPath, ['scripts/test-integration.mjs', '--files', ...selected])
  } else {
    const environment = mode === 'acceptance' ? nativeAcceptanceEnvironment(process.env) : process.env
    const workerOptions = mode === 'unit'
      ? ['--maxWorkers=12']
      : ['--no-file-parallelism', '--maxWorkers=1']
    await run('corepack', ['pnpm', '--dir', project, 'exec', 'vitest', 'run',
      ...selected.map(file => file.slice(project.length + 1)), ...workerOptions], environment)
  }
}
