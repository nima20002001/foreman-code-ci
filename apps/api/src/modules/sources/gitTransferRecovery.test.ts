import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { SOURCE_GIT_CACHE_LIMITS } from '@foreman-code/contracts/source-materialization'
import { runGitWithCacheStorage } from './gitCacheStorage.js'
import { runGitProcess } from './gitProcess.js'
import { lockOpenFile, openPrivateRoot } from './privateFilesystem.js'
import { ensureClone, ensureCommit, systemGitWorktreePorts, type GitWorktreePorts } from './gitWorktree.js'
import { persistentFixtureRoot } from '../../../test/helpers/fixtureStorage.js'
import { gitFixtureEnvironment } from '../../../test/helpers/gitFixture.js'
import { deferred } from '../../../test/helpers/deferred.js'
import { fetchingApi, interruptedFetchWriter, makeStale } from '../../../test/helpers/interruptedGitFetch.js'

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
}

it('charges detached Git writers after their API exits, then reclaims abandoned clone staging', async () => {
  const root = await mkdtemp(join(persistentFixtureRoot, 'git-transfer-recovery-'))
  const cache = join(root, 'cache')
  const staging = join(cache, 'abandoned-clone')
  const origin = join(root, 'origin')
  const socketName = `foreman-git-${randomUUID()}`
  const server = createServer()
  let api: ChildProcess | undefined
  let writer: Socket | undefined
  let waiter: ChildProcess | undefined
  let next: Promise<unknown> | undefined
  const entered = deferred()
  const resume = deferred()
  try {
    await mkdir(cache, { mode: 0o700 })
    await mkdir(origin, { mode: 0o700 })
    execFileSync('git', ['init', '--template=', '-q', '-b', 'main'], { cwd: origin, env: gitFixtureEnvironment() })
    const helper = join(root, 'remote.mjs')
    await writeFile(helper, `
      import { connect } from 'node:net';
      import { writeFile } from 'node:fs/promises';
      const socket = connect('\\0' + process.argv[2]);
      socket.on('connect', () => socket.write(String(process.pid) + '\\n'));
      socket.on('data', async command => {
        if (String(command).trim() === 'write') {
          await writeFile(process.argv[3] + '/writer.bin', 'orphan still writing');
          socket.write('written\\n');
        } else process.exit(0);
      });
    `)
    const launcher = join(root, 'api.mjs')
    await writeFile(launcher, `
      import { runGitWithCacheStorage } from ${JSON.stringify(new URL('./gitCacheStorage.ts', import.meta.url).href)};
      import { runGitProcess } from ${JSON.stringify(new URL('./gitProcess.ts', import.meta.url).href)};
      const [cache, helper, socket, target] = process.argv.slice(2);
      const remote = 'ext::' + process.execPath + ' ' + helper + ' ' + socket + ' ' + target;
      await runGitWithCacheStorage(cache, ['-c', 'protocol.ext.allow=always', 'clone', remote, target],
        { signal: new AbortController().signal }, (args, options) => runGitProcess(args, options, process.env));
    `)
    const connected = once(server, 'connection')
    server.listen('\0' + socketName)
    await once(server, 'listening')
    api = spawn(process.execPath, ['--import', 'tsx', launcher,
      cache, helper, socketName, staging], { env: gitFixtureEnvironment(), stdio: ['ignore', 'ignore', 'pipe'] })
    let errors = ''
    api.stderr!.on('data', chunk => { errors += String(chunk) })
    const exitedEarly = once(api, 'exit').then(() => { throw new Error(`Git API exited before its writer: ${errors}`) })
    const connection = await Promise.race([connected, exitedEarly]) as [Socket]
    writer = connection[0]
    const [pid] = await once(writer, 'data')
    const stat = await readFile(`/proc/${String(pid).trim()}/stat`, 'utf8')
    const group = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2])
    waiter = spawn('python3', ['-c',
      'import os,select,sys; fd=os.pidfd_open(int(sys.argv[1])); print("ready",flush=True); select.select([fd],[],[])',
      String(pid).trim()], { stdio: ['ignore', 'pipe', 'inherit'] })
    await once(waiter.stdout!, 'data')
    await stop(api)
    const written = once(writer, 'data')
    writer.write('write\n')
    expect(String((await written)[0]).trim()).toBe('written')
    expect(await readFile(join(staging, 'writer.bin'), 'utf8')).toBe('orphan still writing')

    const target = join(cache, 'next-clone')
    next = runGitWithCacheStorage(cache, ['clone', origin, target], { signal: new AbortController().signal },
      async (args, options) => {
        entered.resolve()
        await resume.promise
        return runGitProcess(args, options, gitFixtureEnvironment())
      })
    await entered.promise
    const storage = JSON.parse(await readFile(join(cache, 'storage.json'), 'utf8')) as { reservedBytes: number }
    expect(storage.reservedBytes).toBe(2 * SOURCE_GIT_CACHE_LIMITS.transferBytes)
    expect(await readFile(join(staging, 'writer.bin'), 'utf8')).toBe('orphan still writing')
    resume.resolve()
    await next
    const writerExited = once(waiter, 'exit')
    writer.write('exit\n')
    await writerExited
    // The abandoned clone ends once its remote closes.
    await vi.waitFor(() => expect(() => process.kill(-group, 0)).toThrow(), { timeout: 10_000 })
    await runGitWithCacheStorage(cache, ['clone', origin, join(cache, 'after-closure')],
      { signal: new AbortController().signal }, (args, options) => runGitProcess(args, options, gitFixtureEnvironment()))
    await expect(readFile(join(staging, 'writer.bin'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(cache)).filter(name => name.endsWith('.reservation'))).toEqual([])
    expect(JSON.parse(await readFile(join(cache, 'storage.json'), 'utf8'))).toMatchObject({ reservedBytes: 0 })
  } finally {
    resume.resolve()
    await next
    if (api) await stop(api)
    if (writer && !writer.destroyed) {
      const writerExited = waiter && waiter.exitCode === null && waiter.signalCode === null
        ? once(waiter, 'exit') : undefined
      writer.write('exit\n')
      await writerExited
      writer.destroy()
    } else if (waiter) await stop(waiter)
    server.close()
    await rm(root, { recursive: true, force: true })
  }
})

