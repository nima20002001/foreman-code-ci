import { spawn, type ChildProcess } from 'node:child_process'

interface Lifetime {
  sessionId: string
  child: ChildProcess
  spawned: boolean
  closed: boolean
  exited: Promise<boolean>
}

/** Test-only physical closure port. Each deterministic provider session owns one
 * real inert child, registered before createSession returns. Only that captured
 * child's exit/close event proves disposal; no PID lookup, empty map, new facade,
 * native result, database write or always-true callback is used as evidence.
 * This models the registry PORT, not the production guardian/cgroup machinery. */
export class FixtureProcessClosures {
  private readonly lifetimes = new Map<string, Lifetime>()
  readonly recoveredExecutions: string[] = []
  readonly startedExecutions: string[] = []

  async start(executionId: string, sessionId: string): Promise<void> {
    if (this.lifetimes.has(executionId)
      || [...this.lifetimes.values()].some((item) => item.sessionId === sessionId && !item.closed)) {
      throw new Error('A fixture process identity cannot be reused')
    }
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' })
    let finish!: (value: boolean) => void
    const exited = new Promise<boolean>((resolve) => { finish = resolve })
    const lifetime: Lifetime = { sessionId, child, spawned: false, closed: false, exited }
    this.lifetimes.set(executionId, lifetime)
    child.once('close', (code, signal) => {
      lifetime.closed = lifetime.spawned && (code !== null || signal !== null)
      finish(lifetime.closed)
    })
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('spawn', () => { lifetime.spawned = true; this.startedExecutions.push(executionId); resolve() })
    })
  }

  isClosed(executionId: string): boolean { return this.lifetimes.get(executionId)?.closed === true }

  private async closeExecution(executionId: string, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted()
    const lifetime = this.lifetimes.get(executionId)
    if (!lifetime?.spawned) return false
    // A retained ChildProcess handle, not a potentially reused numeric PID.
    if (!lifetime.closed && !lifetime.child.killed) lifetime.child.kill('SIGTERM')
    let onAbort: (() => void) | undefined
    try {
      const closed = await Promise.race([lifetime.exited, new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason)
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
      })])
      signal.throwIfAborted()
      return closed
    } finally { if (onAbort) signal.removeEventListener('abort', onAbort) }
  }

  async closeSession(sessionId: string): Promise<void> {
    const registered = [...this.lifetimes].reverse().find(([, item]) => item.sessionId === sessionId)
    if (!registered || !await this.closeExecution(registered[0], AbortSignal.timeout(5000))) {
      throw new Error('The original fixture session has no positive process closure')
    }
  }

  async recover(executionId: string, signal: AbortSignal): Promise<boolean> {
    const closed = await this.closeExecution(executionId, signal)
    if (closed) this.recoveredExecutions.push(executionId)
    return closed
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled([...this.lifetimes.keys()].map((id) =>
      this.closeExecution(id, AbortSignal.timeout(5000))))
    const errors = results.flatMap((item) => item.status === 'rejected' ? [item.reason] : [])
    if (errors.length) throw new AggregateError(errors, 'Task-owned fixture processes did not close')
  }
}
