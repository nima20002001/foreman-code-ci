import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { deferred } from '../../../test/helpers/deferred.js'
import { HostCiRunner, type HostCiPorts } from './runner.js'

const cleanup = vi.hoisted(() => ({ inspected: null as null | ((path: string) => void) }))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, stat: async (...args: Parameters<typeof actual.stat>) => {
    const result = await actual.stat(...args)
    cleanup.inspected?.(String(args[0]))
    return result
  } }
})

it.each([false, true])('serializes retained worktree cleanup with checkout across another runner=%s', async restarted => {
  const base = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'ci-repository-cleanup-'))
  const checkoutEntered = deferred()
  const releaseCheckout = deferred()
  const cleanupInspected = deferred()
  const retainedId = randomUUID()
  const retained = join(root, 'runs', retainedId)
  let checkingOut = false
  const overlappingCleanup: string[] = []
  const ports: HostCiPorts = { cpus: 16, memoryBytes: 16 * 2 ** 30, now: () => new Date(),
    run: async (file, args) => {
      if (file === 'git' && args.includes('worktree')) {
        if (args.includes('add')) {
          checkingOut = true
          checkoutEntered.resolve()
          await releaseCheckout.promise
          const source = args.at(-2)!
          await mkdir(source, { recursive: true })
          await writeFile(join(source, 'package.json'), JSON.stringify({ scripts: { lint: 'fixture' } }))
          checkingOut = false
        } else if (checkingOut && (args.includes('remove') || args.includes('prune'))) {
          overlappingCleanup.push(args.includes('remove') ? 'remove' : 'prune')
        }
      }
      if (file === 'systemctl') {
        const stdout = args.filter(arg => arg.endsWith('.service')).map(unit =>
          `Id=${unit}\nLoadState=loaded\nActiveState=active\n`).join('\n')
        return { code: 0, stdout, stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    } }
  const runner = new HostCiRunner(root, ports, {})
  const reader = restarted ? new HostCiRunner(root, ports, {}) : runner
  const request = { operation: 'start', runId: randomUUID(), repository: 'fixture/site',
    commit: 'a'.repeat(40), suite: 'lint', scope: 'full' }
  let reading: ReturnType<HostCiRunner['handle']> | undefined
  const starting = runner.handle(request)
  try {
    await checkoutEntered.promise
    await starting
    await mkdir(join(retained, 'src'), { recursive: true })
    await writeFile(join(retained, 'src', '.git'), 'gitdir: retained-worktree\n')
    await writeFile(join(retained, 'log'), 'retained output')
    await writeFile(join(retained, 'meta.json'), JSON.stringify({ runId: retainedId,
      repository: request.repository, commit: request.commit, suite: 'lint', partition: null,
      state: 'passed', cleaned: false, startedAt: '2026-10-01T00:00:00Z',
      finishedAt: '2026-10-01T00:01:00Z', exitCode: 0, message: null }))
    cleanup.inspected = path => {
      if (path === join(retained, 'src', '.git')) cleanupInspected.resolve()
    }
    reading = reader.handle({ operation: 'read', runId: retainedId, afterOffset: 0, maxBytes: 100 })
    await cleanupInspected.promise
    // The stat has finished; drain its promise continuations before releasing the checkout command.
    await new Promise<void>(resolve => setImmediate(resolve))
    releaseCheckout.resolve()
    await expect(reading).resolves.toMatchObject({ run: { state: 'passed' }, text: 'retained output' })
    await runner.beginDrain()
    expect(overlappingCleanup).toEqual([])
    await expect(runner.handle({ operation: 'read', runId: request.runId, afterOffset: 0, maxBytes: 100 }))
      .resolves.toMatchObject({ run: { state: 'running' } })
  } finally {
    cleanup.inspected = null
    releaseCheckout.resolve()
    await starting
    await reading
    await Promise.all([runner.beginDrain(), reader.beginDrain()])
    await rm(root, { recursive: true, force: true })
  }
})