async function recoveryFixture() {
  const root = await mkdtemp(join(persistentFixtureRoot, 'git-cache-recovery-'))
  const home = join(root, 'home')
  const origin = join(root, 'origin')
  await mkdir(home, { mode: 0o700 })
  await mkdir(origin, { mode: 0o700 })
  const environment = { ...gitFixtureEnvironment(), HOME: home }
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args,
    { cwd, env: environment, encoding: 'utf8' }).trim()
  git(origin, 'init', '--template=', '-q', '-b', 'main')
  const commit = async (content: string) => {
    await writeFile(join(origin, 'source.txt'), content)
    git(origin, 'add', '.')
    git(origin, 'commit', '-qm', content)
    return git(origin, 'rev-parse', 'HEAD')
  }
  const first = await commit('first')
  const system = systemGitWorktreePorts(environment)
  const ports: GitWorktreePorts = { cloneDirectory: system.cloneDirectory,
    git: (args, options) => system.git(args.map(arg => arg === 'https://github.com/fixture/project.git'
      ? `file://${origin}` : arg), options) }
  const cache = join(home, '.local', 'share', 'foreman-code', 'git')
  return { root, home, origin, environment, git, commit, first, ports, cache }
}

/** Locks and partial packs a killed fetch leaves in the common directory; Git closed each before it died. */
const mainFetchArtifacts = { 'FETCH_HEAD.lock': 41, 'refs/foreman/ci/fetch/interrupted.lock': 41,
  'objects/pack/tmp_pack_interrupted': 4096, 'objects/pack/tmp_idx_interrupted': 1024 }
