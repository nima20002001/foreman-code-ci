import { timeRuntimeOperation } from '../diagnostics/runtimeTiming.js'
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Readable } from 'node:stream'
import { nativeOutputCollector } from './nativeCommandOutput.js'
import { NativeProcessRegistry, nativeProcessExit, spawnNativeProcess, prepareNativeProcessRecovery, stopRecoveredChild, type NativeProcessRecovery } from './recovery/processRegistry.js'

import type { ChildProcessEnvironment, NativeEventInput } from './port.js'
import { appMcpTokenEnvironment, inheritedAgentEnvironment, redactKnownSecrets, redactSecretText } from './secrets.js'
import { APP_MCP_TOKEN_NAMES } from '@foreman-code/contracts/product'
import { ignoreError, logIgnoredError } from '../diagnostics/ignoredError.js'

const MAX_STDERR_LENGTH = 1_000_000
export const PROCESS_SHUTDOWN_GRACE_MS = 1_000
export const NATIVE_COMMAND_TIMEOUT_MS = 30_000
const ownedProcesses = new WeakMap<ChildProcess, () => Promise<void>>()

function readableDrained(stream: Readable): Promise<void> {
  if (stream.readableEnded) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      stream.removeListener('end', ended)
      stream.removeListener('close', closed)
      stream.removeListener('error', failed)
      if (error) reject(error)
      else resolve()
    }
    const ended = () => finish()
    const closed = () => finish(stream.readableEnded ? undefined : new Error('Native diagnostics closed before readable drainage.'))
    const failed = (error: Error) => finish(error)
    stream.once('end', ended)
    stream.once('close', closed)
    stream.once('error', failed)
    if (stream.destroyed) closed()
  })
}

export interface JsonlProcessOptions {
  binary: string
  args: string[]
  cwd: string
  signal: AbortSignal
  stdin?: string
  onSpawn(process: ChildProcess): void
  expectedAgentId?: string
  beforeSpawn?(): Promise<ChildProcessEnvironment | void>
  onEvent(event: NativeEventInput): Promise<void>
}

export interface JsonlProcessResult {
  exitCode: number | null
  exitSignal: NodeJS.Signals | null
  stderr: string
}

type ScopedCommandEnvironment = Pick<JsonlProcessOptions, 'beforeSpawn' | 'expectedAgentId'>

type ProcessOptions = Pick<JsonlProcessOptions, 'binary' | 'args' | 'cwd' | 'stdin' | 'beforeSpawn' | 'expectedAgentId'> & {
  signal?: AbortSignal
  onSpawn?(process: ChildProcess): void
  environment?: NodeJS.ProcessEnv
  recovery?: NativeProcessRecovery
}
type ProcessExit = Pick<JsonlProcessResult, 'exitCode' | 'exitSignal'>

