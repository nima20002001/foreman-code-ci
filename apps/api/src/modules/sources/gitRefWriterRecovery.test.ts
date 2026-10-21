import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { persistentFixtureRoot } from '../../../test/helpers/fixtureStorage.js'
import { gitFixtureEnvironment } from '../../../test/helpers/gitFixture.js'
import { ensureCommit, systemGitWorktreePorts } from './gitWorktree.js'
import { lockOpenFile, openPrivateRoot } from './privateFilesystem.js'

it.each(['update-ref', 'worktree'] as const)(
  'keeps a prepared %s ref transaction locked while fetch recovery waits', async command => {
    const root = await mkdtemp(join(persistentFixtureRoot, 'git-ref-recovery-'))
    const home = join(root, 'home')
    const origin = join(root, 'origin')
    const hooks = join(root, 'hooks')
    await Promise.all([home, origin, hooks].map(path => mkdir(path, { mode: 0o700 })))
    const environment = { ...gitFixtureEnvironment(), HOME: home }
    const git = (...args: string[]) => execFileSync('git', args, { cwd: origin, env: environment,
      encoding: 'utf8' }).trim()
    git('init', '--template=', '-q', '-b', 'main')
    await writeFile(join(origin, 'source.txt'), 'first')
    git('add', '.')
    git('commit', '-qm', 'first')
    const first = git('rev-parse', 'HEAD')
    const system = systemGitWorktreePorts(environment)
    const ports = { cloneDirectory: system.cloneDirectory, git: (args: string[],
      options: Parameters<typeof system.git>[1]) => system.git(args.map(arg =>
      arg === 'https://github.com/fixture/project.git' ? `file://${origin}` : arg), options) }
    const signal = AbortSignal.timeout(15_000)
    const clone = await ensureCommit(ports, 'fixture/project', first, signal)
    await writeFile(join(origin, 'source.txt'), 'successor')
    git('commit', '-qam', 'successor')
    const successor = git('rev-parse', 'HEAD')
    const socketPath = `\0git-ref-writer-${randomUUID()}`
    const helper = join(root, 'hook.mjs')
    await writeFile(helper, `
      import { connect } from 'node:net';
      import { existsSync, writeFileSync } from 'node:fs';
      const paused = ${JSON.stringify(join(hooks, 'paused'))};
      if (process.argv[2] === 'prepared' && !existsSync(paused)) {
        writeFileSync(paused, 'prepared');
        const socket = connect(${JSON.stringify(socketPath)});
        socket.on('connect', () => socket.write('prepared'));
        socket.on('data', () => process.exit(0));
      }
    `)
    await writeFile(join(hooks, 'reference-transaction'),
      `#!/bin/sh\nexec '${process.execPath}' '${helper}' "$@"\n`, { mode: 0o700 })
    const server = createServer()
    server.listen(socketPath)
    await once(server, 'listening')
    const connected = once(server, 'connection')
    const ref = 'refs/heads/foreman/result'
    const args = command === 'update-ref' ? ['update-ref', ref, first]
      : ['worktree', 'add', '-b', 'foreman/result', join(root, 'checkout'), first]
    const writing = ports.git(['-c', `core.hooksPath=${hooks}`, ...args], { cwd: clone, signal })
    let socket: Socket | undefined
    let fetching: Promise<string> | undefined
    const probe = await openPrivateRoot(join(clone, '.git'), false)
    try {
      ;[socket] = await connected as [Socket]
      await once(socket, 'data')
      fetching = ensureCommit(ports, 'fixture/project', successor, signal)
      const cache = join(home, '.local', 'share', 'foreman-code', 'git')
      await vi.waitFor(async () => {
        const storage = JSON.parse(await readFile(join(cache, 'storage.json'), 'utf8')) as { reservedBytes: number }
        expect(storage.reservedBytes).toBeGreaterThan(0)
      })
      expect(await lockOpenFile(probe, { nonBlocking: true })).toBe(false)
      expect(await readFile(join(clone, '.git', `${ref}.lock`), 'utf8')).toBe(`${first}\n`)
      socket.write('continue')
      expect(await writing).toMatchObject({ code: 0 })
      await expect(fetching).resolves.toBe(clone)
      expect(execFileSync('git', ['rev-parse', ref], { cwd: clone, encoding: 'utf8' }).trim()).toBe(first)
    } finally {
      await probe.close()
      socket?.write('continue')
      await Promise.allSettled([writing, fetching])
      socket?.destroy()
      server.close()
      await rm(root, { recursive: true, force: true })
    }
  },
)