const fetchArtifacts = { ...mainFetchArtifacts, 'shallow.lock': 41, 'packed-refs.lock': 0,
  'refs/remotes/origin/main.lock': 41 }

async function expectRemoved(common: string, names: string[]) {
  for (const name of names) await expect(readFile(join(common, name))).rejects.toMatchObject({ code: 'ENOENT' })
}

it('removes a cancelled fetch’s own locks, recovers its stale packs, and preserves published data',
  async () => {
  const f = await recoveryFixture()
  let writer: Awaited<ReturnType<typeof interruptedFetchWriter>> | undefined
  try {
    const signal = AbortSignal.timeout(30_000)
    const clone = await ensureCommit(f.ports, 'fixture/project', f.first, signal)
    const successor = await f.commit('successor')
    const common = join(clone, '.git')
    const before = await readFile(join(common, 'shallow'))
    writer = await interruptedFetchWriter(f.root, common, mainFetchArtifacts)
    const controller = new AbortController()
    const running = runGitWithCacheStorage(f.cache, ['fetch', 'origin',
      `${successor}:refs/foreman/ci/fetch/interrupted`],
      { cwd: clone, signal: controller.signal },
      (args, options) => runGitProcess(args.includes('fetch') ? writer!.args : args, options, f.environment))
    await (await writer.started()).write()
    controller.abort()
    await expect(running).resolves.toMatchObject({ code: 1 })
    expect(await readFile(join(common, 'shallow'))).toEqual(before)
    expect(f.git(clone, 'rev-parse', 'HEAD')).toBe(f.first)

    await expectRemoved(common, ['FETCH_HEAD.lock', 'refs/foreman/ci/fetch/interrupted.lock'])
    await makeStale(common, Object.keys(mainFetchArtifacts).filter(name => name.startsWith('objects/pack/')))
    await expect(ensureCommit(f.ports, 'fixture/project', successor, signal)).resolves.toBe(clone)
    expect(f.git(clone, 'cat-file', '-t', successor)).toBe('commit')
    await expectRemoved(common, Object.keys(mainFetchArtifacts))
  } finally {
    writer?.close()
    await rm(f.root, { recursive: true, force: true })
  }
})

it('recovers the stale locks and packs of a fetch whose API died, from a fresh API instance', async () => {
  const f = await recoveryFixture()
  let api: ChildProcess | undefined
  let writer: Awaited<ReturnType<typeof interruptedFetchWriter>> | undefined
  try {
    const signal = AbortSignal.timeout(30_000)
    const clone = await ensureCommit(f.ports, 'fixture/project', f.first, signal)
    const successor = await f.commit('after restart')
    const common = join(clone, '.git')
    writer = await interruptedFetchWriter(f.root, common, fetchArtifacts)
    api = await fetchingApi(f.root, f.cache, clone, writer.args, f.environment)
    const transfer = await writer.started()
    await stop(api)
    await transfer.write()
    await transfer.die()
    await makeStale(common, Object.keys(fetchArtifacts))

    // A fresh process keeps nothing from the lost API: only the cache and the repository remain.
    const system = systemGitWorktreePorts(f.environment)
    await expect(ensureCommit(system, 'fixture/project', successor, signal)).resolves.toBe(clone)
    expect(f.git(clone, 'cat-file', '-t', successor)).toBe('commit')
    await expectRemoved(common, Object.keys(fetchArtifacts))
    expect((await readdir(f.cache)).filter(name => name.endsWith('.reservation'))).toEqual([])
  } finally {
    if (api) await stop(api)
    writer?.close()
    await rm(f.root, { recursive: true, force: true })
  }
})

/** An Agent's `git update-ref` (from `cwd`, after `gitArgs`), paused in its reference-transaction hook with its locks
 * held but closed, as Git keeps them between prepare and commit. */
