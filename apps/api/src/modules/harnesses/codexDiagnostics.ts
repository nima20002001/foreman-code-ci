import { DomainError } from '../errors.js'
import type { CodexSessionDependencies, CodexDiagnosticPin, CodexDiagnosticOperations } from './codexAppServer.js'
import { qualifyCodex, assertCodexUnchanged } from './codexProtocol.js'
import { qualifyNativeCodexModel } from './codexQualification.js'
import { runCommand } from './process.js'
import { inheritedAgentEnvironment } from './secrets.js'
import type { NativeProcessRecovery } from './recovery/processRegistry.js'

interface CodexDiagnosticLifetime {
  readonly recovery: NativeProcessRecovery
  readonly writerOwner: string | undefined
  readonly controller: AbortController
  readonly operations: Set<Promise<unknown>>
  active: boolean
  admitted: boolean
  task?: Promise<unknown>
  cleanup?: Promise<void>
}

/** Read-only inspection owns its processes separately from the live chat. */
export class CodexDiagnostics {
  private stopped = false
  private readonly lifetimes = new Set<CodexDiagnosticLifetime>()

  constructor(private readonly config: {
    native?: CodexSessionDependencies | undefined
    createRecovery?: (() => NativeProcessRecovery) | undefined
    admitRecovery?: ((recovery: NativeProcessRecovery) => void | Promise<void>) | undefined
    abandonRecovery?: ((recovery: NativeProcessRecovery) => Promise<void>) | undefined
    closeRecovery?: ((recovery: NativeProcessRecovery) => Promise<void>) | undefined
  }) {}