export async function signalTree(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  if (await stopRecoveredChild(child)) return
  if (!child.pid) return
  if (process.platform === 'win32') {
    // Windows has no POSIX process groups. Kill the tree, not just its root.
    await new Promise<void>((resolve, reject) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      killer.once('error', reject)
      killer.once('close', (code) => {
        if (code === 0 || code === 128) resolve() // 128: the process already exited.
        else reject(new Error(`taskkill failed with exit code ${String(code)}.`))
      })
    })
    return
  }
  try {
    // A detached POSIX child leads a new group. Its descendants inherit that group.
    // The group can outlive the direct child, so never gate this on child.exitCode.
    process.kill(-child.pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

/** Cancel through the same lifecycle used for aborts and reader failures. */
export async function stopProcess(child: ChildProcess): Promise<boolean> {
  const stop = ownedProcesses.get(child)
  if (!stop) return false
  await stop()
  return true
}

async function abandonFailedStart(recovery: NativeProcessRecovery | undefined, error: unknown): Promise<void> {
  if (!recovery) return
  try { await new NativeProcessRegistry(recovery.root).abandonReservedLaunch(recovery) }
  catch (cleanupError) {
    throw new AggregateError([error, cleanupError], 'Native startup and reservation cleanup failed.', { cause: cleanupError })
  }
}

async function runOwnedProcess<T>(
  options: ProcessOptions,
  read: (child: ChildProcessWithoutNullStreams, secrets: readonly string[]) => Promise<T>,
): Promise<T & ProcessExit> {
  options.signal?.throwIfAborted()
  const recovery = options.recovery ? await prepareNativeProcessRecovery(options.recovery) : undefined
  const secrets: string[] = []
  let child: ChildProcessWithoutNullStreams
  try {
    const childEnvironment = inheritedAgentEnvironment(options.environment)
    // Finish retirement before the final launch check; dispatch and listener installation stay synchronous.
    const scopedEnvironment = options.beforeSpawn ? await options.beforeSpawn() : undefined
    if (scopedEnvironment) {
      if (!options.expectedAgentId || scopedEnvironment.agentId !== options.expectedAgentId) {
        throw new Error('Child process environment belongs to another Agent.')
      }
      const entries = Object.entries(scopedEnvironment.variables)
      const entry = entries[0]
      if (entries.length !== 1 || !entry || !(APP_MCP_TOKEN_NAMES as readonly string[]).includes(entry[0]) || !entry[1]) {
        throw new Error('Only the scoped Foreman Code MCP credential may be injected into an Agent process.')
      }
      childEnvironment[entry[0]] = entry[1]
      secrets.push(entry[1])
    }
    options.signal?.throwIfAborted()
    child = spawnNativeProcess(options.binary, options.args, {
      cwd: options.cwd, env: appMcpTokenEnvironment(childEnvironment, options.environment ?? process.env), purpose: 'command',
      ...(recovery ? { recovery } : {}),
    })
  } catch (error) {
    await abandonFailedStart(recovery, error)
    throw error
  }
  const closed = new Promise<ProcessExit>((resolve) => {
    child.once('close', (exitCode, exitSignal) => resolve({ exitCode, exitSignal }))
  })
  const processError = new Promise<never>((_resolve, reject) => {
    child.on('error', reject)
  })
  // Observe errors immediately, including errors before any reader is started.
  void processError.catch(() => { /* ignore: the owner awaits the original promise; this observer prevents a duplicate unhandled rejection. */ })

  let shutdown: Promise<void> | undefined
  const stop = (): Promise<void> => {
    if (!shutdown) {
      shutdown = (async () => {
        if (options.recovery) {
          // Never release a registered writer through PID/group-only cleanup.
          // Pipe disposal also lets canceled readers finish when recovery remains uncertain.
          try {
            if (!await stopRecoveredChild(child)) throw new Error('Native command recovery ownership is missing.')
            await closed // Drain normal acknowledgement output before releasing ownership.
            ownedProcesses.delete(child)
            options.signal?.removeEventListener('abort', abort)
          } catch (error) {
            child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy()
            throw error
          }
          return
        }
        let killError: unknown
        const send = async (signal: NodeJS.Signals) => {
          try { await signalTree(child, signal) } catch (error) { killError ??= error }
        }
        await send('SIGTERM')
        const timer = setTimeout(() => { void send('SIGKILL') }, PROCESS_SHUTDOWN_GRACE_MS)
        // Keep the timer and cancellation ownership until close confirms pipe cleanup.
        try {
          await closed
          // Also clean up descendants that closed stdio before the parent exited.
          await send('SIGKILL')
        } finally {
          clearTimeout(timer)
        }
        if (killError) throw killError
        // A later explicit Stop may complete cleanup after the command rejected.
        ownedProcesses.delete(child)
        options.signal?.removeEventListener('abort', abort)
      })()
      const attempt = shutdown
      void attempt.catch(() => { if (shutdown === attempt) shutdown = undefined })
    }
    return shutdown
  }
  const abort = () => { void stop().catch(ignoreError('harness', 'stop native process', { pid: child.pid, agentId: options.expectedAgentId })) }
  ownedProcesses.set(child, stop)
  options.signal?.addEventListener('abort', abort, { once: true })
  // A root that exits normally must not leave descendants holding our pipes open.
  child.once('exit', abort)
  child.once('error', abort)

  const readers = Promise.resolve().then(() => read(child, secrets))
  const input = new Promise<void>((resolve, reject) => {
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      // Early CLI exits (including qualification failures) can close stdin.
      if (error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED') resolve()
      else reject(error)
    })
    child.stdin.end(options.stdin ?? '', (error?: Error | null) => {
      if (!error || (error as NodeJS.ErrnoException).code === 'EPIPE' || (error as NodeJS.ErrnoException).code === 'ERR_STREAM_DESTROYED') resolve()
      else reject(error)
    })
  })
  // Attach handlers to every concurrent task in the same turn that creates it.
  const tasks = Promise.all([readers, input, closed])
  const result = Promise.race([tasks, processError])
  void result.catch(() => { /* ignore: the owner awaits the original promise; this observer prevents a duplicate unhandled rejection. */ })
  try {
    options.onSpawn?.(child)
    if (options.signal?.aborted) abort()
    const [output, , exit] = await result
    return { ...output, ...nativeProcessExit(child, exit) }
  } catch (error) {
    await stop()
    await Promise.allSettled([readers, input, closed])
    throw error
  } finally {
    await stop()
    options.signal?.removeEventListener('abort', abort)
    ownedProcesses.delete(child)
  }
}

async function settleReaders<T>(child: ChildProcess, tasks: Promise<T>[]): Promise<T[]> {
  try {
    return await Promise.all(tasks)
  } catch (error) {
    await stopProcess(child)
    await Promise.allSettled(tasks)
    throw error
  }
}

async function readLines(stream: Readable, onLine: (line: string) => Promise<void>): Promise<void> {
  stream.setEncoding('utf8')
  let pending = ''
  for await (const chunk of stream) {
    pending += String(chunk)
    let newline: number
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline).replace(/\r$/, '')
      pending = pending.slice(newline + 1)
      await onLine(line)
    }
  }
  if (pending) await onLine(pending.replace(/\r$/, ''))
}