async function liveAgentWriter(root: string, cwd: string, environment: NodeJS.ProcessEnv, input: string,
  gitArgs: string[] = []) {
  const hooks = join(root, 'agent-hooks')
  await mkdir(hooks, { mode: 0o700 })
  const address = `\0foreman-agent-writer-${randomUUID()}`
  const helper = join(hooks, 'prepared.mjs')
  await writeFile(helper, `
    import { connect } from 'node:net';
    const socket = connect(${JSON.stringify(address)});
    socket.on('connect', () => socket.write('prepared'));
    socket.on('data', () => process.exit(0));
  `)
  await writeFile(join(hooks, 'reference-transaction'),
    `#!/bin/sh\n[ "$1" = prepared ] || exit 0\nexec '${process.execPath}' '${helper}'\n`, { mode: 0o700 })
  const server = createServer()
  server.listen(address)
  await once(server, 'listening')
  let socket: Socket | undefined
  let child: ChildProcess | undefined
  return {
    async start() {
      const connected = once(server, 'connection')
      child = spawn('git', [...gitArgs, '-c', `core.hooksPath=${hooks}`, 'update-ref', '--stdin'],
        { cwd, env: environment, stdio: ['pipe', 'ignore', 'inherit'] })
      child.stdin!.end(input)
      ;[socket] = await connected as [Socket]
      await once(socket, 'data')
    },
    async finish() {
      const exited = once(child!, 'exit')
      socket!.write('continue')
      return (await exited)[0] as number | null
    },
    async close() {
      socket?.destroy()
      server.close()
      if (child) await stop(child)
    },
  }
}

it('keeps the fresh locks of an Agent Git writer during a cancelled fetch, recovers stale ones, then fetches after it',
  async () => {
    const f = await recoveryFixture()
    let writer: Awaited<ReturnType<typeof interruptedFetchWriter>> | undefined
    let agent: Awaited<ReturnType<typeof liveAgentWriter>> | undefined
    try {
      const signal = AbortSignal.timeout(30_000)
      const clone = await ensureCommit(f.ports, 'fixture/project', f.first, signal)
      const successor = await f.commit('successor')
      const common = join(clone, '.git')
      const worktree = join(f.root, 'agent')
      f.git(clone, 'worktree', 'add', '-q', '-b', 'foreman/agent', worktree, f.first)
      f.git(clone, 'branch', 'foreman/obsolete', f.first)
      agent = await liveAgentWriter(f.root, worktree, f.environment,
        `create refs/remotes/origin/agent-push ${f.first}\ndelete refs/heads/foreman/obsolete\n`)
      const agentLocks = ['refs/remotes/origin/agent-push.lock', 'refs/heads/foreman/obsolete.lock', 'packed-refs.lock']
      const interrupted = { 'shallow.lock': 41, 'refs/foreman/ci/fetch/interrupted.lock': 41,
        'objects/pack/tmp_pack_interrupted': 4096 }
      writer = await interruptedFetchWriter(f.root, common, interrupted)
      const controller = new AbortController()
      const running = runGitWithCacheStorage(f.cache, ['fetch', 'origin', successor],
        { cwd: clone, signal: controller.signal },
        (args, options) => runGitProcess(args.includes('fetch') ? writer!.args : args, options, f.environment))
      await (await writer.started()).write()
      await makeStale(common, Object.keys(interrupted))
      // Started before the fetch, the Agent would make its admission wait instead (asserted below).
      await agent.start()
      controller.abort()
      await expect(running).resolves.toMatchObject({ code: 1 })
      // A live reader or writer elsewhere in the repository does not keep abandoned artifacts.
      await expectRemoved(common, Object.keys(interrupted))
      for (const name of agentLocks) await expect(stat(join(common, name))).resolves.toBeTruthy()
      // Admission waits for the fresh locks within its deadline.
      await expect(ensureCommit(f.ports, 'fixture/project', successor, AbortSignal.timeout(2_000))).rejects.toThrow()
      for (const name of agentLocks) await expect(stat(join(common, name))).resolves.toBeTruthy()

      const waiting = ensureCommit(f.ports, 'fixture/project', successor, signal)
      expect(await agent.finish()).toBe(0)
      await expect(waiting).resolves.toBe(clone)
      expect(f.git(worktree, 'rev-parse', 'refs/remotes/origin/agent-push')).toBe(f.first)
      expect(f.git(clone, 'branch', '--list', 'foreman/obsolete')).toBe('')
      expect(f.git(clone, 'cat-file', '-t', successor)).toBe('commit')
    } finally {
      await agent?.close()
      writer?.close()
      await rm(f.root, { recursive: true, force: true })
    }
  },
)

