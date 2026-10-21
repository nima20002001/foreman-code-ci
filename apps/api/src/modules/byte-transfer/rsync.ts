import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BYTE_TRANSFER_POLICY as POLICY, TransferContextSchema, TransferIntentSchema,
  type TransferContext, type TransferIntent } from '@foreman-code/contracts/byte-transfer'
import { nativeProcessExit } from '../harnesses/recovery/processRegistry.js'
import type { RsyncProcessLaunch, RsyncRemoteWriter } from './rsyncWriterOwnership.js'
import type { TransferAuthorization, TransferOperation } from './service.js'
import { componentLogger } from '../diagnostics/logger.js'
import { logIgnoredError } from '../diagnostics/ignoredError.js'

const log = componentLogger('byte-transfer')

export const RSYNC_SSH_ARGS = Object.freeze(['-F', '/dev/null', '-o', 'BatchMode=yes', '-o',
  'StrictHostKeyChecking=yes', '-o', 'ForwardAgent=no', '-o', 'ConnectTimeout=5'])
export interface RsyncEndpoint {
  /** Setup-owned, trusted configuration; never accepted from a transfer request. */
  user: string; host: string; localBinary: string; remoteBinary: string
  localRoot: string; remoteRoot: string
  localBinarySha256: string; remoteBinarySha256: string
}
export interface RsyncCommand { executable: string; args: string[]; owner?: RsyncProcessLaunch }
export interface RsyncExecutor {
  run(command: RsyncCommand, signal: AbortSignal): Promise<string>
}
export interface RsyncSnapshot {
  /** Provider freezes and reserves an exact accepted source; path is derived by the transport. */
  verify(signal: AbortSignal): Promise<void>
  close(): Promise<void>
}
export interface RsyncStagedBytes {
  intent: TransferIntent; sha256: string; byteSize: number
  /** This is byte staging only. Canonical upload/publication must independently authorize and finalize. */
  read(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array>
  close(): Promise<void>
}
export interface RsyncReceiverLease {
  /** Receiver must hash and fsync the exact private part, retaining quota until close/publication. */
  verify(signal: AbortSignal): Promise<RsyncStagedBytes>
  /** Release writer lock, keep a bounded partial under original immutable identity/expiry. */
  interrupt(): Promise<void>
}
export interface RsyncTransferWriters {
  /** Protected full W07 binding and binary pin captured BEFORE local executable dispatch. */
  local(intent: TransferIntent, command: RsyncCommand, signal: AbortSignal): Promise<RsyncProcessLaunch>
  /** Existing W07 prepare response identifies the actual one-use remote server reservation.
   * Node/entrypoint are protected installed selection, never RPC-controlled paths. */
  remote(intent: TransferIntent, signal: AbortSignal): Promise<RsyncRemoteWriter>
  /** Existing W07 control admits the actual waiting wrapper while the local client runs. */
  activate(intent: TransferIntent, remote: RsyncRemoteWriter, signal: AbortSignal): Promise<void>
  /** Both actual process trees, independently. A local child close does not prove remote closure. */
  quiescent(intent: TransferIntent, signal: AbortSignal): Promise<void>
  stop(intent: TransferIntent, signal: AbortSignal): Promise<void>
}
export interface RsyncStagingPorts {
  writers?: RsyncTransferWriters
  source(intent: TransferIntent, path: string, signal: AbortSignal): Promise<RsyncSnapshot>
  /** Same authority/quota supervisor as fallback. Must reserve before transfer, reject competing writers,
   * journal immutable intent, enforce private root/no symlinks and cap partial retention by expiry.
   * Remote implementation uses existing authenticated app control RPC, never caller shell commands. */
  receiver(intent: TransferIntent, path: string, signal: AbortSignal): Promise<RsyncReceiverLease>
}
const safePath = (value: string) => {
  if (!/^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(value)
    || value.split('/').some(x => x === '.' || x === '..')) throw new Error('Unsafe rsync path')
  return value
}
const hash = (value: string) => { if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid binary digest'); return value }
export function validateRsyncEndpoint(input: RsyncEndpoint): RsyncEndpoint {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(input.user)
    || !/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(input.host) || input.host.includes('..')) throw new Error('Unsafe SSH endpoint')
  for (const path of [input.localBinary, input.remoteBinary, input.localRoot, input.remoteRoot]) safePath(path)
  hash(input.localBinarySha256); hash(input.remoteBinarySha256)
  if (input.localRoot === '/' || input.remoteRoot === '/') throw new Error('Private staging root required')
  return Object.freeze({ ...input })
}
export function rsyncCommand(endpoint: RsyncEndpoint, intent: TransferIntent, remote?: RsyncRemoteWriter): RsyncCommand {
  endpoint = validateRsyncEndpoint(endpoint); intent = TransferIntentSchema.parse(intent)
  const toWorker = intent.direction === 'to-worker'
  const source = join(toWorker ? endpoint.localRoot : endpoint.remoteRoot, `${intent.transferId}.snapshot`)
  const destination = join(toWorker ? endpoint.remoteRoot : endpoint.localRoot, `${intent.transferId}.part`)
  const peer = `${endpoint.user}@${endpoint.host}:`
  const remoteCommand = remote ? (() => {
    safePath(remote.nodeBinary); safePath(remote.entryPoint); hash(remote.ownerDigest)
    if (remote.transferId !== intent.transferId || !/^[a-f0-9-]{36}$/.test(remote.ownerId)) throw new Error('Invalid remote rsync owner')
    const scope = '/usr/bin/systemd-run --user --scope --quiet --property=Delegate=yes --collect --'
    return [scope, remote.nodeBinary, remote.entryPoint,
      '--rsync-root', endpoint.remoteRoot, '--rsync-transfer', intent.transferId,
      '--rsync-owner', remote.ownerId, '--rsync-owner-digest', remote.ownerDigest].join(' ')
  })() : endpoint.remoteBinary
  return { executable: endpoint.localBinary, args: ['--protect-args', '--checksum', '--partial',
    '--partial-dir=.rsync-partial', '--no-whole-file', '--no-links', '--no-devices', '--no-specials',
    '--timeout=30', `--max-size=${intent.byteSize}`, '--chmod=F600', `--rsync-path=${remoteCommand}`,
    '-e', ['/usr/bin/ssh', ...RSYNC_SSH_ARGS].join(' '), '--',
    toWorker ? source : peer + source, toWorker ? peer + destination : destination] }
}
/** No shell, provider env or new scheduler. Only this process group is stopped. */
export class NodeRsyncExecutor implements RsyncExecutor {
  async run(command: RsyncCommand, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    if (!command.owner && (command.args.includes('--partial') || command.args[0] === '--server')) throw new Error('Rsync byte subprocess owner unavailable')
    const child = command.owner
      ? await command.owner.ownership.spawnProcess(command.owner, command.executable, command.args, signal)
      : spawn(command.executable, command.args, { shell: false, detached: true,
        stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'C' } })
    return new Promise((resolve, reject) => {
      let output = '', overflow = false, killTimer: ReturnType<typeof setTimeout> | undefined
      let ownershipError: unknown
      const stop = () => {
        if (command.owner) {
          void command.owner.ownership.completeProcess(command.owner, AbortSignal.timeout(5000)).catch(error => { ownershipError = error })
          return
        }
        if (!child.pid) return
        try {
          process.kill(-child.pid, 'SIGTERM')
        } catch (error) {
          logIgnoredError('byte-transfer', 'terminate rsync process group', error, { pid: child.pid }, ['ESRCH'])
        }
        killTimer ??= setTimeout(() => {
          try {
            process.kill(-child.pid!, 'SIGKILL')
          } catch (error) {
            logIgnoredError('byte-transfer', 'kill rsync process group', error, { pid: child.pid }, ['ESRCH'])
          }
        }, 1000)
      }
      const collect = (chunk: Buffer) => {
        if (Buffer.byteLength(output) + chunk.length > 16384) { overflow = true; stop() }
        else output += chunk.toString('utf8')
      }
      child.stdout.on('data', collect); child.stderr.on('data', collect)
      signal.addEventListener('abort', stop, { once: true })
      if (signal.aborted) stop()
      const cleanup = () => { clearTimeout(killTimer); signal.removeEventListener('abort', stop) }
      child.once('error', error => { cleanup(); reject(error) })
      child.once('close', (code, exitSignal) => {
        void (async () => {
          cleanup()
          if (command.owner) {
            const outcome = nativeProcessExit(child, { exitCode: code, exitSignal })
            await command.owner.ownership.completeProcess(command.owner, AbortSignal.timeout(5000))
            code = outcome.exitCode
          }
          if (ownershipError) throw ownershipError
          if (signal.aborted) reject(signal.reason ?? new Error('Rsync interrupted'))
          else if (overflow) reject(new Error('Rsync diagnostic limit exceeded'))
          else if (code !== 0) {
            const diagnostic = output.trim().slice(-4096)
            const error = new Error(`Rsync command failed (${code})`, { cause: new Error(diagnostic) })
            log.error({ err: error, exitCode: code }, 'rsync command failed')
            reject(error)
          }
          else resolve(output)
        })().catch(reject)
      })
    })
  }
}
/** Fail closed until both installed binaries have current upstream security fixes and match setup pins.
 * Distro backports require a separate complete advisory audit; version suffix alone proves nothing. */
