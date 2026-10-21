import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { deferred } from '../../../test/helpers/deferred.js'
import { HostCiRunner, type HostCiPorts } from './runner.js'
import { withHostCiRunLock } from './runnerLock.js'

it.each(['read', 'status', 'start'])('returns %s while a retained checkout repository is busy, then retries cleanup', async operation => {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'ci-busy-repository-'))
  const runId = randomUUID()
  const directory = join(root, 'runs', runId)
  const clone = join(root, 'git/fixture/site')
  const entered = deferred()
  const release = deferred()
  await mkdir(clone, { recursive: true })
  await mkdir(join(directory, 'src'), { recursive: true })
  await writeFile(join(directory, 'src/.git'), 'gitdir: retained-worktree\n')
  await writeFile(join(directory, 'log'), 'retained output')
  await writeFile(join(directory, 'step'), 'lint')
  await writeFile(join(directory, 'meta.json'), JSON.stringify({ runId, repository: 'fixture/site',
    commit: 'a'.repeat(40), suite: 'lint', partition: null, state: 'passed', cleaned: false,
    startedAt: '2026-10-01T00:00:00Z', finishedAt: '2026-10-01T00:01:00Z', exitCode: 0, message: null }))
  const ports: HostCiPorts = { cpus: 16, memoryBytes: 16 * 2 ** 30, now: () => new Date(),
    run: async (file, args) => {
      if (file === 'git' && args.includes('add') && args.includes('worktree')) {
        const source = args.at(-2)!
        await mkdir(source, { recursive: true })
        await writeFile(join(source, 'package.json'), JSON.stringify({ scripts: { lint: 'fixture' } }))
      }
      const stdout = file === 'systemctl' ? args.filter(arg => arg.endsWith('.service')).map(unit =>
        `Id=${unit}\nLoadState=loaded\nActiveState=active\n`).join('\n') : ''
      return { code: 0, stdout, stderr: '' }
    } }
  const runner = new HostCiRunner(root, ports, {})
  const holding = withHostCiRunLock(clone, async () => { entered.resolve(); await release.promise })
  let pending: ReturnType<HostCiRunner['handle']> | undefined
  try {
    await entered.promise
    const requests = {
      start: { operation: 'start', runId: randomUUID(), repository: 'fixture/other',
        commit: 'a'.repeat(40), suite: 'lint', scope: 'full' },
      status: { operation: 'status' },
      read: { operation: 'read', runId, afterOffset: 0, maxBytes: 100 },
    }
    pending = runner.handle(requests[operation as keyof typeof requests])
    const completed = await Promise.race([
      pending.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 500)),
    ])
    expect(completed, 'retained cleanup must not hold up reads or admission').toBe(true)
    expect(existsSync(join(directory, 'src'))).toBe(true)
    expect(JSON.parse(await readFile(join(directory, 'meta.json'), 'utf8')).cleaned).toBe(false)
    release.resolve()
    await holding
    await expect(runner.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 100 }))
      .resolves.toMatchObject({ run: { state: 'passed' }, text: 'retained output' })
    expect(existsSync(join(directory, 'src'))).toBe(false)
    expect(JSON.parse(await readFile(join(directory, 'meta.json'), 'utf8')).cleaned).toBe(true)
  } finally {
    release.resolve()
    await holding
    await pending
    await runner.beginDrain()
    await rm(root, { recursive: true, force: true })
  }
})