const agentPlaces = ['an unrelated directory through --git-dir', 'an unrelated directory through a worktree .git file',
  'a subdirectory through a relative -C', 'the primary worktree of a separate Git directory'] as const

it.each(agentPlaces)(
  'keeps the fresh locks and packs of an Agent Git writer running from %s while a cancelled fetch recovers',
  async place => {
    const f = await recoveryFixture()
    let writer: Awaited<ReturnType<typeof interruptedFetchWriter>> | undefined
    let agent: Awaited<ReturnType<typeof liveAgentWriter>> | undefined
    try {
      let repository = await ensureCommit(f.ports, 'fixture/project', f.first, AbortSignal.timeout(30_000))
      let common = join(repository, '.git')
      let agentDirectory = join(f.root, 'elsewhere')
      await mkdir(agentDirectory, { mode: 0o700 })
      let agentArgs: string[] = []
      if (place === 'an unrelated directory through --git-dir') agentArgs = ['--git-dir', common]
      else if (place === 'an unrelated directory through a worktree .git file') {
        const worktree = join(f.root, 'agent')
        f.git(repository, 'worktree', 'add', '-q', '-b', 'foreman/agent', worktree, f.first)
        agentArgs = ['--git-dir', join(worktree, '.git')]
      } else if (place === 'a subdirectory through a relative -C') {
        agentDirectory = join(repository, 'sub', 'deep')
        await mkdir(agentDirectory, { recursive: true, mode: 0o700 })
        agentArgs = ['-C', '../..']
      } else {
        repository = join(f.root, 'primary')
        common = join(f.root, 'separate.git')
        f.git(f.root, 'clone', '-q', '--separate-git-dir', common, `file://${f.origin}`, repository)
        await chmod(common, 0o700)
        agentDirectory = repository
      }
      f.git(repository, 'branch', 'foreman/obsolete', f.first)
      agent = await liveAgentWriter(f.root, agentDirectory, f.environment,
        `create refs/remotes/origin/agent-push ${f.first}\ndelete refs/heads/foreman/obsolete\n`, agentArgs)
      // The Agent's pack between index-pack closing and renaming it: written, closed and fresh.
      const agentFiles = ['refs/remotes/origin/agent-push.lock', 'refs/heads/foreman/obsolete.lock', 'packed-refs.lock',
        'objects/pack/tmp_pack_agent', 'objects/pack/tmp_idx_agent']
      const interrupted = { 'refs/foreman/ci/fetch/interrupted.lock': 41, 'objects/pack/tmp_pack_interrupted': 4096 }
      writer = await interruptedFetchWriter(f.root, common, interrupted)
      for (const name of agentFiles.filter(name => name.includes('tmp_'))) await writeFile(join(common, name), 'agent')
      const controller = new AbortController()
      const running = runGitWithCacheStorage(f.cache, ['fetch', 'origin'], { cwd: repository, signal: controller.signal },
        (args, options) => runGitProcess(args.includes('fetch') ? writer!.args : args, options, f.environment))
      await (await writer.started()).write()
      await makeStale(common, Object.keys(interrupted))
      await agent.start()
      controller.abort()
      await expect(running).resolves.toMatchObject({ code: 1 })
      await expectRemoved(common, Object.keys(interrupted))
      for (const name of agentFiles) await expect(stat(join(common, name))).resolves.toBeTruthy()

      expect(await agent.finish()).toBe(0)
      expect(f.git(repository, 'rev-parse', 'refs/remotes/origin/agent-push')).toBe(f.first)
      expect(f.git(repository, 'branch', '--list', 'foreman/obsolete')).toBe('')
      await expect(runGitWithCacheStorage(f.cache, ['fetch', 'origin'], { cwd: repository,
        signal: AbortSignal.timeout(30_000) }, (args, options) => runGitProcess(args, options, f.environment)))
        .resolves.toMatchObject({ code: 0 })
      for (const name of agentFiles.filter(name => name.includes('tmp_'))) {
        await expect(stat(join(common, name))).resolves.toBeTruthy()
      }
    } finally {
      await agent?.close()
      writer?.close()
      await rm(f.root, { recursive: true, force: true })
    }
  },
)