export async function verifyRsyncBinaries(endpoint: RsyncEndpoint, executor: RsyncExecutor, signal: AbortSignal) {
  endpoint = validateRsyncEndpoint(endpoint)
  const target = `${endpoint.user}@${endpoint.host}`
  const local = await executor.run({ executable: endpoint.localBinary, args: ['--version'] }, signal)
  const remote = await executor.run({ executable: '/usr/bin/ssh', args: [...RSYNC_SSH_ARGS, target,
    `${endpoint.remoteBinary} --version && /usr/bin/sha256sum -- ${endpoint.remoteBinary}`] }, signal)
  for (const output of [local, remote]) {
    const version = output.match(/^rsync\s+version\s+(\d+)\.(\d+)\.(\d+)/m)
    if (!version || Number(version[1]) < 3 || (Number(version[1]) === 3 && Number(version[2]) < 5)) {
      throw new Error('Rsync security qualification requires upstream 3.5.0 or newer')
    }
  }
  if (createHash('sha256').update(await readFile(endpoint.localBinary)).digest('hex') !== endpoint.localBinarySha256
    || !remote.includes(`${endpoint.remoteBinarySha256}  ${endpoint.remoteBinary}\n`)) throw new Error('Rsync binary changed')
  return { local, remote }
}

/** Explicitly selected alternative transport. Never installs itself into fallback or creates publication receipts. */
export class RsyncStagingTransport {
  private readonly endpoint: RsyncEndpoint
  constructor(endpoint: RsyncEndpoint, private readonly authority: TransferAuthorization,
    private readonly ports: RsyncStagingPorts, private readonly executor: RsyncExecutor = new NodeRsyncExecutor()) {
    this.endpoint = validateRsyncEndpoint(endpoint)
  }
  async stage(input: TransferIntent, current: () => Promise<TransferContext>, signal?: AbortSignal): Promise<RsyncStagedBytes> {
    const intent = TransferIntentSchema.parse(input), controller = new AbortController()
    const expires = Date.parse(intent.expiresAt)
    if (expires <= Date.now() || expires - Date.now() > POLICY.maxLifetimeMs) throw new Error('Transfer expiry exceeds policy')
    const wait = async <T>(action: Promise<T>): Promise<T> => {
      controller.signal.throwIfAborted()
      let listener = () => {}
      const aborted = new Promise<never>((_, reject) => {
        listener = () => reject(controller.signal.reason ?? new Error('Transfer interrupted'))
        controller.signal.addEventListener('abort', listener, { once: true })
        if (controller.signal.aborted) listener()
      })
      try { return await Promise.race([action, aborted]) }
      finally { controller.signal.removeEventListener('abort', listener) }
    }
    const check = async (operation: TransferOperation = 'status') => {
      controller.signal.throwIfAborted()
      const context = TransferContextSchema.parse(await wait(current()))
      for (const key of ['mainId', 'deviceId', 'workerInstallationId', 'keyRevision', 'authorizationRevision'] as const) {
        if (context[key] !== intent[key]) throw new Error('Transfer principal changed')
      }
      await wait(this.authority.authorize(intent, context, operation))
      if (Date.now() >= expires) throw new Error('Transfer expired')
      controller.signal.throwIfAborted()
    }
    const abort = () => controller.abort(signal?.reason ?? new Error('Transfer cancelled'))
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort()
    const deadline = setTimeout(() => controller.abort(new Error('Transfer deadline exceeded')), Math.min(POLICY.maxIdleMs, expires - Date.now()))
    // Recheck authorization while bytes move. Never overlap slow authority calls.
    let checking = false
    const poll = setInterval(() => {
      if (checking || controller.signal.aborted) return
      checking = true
      void check().catch(error => controller.abort(error)).finally(() => { checking = false })
    }, 1000)
    let snapshot: RsyncSnapshot | undefined, lease: RsyncReceiverLease | undefined, writerPrepared = false, completed = false
    try {
      await check('start'); await verifyRsyncBinaries(this.endpoint, this.executor, controller.signal); await check('start')
      const writers = this.ports.writers
      if (!writers) throw new Error('Rsync causal writer ports unavailable')
      const toWorker = intent.direction === 'to-worker'
      snapshot = await this.ports.source(intent, join(toWorker ? this.endpoint.localRoot : this.endpoint.remoteRoot, `${intent.transferId}.snapshot`), controller.signal)
      await snapshot.verify(controller.signal); await check()
      lease = await this.ports.receiver(intent, join(toWorker ? this.endpoint.remoteRoot : this.endpoint.localRoot, `${intent.transferId}.part`), controller.signal)
      writerPrepared = true
      const remote = await writers.remote(intent, controller.signal)
      const command = rsyncCommand(this.endpoint, intent, remote)
      command.owner = await writers.local(intent, command, controller.signal)
      const admitted = [
        Promise.resolve().then(() => this.executor.run(command, controller.signal)),
        Promise.resolve().then(() => writers.activate(intent, remote, controller.signal)),
      ].map(task => task.catch(error => { controller.abort(error); throw error }))
      await wait(Promise.all(admitted))
      await writers.quiescent(intent, controller.signal)
      await snapshot.verify(controller.signal); await check('finish')
      const staged = await lease.verify(controller.signal)
      try {
        if (JSON.stringify(TransferIntentSchema.parse(staged.intent)) !== JSON.stringify(intent) || staged.sha256 !== intent.sha256 || staged.byteSize !== intent.byteSize) throw new Error('Rsync staging identity or integrity mismatch')
        await check('finish')
      } catch (error) { await staged.close(); throw error }
      lease = undefined; completed = true
      return { ...staged, read: async (offset, length, bounded) => {
        bounded.throwIfAborted()
        const context = TransferContextSchema.parse(await current())
        for (const key of ['mainId', 'deviceId', 'workerInstallationId', 'keyRevision', 'authorizationRevision'] as const) {
          if (context[key] !== intent[key]) throw new Error('Transfer principal changed')
        }
        await this.authority.authorize(intent, context, 'read')
        if (Date.now() >= expires) throw new Error('Transfer expired')
        return staged.read(offset, length, bounded)
      } }
    } catch (error) {
      log.error({ err: error, transferId: intent.transferId }, 'rsync transfer failed')
      throw error
    } finally {
      clearTimeout(deadline); clearInterval(poll); signal?.removeEventListener('abort', abort)
      if (writerPrepared && !completed) {
        const cleanup = AbortSignal.timeout(5000)
        await this.ports.writers!.stop(intent, cleanup)
        await this.ports.writers!.quiescent(intent, cleanup)
      }
      try { await lease?.interrupt() }
      finally { await snapshot?.close() }
    }
  }
}
