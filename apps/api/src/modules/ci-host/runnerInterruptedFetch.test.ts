import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { deferred } from '../../../test/helpers/deferred.js'
import { gitFixtureEnvironment } from '../../../test/helpers/gitFixture.js'
import { HostCiRunner, systemHostCiPorts, type HostCiPorts } from './runner.js'

it('refetches a commit whose canceled warmup fetch left its files incomplete before checking it out', async () => {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'ci-interrupted-fetch-'))
  const origin = join(root, 'origin')
  const environment = gitFixtureEnvironment()
  const system = systemHostCiPorts(environment)
  const git = async (args: string[], cwd: string) => {
    const result = await system.run('git', args, { cwd, env: environment })
    if (result.code !== 0) throw new Error(`Fixture git ${args[0]} failed: ${result.stderr}`)
    return result.stdout
  }
  await mkdir(origin)
  await writeFile(join(origin, 'package.json'), JSON.stringify({ scripts: { lint: 'true' } }))
  for (const args of [['init', '-q', '-b', 'main'], ['add', '.'], ['commit', '-qm', 'fixture']]) await git(args, origin)
  const commit = (await git(['rev-parse', 'HEAD'], origin)).trim()
  const tree = (await git(['rev-parse', 'HEAD^{tree}'], origin)).trim()
  const fetchEntered = deferred()
  const launches: string[] = []
  let interrupted = false
  const ports: HostCiPorts = { cpus: 16, memoryBytes: 16 * 2 ** 30, now: () => new Date(),
    run: async (file, args, options = {}) => {
      if (file === 'git') {
        const local = args.map(arg => arg === 'https://github.com/fixture/site.git' ? origin : arg)
        if (!interrupted && args.includes('fetch')) {
          interrupted = true
          // A fetch killed while unpacking objects one by one has written the commit and its tree, not the blob.
          for (const object of [commit, tree]) {
            const path = join('.git', 'objects', object.slice(0, 2), object.slice(2))
            await mkdir(join(options.cwd!, path, '..'), { recursive: true })
            await copyFile(join(origin, path), join(options.cwd!, path))
          }
          fetchEntered.resolve()
          await new Promise<void>(resolve => options.signal!.addEventListener('abort', () => resolve(), { once: true }))
          return { code: 1, stdout: '', stderr: '' }
        }
        return system.run(file, local, { ...options, env: environment })
      }
      if (file === 'systemd-run') launches.push(args.find(arg => arg.startsWith('--unit='))!.slice('--unit='.length))
      if (file === 'systemctl') {
        const stdout = args.filter(arg => arg.endsWith('.service')).map(unit =>
          `Id=${unit}\nLoadState=loaded\nActiveState=active\n`).join('\n')
        return { code: 0, stdout, stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    } }
  const runner = new HostCiRunner(join(root, 'runner'), ports, environment)
  const request = { operation: 'start', repository: 'fixture/site', commit, scope: 'full' }
  const warmup = runner.handle({ ...request, runId: randomUUID(), suite: 'install', warmup: true })
  let real: ReturnType<HostCiRunner['handle']> | undefined
  try {
    await fetchEntered.promise
    const runId = randomUUID()
    real = runner.handle({ ...request, runId, suite: 'lint' })
    await real
    await expect(warmup).resolves.toMatchObject({ run: { state: 'canceled' } })
    const read = async () => {
      const reply = await runner.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 10_000 })
      if (!('run' in reply)) throw new Error('Expected a run reply')
      return reply.run
    }
    await vi.waitFor(async () => expect((await read()).state).not.toBe('starting'), { timeout: 10_000 })
    expect(await read()).toMatchObject({ state: 'running', message: null })
    expect(launches).toEqual([`foreman-ci-${runId}`])
  } finally {
    await Promise.allSettled([warmup, real])
    await runner.beginDrain()
    await rm(root, { recursive: true, force: true })
  }
})