it('stops an orphaned fetch at its deadline after its API dies, freeing the repository lock', async () => {
  const f = await recoveryFixture()
  let api: ChildProcess | undefined
  let writer: Awaited<ReturnType<typeof interruptedFetchWriter>> | undefined
  const probe = { handle: undefined as Awaited<ReturnType<typeof openPrivateRoot>> | undefined }
  try {
    const signal = AbortSignal.timeout(30_000)
    const clone = await ensureCommit(f.ports, 'fixture/project', f.first, signal)
    const successor = await f.commit('after the deadline')
    const common = join(clone, '.git')
    // This transfer never finishes on its own; only its deadline can end it.
    writer = await interruptedFetchWriter(f.root, common, {})
    const launcher = join(f.root, 'deadline-api.mjs')
    await writeFile(launcher, `
      import { runGitWithCacheStorage } from ${JSON.stringify(new URL('./gitCacheStorage.ts', import.meta.url).href)};
      import { runGitProcess } from ${JSON.stringify(new URL('./gitProcess.ts', import.meta.url).href)};
      const [cache, clone, writer] = process.argv.slice(2);
      await runGitWithCacheStorage(cache, ['fetch', 'origin'],
        { cwd: clone, signal: new AbortController().signal, timeoutMs: 3000 },
        (args, options) => runGitProcess(args.includes('fetch') ? JSON.parse(writer) : args, options, process.env));
    `)
    api = spawn(process.execPath, ['--import', 'tsx', launcher, f.cache, clone, JSON.stringify(writer.args)],
      { env: f.environment, stdio: ['ignore', 'ignore', 'inherit'] })
    await writer.started()
    await stop(api)
    probe.handle = await openPrivateRoot(common, false)
    expect(await lockOpenFile(probe.handle, { nonBlocking: true })).toBe(false)

    await vi.waitFor(async () => expect(await lockOpenFile(probe.handle!, { nonBlocking: true })).toBe(true),
      { timeout: 10_000, interval: 100 })
    await probe.handle.close()
    probe.handle = undefined
    await expect(ensureCommit(f.ports, 'fixture/project', successor, signal)).resolves.toBe(clone)
    expect(f.git(clone, 'cat-file', '-t', successor)).toBe('commit')
  } finally {
    await probe.handle?.close()
    if (api) await stop(api)
    writer?.close()
    await rm(f.root, { recursive: true, force: true })
  }
}, 30_000)