function asEvent(line: string): NativeEventInput {
  try {
    const parsed: unknown = JSON.parse(line)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const payload = parsed as Record<string, unknown>
      return { type: typeof payload.type === 'string' ? payload.type : 'native_event', payload }
    }
  } catch { /* ignore: malformed or non-JSON stdout is preserved below as a native event instead of being dropped */ }
  return { type: 'unparsed_stdout', payload: { text: line } }
}

export async function runJsonlProcess(options: JsonlProcessOptions): Promise<JsonlProcessResult> {
  return runOwnedProcess(options, async (child, secrets) => {
    let eventChain = Promise.resolve()
    const emit = (event: NativeEventInput) => {
      const safe = redactKnownSecrets(event, secrets)
      eventChain = eventChain.then(() => options.onEvent(safe))
      return eventChain
    }
    let stderr = ''
    await settleReaders(child, [
      readLines(child.stdout, async (line) => { if (line.trim()) await emit(asEvent(line)) }),
      readLines(child.stderr, async (line) => {
        const safe = redactSecretText(line, secrets)
        stderr = (stderr + `${safe}\n`).slice(0, MAX_STDERR_LENGTH)
        await emit({ type: 'stderr', payload: { text: safe } })
      }),
    ])
    return { stderr }
  })
}

export interface NativeCommandOptions {
  maxOutputBytes?: number
  recovery?: NativeProcessRecovery
}

/** Model-free native commands. Mutations must supply durable recovery ownership. */
export async function runCommand(
  binary: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  environmentOrScope?: NodeJS.ProcessEnv | ScopedCommandEnvironment,
  options: NativeCommandOptions = {},
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const scoped = environmentOrScope && ('beforeSpawn' in environmentOrScope || 'expectedAgentId' in environmentOrScope)
    ? environmentOrScope as ScopedCommandEnvironment
    : undefined
  const environment = environmentOrScope && !scoped ? environmentOrScope as NodeJS.ProcessEnv : undefined
  const deadline = AbortSignal.timeout(NATIVE_COMMAND_TIMEOUT_MS)
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline
  const limit = options.maxOutputBytes ?? 8_000_000
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32_000_000) throw new Error('Invalid native command output limit.')
  let operation = 'other'
  if (args[0] === '--version') operation = 'version'
  else if (args[0] === 'login') operation = 'authentication'
  else if (args[1] === 'generate-json-schema') operation = 'schema'
  else if (args[0] === 'debug') operation = 'models'
  else if (args[0] === 'mcp' && args[1] === 'get') operation = 'mcp_get'
  else if (args[0] === 'mcp' && args[1] === 'list') operation = 'mcp_list'
  const result = await timeRuntimeOperation('harness', 'process.command', () =>
    runOwnedProcess({ binary, args, cwd, signal: combined, ...scoped,
    ...(options.recovery ? { recovery: options.recovery } : {}), ...(environment ? { environment } : {}) }, async (child, secrets) => {
    const collect = nativeOutputCollector(limit, (text) => redactSecretText(text, secrets))
    const [stdout = '', stderr = ''] = await settleReaders(child, [collect(child.stdout), collect(child.stderr)])
    return { stdout, stderr }
  }), { operation, ...(options.recovery ? { ownerId: options.recovery.owner } : {}) })
  combined.throwIfAborted()
  return result
}

/** Qualification commands share cancellation and are all drained on failure. */
export async function runCommands(binary: string, commands: string[][], cwd: string, signal?: AbortSignal): Promise<Awaited<ReturnType<typeof runCommand>>[]> {
  const failure = new AbortController()
  const combined = signal ? AbortSignal.any([signal, failure.signal]) : failure.signal
  const tasks = commands.map((args) => runCommand(binary, args, cwd, combined))
  try {
    return await Promise.all(tasks)
  } catch (error) {
    failure.abort(error)
    await Promise.allSettled(tasks)
    throw error
  }
}

