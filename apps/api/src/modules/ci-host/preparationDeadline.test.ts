import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { createServer, type Socket } from 'node:net'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { persistentFixtureRoot } from '../../../test/helpers/fixtureStorage.js'
import { systemHostCiPorts } from './runner.js'
import { withHostCiRunLock } from './runnerLock.js'

async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
}

function killWriter(pid: number) {
  try {
    process.kill(pid, 'SIGKILL')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

function handleProcessReadError(error: NodeJS.ErrnoException): undefined {
  if (error.code === 'ENOENT' || error.code === 'ESRCH') return undefined
  throw error
}

it.each(['ENOENT', 'ESRCH'])('treats %s from the process state read as a gone process', code => {
  const error = Object.assign(new Error('Process disappeared during read'), { code })
  expect(handleProcessReadError(error)).toBeUndefined()
})

it('preserves unexpected process state read failures', () => {
  const error = Object.assign(new Error('Permission denied'), { code: 'EACCES' })
  expect(() => handleProcessReadError(error)).toThrow(error)
})

it('enforces the preparation deadline after API exit and keeps the repository locked until writers stop', async () => {
  const root = await mkdtemp(join(persistentFixtureRoot, 'preparation-deadline-'))
  const repository = join(root, 'repository')
  await mkdir(repository)
  const socketName = `\0preparation-deadline-${randomUUID()}`
  const server = createServer()
  server.listen(socketName)
  await once(server, 'listening')
  const connected = once(server, 'connection')
  const writer = join(root, 'writer.mjs')
  // Ignore TERM so the independent supervisor must escalate to stop this writer.
  await writeFile(writer, `
    import { connect } from 'node:net';
    process.on('SIGTERM', () => {});
    const socket = connect(${JSON.stringify(socketName)});
    socket.on('connect', () => socket.end(String(process.pid)));
    setInterval(() => {}, 1000);
  `)
  const launcher = join(root, 'api.mjs')
  await writeFile(launcher, `
    import { systemHostCiPorts } from ${JSON.stringify(new URL('./runner.ts', import.meta.url).href)};
    import { withHostCiRunLock } from ${JSON.stringify(new URL('./runnerLock.ts', import.meta.url).href)};
    await withHostCiRunLock(${JSON.stringify(repository)}, guard =>
      systemHostCiPorts().run(process.execPath, [${JSON.stringify(writer)}],
        { lockFd: guard.fd, timeoutMs: 1000 }));
  `)
  const api = spawn(process.execPath, ['--import', 'tsx', launcher], { stdio: ['ignore', 'ignore', 'pipe'] })
  let errors = ''
  api.stderr!.on('data', chunk => { errors += String(chunk) })
  let pid: number | undefined
  try {
    const [socket] = await Promise.race([connected, once(api, 'exit').then(() => {
      throw new Error(`Fixture API exited before its writer connected: ${errors}`)
    })]) as [Socket]
    const [bytes] = await once(socket, 'data') as [Buffer]
    pid = Number(bytes.toString())
    await kill(api)
    expect(await withHostCiRunLock(repository, async () => 'released', { nonBlocking: true })).toBeUndefined()
    await expect(withHostCiRunLock(repository, async () => 'released', { signal: AbortSignal.timeout(3000) }))
      .resolves.toBe('released')
    const processState = await readFile(`/proc/${pid}/stat`, 'utf8').catch(handleProcessReadError)
    if (processState) expect(processState.slice(processState.lastIndexOf(') ') + 2).split(' ')[0]).toBe('Z')
  } finally {
    await kill(api)
    if (pid) killWriter(pid)
    server.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('reports a preparation command deadline and retains ordinary command results', async () => {
  const ports = systemHostCiPorts()
  const result = await ports.run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    timeoutMs: 100, signal: new AbortController().signal,
  })
  expect(result).toMatchObject({ timedOut: true })
  expect(result.code).not.toBe(0)
  await expect(ports.run(process.execPath, ['-e', 'console.log("finished")'], {
    timeoutMs: 1000, signal: new AbortController().signal,
  })).resolves.toMatchObject({ code: 0, stdout: 'finished\n', stderr: '' })
})