it('kills a descendant left in the Git process group once Git exits, freeing the inherited repository lock', async () => {
  const root = await mkdtemp(join(persistentFixtureRoot, 'git-process-group-'))
  const held = await open(root, 'r')
  const probe = await open(root, 'r')
  let leftover: number | undefined
  try {
    expect(await lockOpenFile(held)).toBe(true)
    const result = await runGitProcess(['-c', 'alias.linger=!sleep 60 >/dev/null 2>&1 & echo $!', 'linger'],
      { cwd: root, signal: AbortSignal.timeout(30_000), lockFd: held.fd }, gitFixtureEnvironment())
    expect(result.code).toBe(0)
    leftover = Number(result.stdout.trim())
    await held.close()
    await vi.waitFor(async () => expect(await lockOpenFile(probe, { nonBlocking: true })).toBe(true),
      { timeout: 5_000, interval: 100 })
  } finally {
    try { if (leftover) process.kill(leftover, 'SIGKILL') }
    catch (error) {
      // ignore: the descendant is already gone, as expected.
      expect((error as NodeJS.ErrnoException).code).toBe('ESRCH')
    }
    await held.close()
    await probe.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('recovers clone staging when the API exits as the clone command returns', async () => {
  const f = await recoveryFixture()
  let api: ChildProcess | undefined
  try {
    const launcher = join(f.root, 'clone-api.mjs')
    await writeFile(launcher, `
      import { ensureClone, systemGitWorktreePorts } from ${JSON.stringify(new URL('./gitWorktree.ts', import.meta.url).href)};
      const [home, origin] = process.argv.slice(2);
      const system = systemGitWorktreePorts({ ...process.env, HOME: home });
      const ports = { cloneDirectory: system.cloneDirectory, git: async (args, options) => {
        const result = await system.git(args.map(arg => arg === 'https://github.com/fixture/project.git'
          ? 'file://' + origin : arg), options);
        if (args[0] === 'clone' && result.code === 0) {
          process.send({ staging: args.at(-1) });
          await new Promise(resolve => process.once('message', resolve));
        }
        return result;
      } };
      await ensureClone(ports, 'fixture/project', new AbortController().signal);
    `)
    api = spawn(process.execPath, ['--import', 'tsx', launcher, f.home, f.origin],
      { env: f.environment, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    let errors = ''
    api.stderr!.on('data', chunk => { errors += String(chunk) })
    const earlyExit = once(api, 'exit').then(() => { throw new Error(`Clone API exited early: ${errors}`) })
    const [message] = await Promise.race([once(api, 'message'), earlyExit]) as [{ staging: string }]
    await stop(api)
    const clone = await ensureClone(f.ports, 'fixture/project', AbortSignal.timeout(30_000))
    expect(f.git(clone, 'rev-parse', 'HEAD')).toBe(f.first)
    await expect(readFile(join(message.staging, '.git', 'HEAD'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(f.cache)).filter(name => name.endsWith('.reservation'))).toEqual([])
  } finally {
    if (api) await stop(api)
    await rm(f.root, { recursive: true, force: true })
  }
})

it('preserves live completed staging across competing publication and removes its recovery record afterward', async () => {
  const f = await recoveryFixture()
  const entered = deferred()
  const resume = deferred()
  let preparing: Promise<string> | undefined
  let staging: string | undefined
  try {
    const signal = AbortSignal.timeout(30_000)
    const held: GitWorktreePorts = { cloneDirectory: f.ports.cloneDirectory, git: async (args, options) => {
      const result = await f.ports.git(args, options)
      if (args[0] === 'clone' && result.code === 0) {
        staging = args.at(-1)!
        entered.resolve()
        await resume.promise
      }
      return result
    } }
    preparing = ensureClone(held, 'fixture/project', signal)
    await entered.promise
    const clone = await ensureClone(f.ports, 'fixture/project', signal)
    expect(await readFile(join(staging!, '.git', 'HEAD'), 'utf8')).toBe('ref: refs/heads/main\n')
    expect(JSON.parse(await readFile(join(f.cache, 'storage.json'), 'utf8'))).toMatchObject({ reservedBytes: 0 })
    resume.resolve()
    await expect(preparing).resolves.toBe(clone)
    const successor = await f.commit('after competing publication')
    await expect(ensureCommit(f.ports, 'fixture/project', successor, signal)).resolves.toBe(clone)
    expect((await readdir(f.cache)).filter(name => /\.(?:reservation|staging)$/u.test(name))).toEqual([])
    expect(f.git(clone, 'cat-file', '-t', successor)).toBe('commit')
  } finally {
    resume.resolve()
    await preparing
    await rm(f.root, { recursive: true, force: true })
  }
})