/** Bidirectional providers use the same tree ownership as one-shot harnesses. */
export async function spawnOwnedStdioProcess(options: {
  binary: string
  args: string[]
  cwd: string
  environment: NodeJS.ProcessEnv
  recovery?: NativeProcessRecovery
  reconnectableStdio?: true
  onError(error: Error): void
  signal?: AbortSignal
  beforeSpawn?(): void
  /** Metadata inspectors need actual readable EOF, not pipe destruction, to classify late diagnostics. */
  preserveReadableDrain?: boolean
}): Promise<{
  child: ChildProcessWithoutNullStreams
  closed: Promise<ProcessExit>
  close(): Promise<void>
}> {
  const recovery = options.recovery ? await prepareNativeProcessRecovery(options.recovery) : undefined
  let child: ChildProcessWithoutNullStreams
  try {
    options.signal?.throwIfAborted()
    options.beforeSpawn?.()
    child = spawnNativeProcess(options.binary, options.args, {
      cwd: options.cwd, env: options.environment,
      purpose: options.preserveReadableDrain ? 'inspection' : 'session',
      ...(options.reconnectableStdio ? { restartDetachable: true, reconnectableStdio: true } : {}),
      ...(recovery ? { recovery } : {}),
    })
  } catch (error) {
    await abandonFailedStart(recovery, error)
    throw error
  }
  let didClose = false
  const closed = new Promise<ProcessExit>((resolve, reject) => {
    child.once('close', (exitCode, exitSignal) => {
      didClose = true
      try { resolve(nativeProcessExit(child, { exitCode, exitSignal })) } catch (error) { reject(error) }
    })
  })
  let shutdown: Promise<void> | undefined
  const within = async (operation: Promise<unknown>, milliseconds: number): Promise<boolean> => {
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        operation.then(() => true),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), milliseconds) }),
      ])
    } finally { clearTimeout(timer) }
  }
  const close = (): Promise<void> => {
    if (shutdown) return shutdown
    shutdown = (async () => {
      let failure: unknown
      const send = async (signal: NodeJS.Signals) => {
        try {
          if (!await within(signalTree(child, signal), PROCESS_SHUTDOWN_GRACE_MS)) {
            failure ??= new Error('Timed out signaling the owned provider process tree.')
          }
        } catch (error) { failure ??= error }
      }
      let confirmed = false
      const drain = async () => {
        if (options.preserveReadableDrain && !await within(Promise.all([
          readableDrained(child.stdout), readableDrained(child.stderr),
        ]), PROCESS_SHUTDOWN_GRACE_MS)) throw new Error('Native diagnostics did not drain before cleanup.')
      }
      try {
        // Registry shutdown includes its own grace period and verifies the launch boundary.
        // Do not wrap it in the shorter per-signal timeout used for legacy children.
        if (await stopRecoveredChild(child)) {
          await drain()
          confirmed = true
          return
        }
        // Signal the group even after its leader exited: descendants may own pipes.
        await send('SIGTERM')
        if (!didClose) await within(closed, PROCESS_SHUTDOWN_GRACE_MS)
        await send('SIGKILL')
        if (!didClose && !await within(closed, PROCESS_SHUTDOWN_GRACE_MS)) {
          failure ??= new Error('Provider process did not close after forced tree shutdown.')
        }
        if (failure) throw failure
        await drain()
        confirmed = true
      } finally {
        child.stdin.destroy()
        child.stdout.destroy()
        child.stderr.destroy()
        // Closing pipes is not proof that the native launch boundary is empty.
        // Keep the same child available to Stop after an unconfirmed attempt.
        if (confirmed) ownedProcesses.delete(child)
      }
    })()
    // Coalesce in-flight attempts and cache success, but permit explicit retries.
    const attempt = shutdown
    void attempt.catch(() => { if (shutdown === attempt) shutdown = undefined })
    return shutdown
  }
  ownedProcesses.set(child, close)
  const failed = (error: Error) => {
    try { options.onError(error) } catch (observerError) { logIgnoredError('harness', 'publish native process lifecycle', observerError) }
    finally { void close().catch(ignoreError('harness', 'close native process', { pid: child.pid })) }
  }
  child.on('error', failed)
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on('error', failed)
  child.once('exit', () => { void close().catch(ignoreError('harness', 'close native process', { pid: child.pid })) })
  return { child, closed, close }
}
