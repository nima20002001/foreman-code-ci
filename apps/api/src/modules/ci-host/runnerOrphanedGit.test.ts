import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { persistentFixtureRoot } from '../../../test/helpers/fixtureStorage.js'
import { gitFixtureEnvironment } from '../../../test/helpers/gitFixture.js'
import { HostCiRunner, systemHostCiPorts, type HostCiPorts } from './runner.js'
import { withHostCiRunLock } from './runnerLock.js'

async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
}

it('keeps surviving Git writers locked across a Main restart and recovers only after they exit', async () => {
  const root = await mkdtemp(join(persistentFixtureRoot, 'ci-orphaned-git-'))
  const runnerRoot = join(root, 'runner')
  const clone = join(runnerRoot, 'git', 'fixture', 'site')
  const origin = join(root, 'origin')
  await mkdir(origin, { mode: 0o700 })
  const environment = gitFixtureEnvironment()
  const system = systemHostCiPorts(environment)
  const git = async (args: string[]) => {
    const result = await system.run('git', args, { cwd: origin })
    if (result.code !== 0) throw new Error(result.stderr)
    return result.stdout.trim()
  }
  await writeFile(join(origin, 'package.json'), JSON.stringify({ scripts: { lint: 'true' } }))
  for (const args of [['init', '--template=', '-q', '-b', 'main'], ['add', '.'], ['commit', '-qm', 'fixture']]) {
    await git(args)
  }
  const commit = await git(['rev-parse', 'HEAD'])
  const socketName = `\0ci-writer-${randomUUID()}`
  const server = createServer()
  server.listen(socketName)
  await once(server, 'listening')
  const connected = once(server, 'connection')
  const helper = join(root, 'remote.mjs')
  const lock = join(clone, '.git', 'shallow.lock')
  await writeFile(helper, `
    import { connect } from 'node:net';
    import { writeFile } from 'node:fs/promises';
    await writeFile(${JSON.stringify(lock)}, 'live writer');
    const socket = connect(${JSON.stringify(socketName)});
    socket.on('connect', () => socket.write('ready'));
    socket.on('data', () => process.exit(0));
  `)
  const launcher = join(root, 'api.mjs')
  await writeFile(launcher, `
    import { HostCiRunner, systemHostCiPorts } from ${JSON.stringify(new URL('./runner.ts', import.meta.url).href)};
    const system = systemHostCiPorts();
    const ports = { cpus: 16, memoryBytes: 16 * 2 ** 30, now: () => new Date(),
      run: async (file, args, options) => {
        if (file !== 'git') return { code: 0, stdout: '', stderr: '' };
        if (args.includes('fetch')) {
          args = ['-c', 'protocol.ext.allow=always', ...args.map(arg => arg === 'origin'
            ? ${JSON.stringify('ext::' + process.execPath + ' ' + helper)} : arg)];
        }
        return system.run(file, args, options);
      } };
    const runner = new HostCiRunner(${JSON.stringify(runnerRoot)}, ports, process.env);
    await runner.handle({ operation: 'start', runId: ${JSON.stringify(randomUUID())},
      repository: 'fixture/site', commit: ${JSON.stringify(commit)}, suite: 'lint', scope: 'full' });
  `)
  const api = spawn(process.execPath, ['--import', 'tsx', launcher],
    { env: environment, stdio: ['ignore', 'ignore', 'pipe'] })
  let errors = ''
  api.stderr!.on('data', chunk => { errors += String(chunk) })
  const exitedEarly = once(api, 'exit').then(() => { throw new Error(`Fixture API exited early: ${errors}`) })
  let socket: Socket | undefined
  let runner: HostCiRunner | undefined
  try {
    ;[socket] = await Promise.race([connected, exitedEarly]) as [Socket]
    await once(socket, 'data')
    await kill(api)
    expect(await withHostCiRunLock(clone, async () => 'reclaimed', { nonBlocking: true })).toBeUndefined()
    expect(await readFile(lock, 'utf8')).toBe('live writer')
    const closed = once(socket, 'close')
    socket.write('exit')
    await closed
    await expect(withHostCiRunLock(clone, async () => 'released', { signal: AbortSignal.timeout(5000) }))
      .resolves.toBe('released')
    await git(['-C', clone, 'remote', 'set-url', 'origin', origin])
    const ports: HostCiPorts = { ...system, cpus: 16, memoryBytes: 16 * 2 ** 30,
      run: async (file, args, options) => {
        if (file === 'git') return system.run(file,
          args.map(arg => arg === 'https://github.com/fixture/site.git' ? origin : arg), options)
        const stdout = file === 'systemctl' ? args.filter(arg => arg.endsWith('.service')).map(unit =>
          `Id=${unit}\nLoadState=loaded\nActiveState=active\n`).join('\n') : ''
        return { code: 0, stdout, stderr: '' }
      } }
    runner = new HostCiRunner(runnerRoot, ports, environment)
    const runId = randomUUID()
    await runner.handle({ operation: 'start', runId, repository: 'fixture/site', commit, suite: 'lint', scope: 'full' })
    await vi.waitFor(async () => {
      await expect(runner!.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 100 }))
        .resolves.toMatchObject({ run: { state: 'running' } })
    })
    await expect(readFile(lock)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await kill(api)
    if (socket && !socket.destroyed) {
      const closed = once(socket, 'close')
      socket.write('exit')
      await closed
    }
    await runner?.beginDrain()
    server.close()
    await rm(root, { recursive: true, force: true })
  }
})
