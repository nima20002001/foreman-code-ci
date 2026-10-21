import { spawn } from 'node:child_process'
import { underDeadline } from '../processDeadline.js'

export interface GitProcessOptions {
  cwd?: string
  signal: AbortSignal
  /** Enforced by a supervisor that survives the API; 15 minutes by default. */
  timeoutMs?: number
  env?: Record<string, string>
  maximumFileBytes?: number
  lockFd?: number
  transferLockFd?: number
  lifetimeLockFd?: number
}
export interface GitProcessResult {
  code: number
  stdout: string
  stderr: string
  interrupted?: { startedAt: number }
}

/** All Git children share the transfer's file limit, cache lock and deadline, including after an API process exits;
 * the deadline ends the whole process group, so the kernel then releases the inherited locks. */
export function runGitProcess(args: string[], options: GitProcessOptions,
  environment: NodeJS.ProcessEnv): Promise<GitProcessResult> {
  return new Promise(resolve => {
    const command = ['/bin/sh', '-c', 'umask 077 && exec git "$@"', 'git', ...args]
    const limited = options.maximumFileBytes !== undefined
    const executable = limited ? '/usr/bin/prlimit' : command.shift()!
    const childArgs = limited
      ? [`--fsize=${options.maximumFileBytes}:${options.maximumFileBytes}`, '--', ...command] : command
    const [supervisor, supervised] = underDeadline(options.timeoutMs ?? 15 * 60_000, executable, childArgs)
    const startedAt = Date.now()
    const child = spawn(supervisor, supervised, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe',
        ...(options.lockFd !== undefined ? [options.lockFd] : []),
        ...(options.transferLockFd !== undefined ? [options.transferLockFd] : []),
        ...(options.lifetimeLockFd !== undefined ? [options.lifetimeLockFd] : [])],
      env: { ...environment, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never',
        GIT_NO_LAZY_FETCH: '1', ...options.env },
    })
    const output = { stdout: [] as Buffer[], stderr: [] as Buffer[] }
    const sizes = { stdout: 0, stderr: 0 }
    let failed = false
    const stop = () => {
      failed = true
      if (!child.pid) return
      // The supervisor kills the command's whole group on SIGTERM.
      try { process.kill(-child.pid, 'SIGTERM') }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    for (const stream of ['stdout', 'stderr'] as const) {
      child[stream]?.on('data', (chunk: Buffer) => {
        sizes[stream] += chunk.length
        if (sizes[stream] > 4 * 1024 * 1024) stop()
        else output[stream].push(chunk)
      })
    }
    child.once('error', () => { failed = true })
    options.signal.addEventListener('abort', stop, { once: true })
    if (options.signal.aborted) stop()
    child.once('close', code => {
      options.signal.removeEventListener('abort', stop)
      // GNU timeout returns 124 at expiry, or 137 when its kill-after limit is needed.
      const interrupted = child.pid !== undefined && (failed || options.signal.aborted || code === 124 || code === 137)
      resolve({ code: failed || options.signal.aborted ? 1 : code ?? 1,
        ...(interrupted ? { interrupted: { startedAt } } : {}),
        stdout: Buffer.concat(output.stdout).toString('utf8'),
        stderr: Buffer.concat(output.stderr).toString('utf8') })
    })
  })
}
