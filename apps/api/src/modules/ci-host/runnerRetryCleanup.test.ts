import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { deferred } from '../../../test/helpers/deferred.js'
import { HostCiRunner, type HostCiPorts } from './runner.js'

const reads = vi.hoisted(() => ({ queued: null as null | ((path: string) => Promise<void>) }))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, readFile: async (...args: Parameters<typeof actual.readFile>) => {
    const bytes = await actual.readFile(...args)
    if (String(args[0]).endsWith('/meta.json') && JSON.parse(String(bytes)).state === 'queued') {
      await reads.queued?.(String(args[0]))
    }
    return bytes
  } }
})

async function fixture() {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'ci-retry-cleanup-'))
  const active = new Set<string>()
  const ports: HostCiPorts = { cpus: 16, memoryBytes: 16 * 2 ** 30, now: () => new Date(),
    run: async (file, args) => {
      if (file === 'git' && args.includes('show')) {
        return { code: 0, stdout: JSON.stringify({ foremanCi: { hostSlots: 0 } }), stderr: '' }
      }
      if (file === 'git' && args.includes('worktree') && args.includes('add')) {
        const source = args.at(-2)!
        await mkdir(source, { recursive: true })
        await writeFile(join(source, 'package.json'), JSON.stringify({ scripts: { lint: 'fixture', unit: 'fixture' } }))
      }
      if (file === 'systemd-run') active.add(`${args.find(arg => arg.startsWith('--unit='))!.slice(7)}.service`)
      if (file === 'systemctl') {
        if (args.includes('stop')) active.delete(args.at(-1)!)
        const stdout = args.filter(arg => arg.endsWith('.service')).map(unit =>
          `Id=${unit}\nLoadState=loaded\nActiveState=${active.has(unit) ? 'active' : 'inactive'}\n`).join('\n')
        return { code: 0, stdout, stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    } }
  return { root, ports, runner: new HostCiRunner(root, ports, {}) }
}

it('preserves a live retry when a reader resumes with its earlier queued record', async () => {
  const { root, ports, runner } = await fixture()
  const reader = new HostCiRunner(root, ports, {})
  const request = { operation: 'start', runId: randomUUID(), repository: 'fixture/site',
    commit: 'a'.repeat(40), suite: 'lint', scope: 'full' }
  const retry = { ...request, runId: randomUUID(), suite: 'unit' }
  const entered = deferred()
  const release = deferred()
  let reading: ReturnType<HostCiRunner['handle']> | undefined
  try {
    await runner.handle(request)
    await runner.beginDrain()
    runner.resumeAdmissions()
    await expect(runner.handle(retry)).rejects.toMatchObject({ code: 'CI_HOST_BUSY' })
    await runner.cancel(request.runId)
    reads.queued = async path => {
      if (!path.includes(retry.runId)) return
      reads.queued = null
      entered.resolve()
      await release.promise
    }
    reading = reader.handle({ operation: 'read', runId: retry.runId, afterOffset: 0, maxBytes: 100 })
    await entered.promise
    await runner.handle(retry)
    await runner.beginDrain()
    runner.resumeAdmissions()
    release.resolve()
    await reading
    await expect(reader.handle({ operation: 'read', runId: retry.runId, afterOffset: 0, maxBytes: 100 }))
      .resolves.toMatchObject({ run: { state: 'running', exitCode: null, finishedAt: null } })
    await expect(reader.status()).resolves.toMatchObject({ slotsUsed: 1 })
    await expect(runner.handle({ ...request, runId: randomUUID() })).rejects.toMatchObject({ code: 'CI_HOST_BUSY' })
  } finally {
    reads.queued = null
    release.resolve()
    await reading
    await Promise.all([runner.beginDrain(), reader.beginDrain()])
    await rm(root, { recursive: true, force: true })
  }
})
