import { createServer, createConnection, type Socket } from 'node:net'
import { constants } from 'node:fs'
import { chmod, lstat, open, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { DomainError } from '../errors.js'
import { atomicBrowserPrivateJson } from './journal.js'

interface DrainRecord { commandId: string; state: 'draining' | 'canceled' }
interface RuntimeDrainHost {
  stopAdmission(): void
  resumeAdmission(): void
  activeSessionCount(): number
  closeIdleProfiles(): Promise<void>
}

/** Private installer handshake. The existing host lease and same-user Unix socket own this seam. */
export async function startBrowserRuntimeControl(root: string, host: RuntimeDrainHost,
  assertHostOwnership: () => Promise<void>, reportFailure: (error: unknown) => void) {
  await assertHostOwnership()
  const directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const control = await listenRuntimeControl(root, `/proc/self/fd/${directory.fd}/runtime-control.sock`,
      host, assertHostOwnership, reportFailure)
    let closing: Promise<void> | undefined
    return { draining: control.draining, close() {
      if (closing) return closing
      closing = control.close().then(() => directory.close()).catch(error => {
        closing = undefined
        throw error
      })
      return closing
    } }
  } catch (error) {
    await directory.close()
    throw error
  }
}

async function listenRuntimeControl(root: string, socketPath: string, host: RuntimeDrainHost,
  assertHostOwnership: () => Promise<void>, reportFailure: (error: unknown) => void) {
  let record: DrainRecord | undefined
  try { record = JSON.parse(await readFile(join(root, 'runtime-drain.json'), 'utf8')) as DrainRecord } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (record?.state === 'draining') host.stopAdmission()
  try {
    const info = await lstat(socketPath)
    if (!info.isSocket() || process.getuid && info.uid !== process.getuid()) throw new DomainError('BROWSER_RUNTIME_OWNER', 'The runtime control socket is not owned by this host.', 503)
    const active = await new Promise<boolean>((resolve, reject) => {
      const connection = createConnection(socketPath)
      connection.once('connect', () => { connection.destroy(); resolve(true) })
      connection.once('error', error => {
        if (['ECONNREFUSED', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) resolve(false); else reject(error)
      })
      connection.setTimeout(5000, () => { connection.destroy(); reject(new Error('Existing browser host did not respond')) })
    })
    if (active) throw new DomainError('BROWSER_RUNTIME_OWNER', 'Another browser runtime host is active.', 409)
    await rm(socketPath)
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  let tail = Promise.resolve<unknown>(undefined)
  const handle = async (input: unknown) => {
    await assertHostOwnership()
    if (!input || typeof input !== 'object' || !('commandId' in input) || typeof input.commandId !== 'string'
      || !input.commandId || input.commandId.length > 200 || !('operation' in input)
      || !['beginDrain', 'status', 'cancelDrain'].includes(String(input.operation))) {
      throw new DomainError('BROWSER_DRAIN_INPUT', 'Invalid browser drain command.', 400)
    }
    const commandId = input.commandId
    if (record?.state === 'draining' && record.commandId !== commandId) return { state: 'waiting', activeSessions: host.activeSessionCount(), reason: 'Another runtime update owns this drain.' }
    if (input.operation === 'cancelDrain') {
      if (record?.commandId === commandId) {
        record = { commandId, state: 'canceled' }; await atomicBrowserPrivateJson(root, 'runtime-drain.json', record)
        host.resumeAdmission()
      }
      return { state: 'canceled' }
    }
    if (input.operation === 'beginDrain' && (record?.commandId !== commandId || record.state !== 'draining')) {
      host.stopAdmission()
      record = { commandId, state: 'draining' }
      try { await atomicBrowserPrivateJson(root, 'runtime-drain.json', record) } catch (error) { host.resumeAdmission(); throw error }
    }
    if (record?.commandId !== commandId || record.state !== 'draining') return { state: 'canceled' }
    const activeSessions = host.activeSessionCount()
    if (activeSessions) return { state: 'waiting', activeSessions, reason: 'Waiting for browser setup, conversation and user sessions to finish.' }
    await host.closeIdleProfiles()
    return { state: 'drained', activeSessions: 0 }
  }
  const connections = new Set<Socket>()
  const server = createServer(socket => {
    connections.add(socket); socket.once('close', () => connections.delete(socket)); socket.on('error', reportFailure)
    socket.setTimeout(5000, () => socket.destroy())
    let bytes = Buffer.alloc(0), done = false
    socket.on('data', chunk => {
      if (done) return
      if (bytes.length + chunk.length > 16_384) { done = true; socket.destroy(); return }
      bytes = Buffer.concat([bytes, Buffer.from(chunk)])
      const newline = bytes.indexOf(10)
      if (newline < 0) return
      done = true
      let input: unknown
      try { input = JSON.parse(bytes.subarray(0, newline).toString('utf8')) } catch { socket.end('{"error":"Invalid drain request"}\n'); return }
      const task = tail.then(() => handle(input), () => handle(input)); tail = task
      void task.then(value => socket.end(`${JSON.stringify(value)}\n`), error => {
        reportFailure(error); socket.end('{"error":"Browser drain could not be confirmed"}\n')
      })
    })
  })
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => { server.removeListener('error', reject); resolve() }) })
    await chmod(socketPath, 0o600)
  } catch (error) {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    throw error
  }
  let stopping: Promise<void> | undefined
  return {
    draining: () => record?.state === 'draining',
    close(): Promise<void> {
      if (stopping) return stopping
      const task = (async () => {
        for (const connection of connections) connection.destroy()
        if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
        await tail.catch(reportFailure)
        await rm(socketPath, { force: true })
        // The durable drain remains across release cutover until its exact installer resumes admission.
      })().finally(() => { if (stopping === task) stopping = undefined })
      stopping = task; return task
    },
  }
}