  stop(): void {
    this.stopped = true
    for (const owned of this.lifetimes) owned.controller.abort(new Error('Native diagnostics are shutting down.'))
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([...this.lifetimes].flatMap(owned => owned.task ? [owned.task] : []))
    const results = await Promise.allSettled([...this.lifetimes].map(owned => this.closeLifetime(owned)))
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length) throw new AggregateError(errors, 'Native diagnostic cleanup was incomplete.')
  }

  run<T>(pin: CodexDiagnosticPin, run: (io: CodexDiagnosticOperations) => Promise<T>,
    writerRecovery?: NativeProcessRecovery): Promise<T> {
    if (this.stopped) return Promise.reject(new DomainError('NATIVE_RUNTIME_CLOSING', 'Native diagnostics are shutting down.', 503))
    if (!this.config.createRecovery || !this.config.admitRecovery || !this.config.abandonRecovery || !this.config.closeRecovery) {
      return Promise.reject(new DomainError('CODEX_DIAGNOSTIC_OWNER_REQUIRED', 'Native diagnostics require their own admitted and verified process owner.', 503))
    }
    if (this.lifetimes.size >= 32) return Promise.reject(new DomainError('CODEX_DIAGNOSTIC_LIMIT', 'Too many native diagnostics are already owned.', 503))
    if ([...this.lifetimes].some((owned) => owned.writerOwner === writerRecovery?.owner && !owned.active)) {
      return Promise.reject(new DomainError('CODEX_DIAGNOSTIC_CLEANUP_PENDING', 'Retry retained diagnostic cleanup before another inspection.', 409))
    }
    const recovery = this.config.createRecovery()
    if (recovery.owner === writerRecovery?.owner) return Promise.reject(new DomainError(
      'CODEX_DIAGNOSTIC_OWNER_REQUIRED', 'Native diagnostics cannot share the live session process owner.', 503))
    const owned: CodexDiagnosticLifetime = { recovery, writerOwner: writerRecovery?.owner, controller: new AbortController(), operations: new Set(), active: true, admitted: false }
    const signal = pin.signal ? AbortSignal.any([pin.signal, owned.controller.signal]) : owned.controller.signal
    const native = this.config.native
    const environment = { ...(native?.environment?.(undefined, pin.scopedCredentialVariables) ?? inheritedAgentEnvironment()) }
    for (const name of Object.keys(environment)) {
      if (/^(?:GRAPHQL_|FOREMAN_CODE_|OPERATOR_|DATABASE_URL$|TEST_DATABASE_URL$|PGPASSWORD$)/.test(name)
        || pin.scopedCredentialVariables.includes(name)) delete environment[name]
    }
    this.lifetimes.add(owned)
    const guard = () => {
      if (this.stopped) throw new DomainError('NATIVE_RUNTIME_CLOSING', 'Native diagnostics are shutting down.', 503)
      if (!owned.active) throw new DomainError('CODEX_DIAGNOSTIC_CLOSED', 'This diagnostic capability is already closed.', 409)
      signal.throwIfAborted()
    }
    const combined = (request?: AbortSignal) => request ? AbortSignal.any([signal, request]) : signal
    const track = <R>(operation: () => Promise<R>): Promise<R> => {
      guard()
      const task = Promise.resolve().then(() => { guard(); return operation() })
      owned.operations.add(task)
      void task.then(() => owned.operations.delete(task), () => owned.operations.delete(task))
      return task
    }
    const io: CodexDiagnosticOperations = {
      environment: (_input, excluded = []) => { guard(); return Object.fromEntries(Object.entries(environment).filter(([name]) => !excluded.includes(name))) },
      qualify: (_binary, _cwd, _environment, authentication, request) => track(() =>
        (native?.qualify ?? qualifyCodex)(pin.binary, pin.cwd, { ...environment }, authentication, combined(request), recovery)),
      assertUnchanged: (qualified) => track(() => {
        if (qualified.binary !== pin.binary) throw new DomainError('CODEX_DIAGNOSTIC_PIN_MISMATCH', 'The diagnostic binary differs from its native session pin.', 409)
        return (native?.assertUnchanged ?? assertCodexUnchanged)(qualified)
      }),
      qualifyModel: (configuration, _binary, _cwd, _environment, request, _recovery, inspection) => track(() =>
        (native?.qualifyModel ?? qualifyNativeCodexModel)(configuration, pin.binary, pin.cwd,
          { ...environment }, combined(request), recovery,
          inspection ? { ...inspection, assertUnchanged: io.assertUnchanged } : undefined)),
      runCommand: (_binary, args, _cwd, request, _environment, options) => track(() => {
        const readonlyCommand = (args.length === 4 && args[0] === 'mcp' && args[1] === 'get' && args[3] === '--json')
          || (args.length === 3 && args[0] === 'mcp' && args[1] === 'list' && args[2] === '--json')
          || (args.length === 2 && args[0] === 'debug' && args[1] === 'models')
        if (!readonlyCommand) throw new DomainError('CODEX_DIAGNOSTIC_COMMAND_DENIED', 'Native diagnostics support only bounded configuration and model reads.', 403)
        return (native?.runCommand ?? runCommand)(pin.binary, args, pin.cwd, combined(request), { ...environment }, { ...options, recovery })
      }),
    }
    const schedule = native?.schedule ?? setTimeout
    const cancelTimer = native?.cancelTimer ?? clearTimeout
    let timer: NodeJS.Timeout | undefined
    let failed = false
    let failure: unknown
    const task = Promise.resolve().then(async () => {
      guard()
      await this.config.admitRecovery!(recovery)
      guard()
      owned.admitted = true
      timer = schedule(() => owned.controller.abort(new Error('Native diagnostic deadline exceeded.')), 60_000)
      timer.unref()
      return await run(io)
    }).catch((error: unknown) => { failed = true; failure = error; throw error }).finally(async () => {
      owned.active = false
      owned.controller.abort(new Error('Native diagnostic capability closed.'))
      cancelTimer(timer)
      await Promise.allSettled([...owned.operations])
      try { await this.closeLifetime(owned) } catch (error) {
        if (failed) throw new AggregateError([failure, error], 'Native diagnostics and their cleanup both failed.', { cause: error })
        throw error
      }
      // Physical cleanup can outlive successful work. A factory stop or caller
      // cancellation during that await must still prevent the native reload.
      if (!failed) {
        pin.signal?.throwIfAborted()
        if (this.stopped) throw new DomainError('NATIVE_RUNTIME_CLOSING', 'Native diagnostics are shutting down.', 503)
      }
    })
    owned.task = task
    return task
  }

  private closeLifetime(owned: CodexDiagnosticLifetime): Promise<void> {
    if (owned.cleanup) return owned.cleanup
    const attempt = Promise.resolve().then(async () => {
      if (owned.admitted || owned.recovery.launchId !== undefined) {
        if (owned.recovery.launchId !== undefined) await this.config.abandonRecovery!(owned.recovery)
        await this.config.closeRecovery!(owned.recovery)
      }
      this.lifetimes.delete(owned)
    })
    owned.cleanup = attempt
    void attempt.catch(() => { if (owned.cleanup === attempt) delete owned.cleanup })
    return attempt
  }

}
