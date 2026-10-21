import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { HostCiRunner, type HostCiPorts } from './runner.js'

async function fixture(options: {
  exitCode: number | null
  collected?: boolean
  canceled?: boolean
  watchdogMessage?: string
}) {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, 'ci-exit-status-'))
  const runId = randomUUID()
  const directory = join(root, 'runs', runId)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'meta.json'), JSON.stringify({
    runId, repository: 'example/project', commit: 'a'.repeat(40), suite: 'integration',
    state: 'running', startedAt: '2026-10-13T00:00:00Z', finishedAt: null,
    exitCode: null, message: null, cleaned: false, cancellationRequested: options.canceled ?? false,
  }))
  await writeFile(join(directory, 'log'), 'Suite completed.\n')
  // The runner reads a cancellation request from this marker file.
  if (options.canceled) await writeFile(join(directory, 'cancel-requested'), '')
  const ports: HostCiPorts = {
    now: () => new Date('2026-10-13T00:01:00Z'), cpus: 8, memoryBytes: 16 * 2 ** 30,
    run: async (file, args) => {
      if (file !== 'systemctl') throw new Error(`Unexpected command: ${file}`)
      if (args.includes('stop')) return { code: 0, stdout: '', stderr: '' }
      if (args.includes('show')) {
        // The unit completes after reconciliation's first exit read, before the manager replies.
        if (options.exitCode !== null) {
          if (options.watchdogMessage) {
            await writeFile(join(directory, 'watchdog-message.json'), JSON.stringify({
              message: options.watchdogMessage,
            }))
          }
          await writeFile(join(directory, 'exit'), `${options.exitCode}\n`)
        }
        const loadState = options.collected ? 'not-found' : 'loaded'
        const unit = args.find(arg => arg.endsWith('.service'))
        return { code: 0, stdout: `Id=${unit}\nLoadState=${loadState}\nActiveState=inactive\n`, stderr: '' }
      }
      throw new Error(`Unexpected systemctl operation: ${args.join(' ')}`)
    },
  }
  return { root, directory, runner: new HostCiRunner(root, ports, {}),
    read: { operation: 'read', runId, afterOffset: 0, maxBytes: 100 } }
}

it.each([
  { exitCode: 0, collected: false, state: 'passed' },
  { exitCode: 1, collected: false, state: 'failed' },
  { exitCode: 0, collected: true, state: 'passed' },
  { exitCode: 1, collected: true, state: 'failed' },
])('records exit $exitCode when the unit becomes stopped during polling (collected: $collected)', async options => {
  const f = await fixture(options)
  try {
    await expect(f.runner.handle(f.read)).resolves.toMatchObject({
      operation: 'read', run: { state: options.state, exitCode: options.exitCode, message: null },
    })
    const persisted = JSON.parse(await readFile(join(f.directory, 'meta.json'), 'utf8'))
    expect(persisted).toMatchObject({ state: options.state, exitCode: options.exitCode, cleaned: true })
    await expect(f.runner.handle(f.read)).resolves.toMatchObject({
      run: { state: options.state, exitCode: options.exitCode },
    })
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

it('retains the exit code when cancellation completes during polling', async () => {
  const f = await fixture({ exitCode: 143, canceled: true })
  try {
    await expect(f.runner.handle(f.read)).resolves.toMatchObject({ run: { state: 'canceled', exitCode: 143 } })
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

it('retains the watchdog failure message when the unit completes during polling', async () => {
  const message = 'The CI suite stopped producing output.'
  const f = await fixture({ exitCode: 1, watchdogMessage: message })
  try {
    await expect(f.runner.handle(f.read)).resolves.toMatchObject({ run: { state: 'failed', exitCode: 1, message } })
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

it('still reports a stopped unit without an exit file as lost', async () => {
  const f = await fixture({ exitCode: null })
  try {
    await expect(f.runner.handle(f.read)).resolves.toMatchObject({ run: {
      state: 'lost', exitCode: null, message: 'The CI unit ended without an exit status.',
    } })
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})
