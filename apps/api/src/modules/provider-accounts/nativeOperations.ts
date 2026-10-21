import { isDeepStrictEqual } from 'node:util'
import type {
  ProviderAccountNativeAuthenticationObservation, ProviderAccountAuthenticationOperation,
} from '@foreman-code/contracts/provider-accounts'
import type { ProviderAccountOperationNativePort } from './service.js'
import { NativeAccountJournal, type NativeAccountRecord } from './nativeJournal.js'
import {
  NativeProviderAccountCommands, type AccountCommandProcess, type AccountCommandResult,
  type ProviderAccountNativeInput, type QualifiedAccountInstallation,
} from './nativeCommands.js'
import type { NativeProcessRegistry, NativeProcessRecovery } from '../harnesses/recovery/processRegistry.js'
import { DomainError } from '../errors.js'

type OperationInput = ProviderAccountNativeInput & { operation: ProviderAccountAuthenticationOperation }
type ProcessRegistry = Pick<NativeProcessRegistry, 'reserveLaunch' | 'abandonReservedLaunch' | 'closeOwner'
  | 'closedRegistration' | 'closeRegistration' | 'scope'>
interface ResidentOperation { process: AccountCommandProcess; completion: Promise<void> }

/** Owns native effects after the shared service has committed an operation. */
export class NativeProviderAccountOperations implements ProviderAccountOperationNativePort {
  private readonly residents = new Map<string, ResidentOperation>()
  private readonly pending = new Map<string, Promise<ProviderAccountNativeAuthenticationObservation>>()
  private closing = false

  constructor(private readonly commands: NativeProviderAccountCommands,
    private readonly journal: NativeAccountJournal, private readonly processes: ProcessRegistry,
    private readonly eligibility: (input: OperationInput) => Promise<void>,
    private readonly now: () => number = Date.now) {
    this.commands.bindProcessRegistry(processes)
  }

  status(input: ProviderAccountNativeInput) {
    const record = input.account.binding ? this.journal.accountOperation(input.account.binding) : undefined
    if (record && !record.observation.nativeClosed) return Promise.resolve({ status: 'login-pending' as const, identity: null })
    return this.commands.status(input)
  }
  async observeAccount(input: ProviderAccountNativeInput) {
    const binding = input.account.binding
    if (!binding) throw new DomainError('PROVIDER_ACCOUNT_BINDING_UNAVAILABLE', 'The account has no accepted native binding.', 409)
    const record = this.journal.accountOperation(binding)
    const selected = await this.commands.selected(input)
    const sequence = this.journal.nextObservationSequence(binding)
    if (record && !record.observation.nativeClosed) {
      return this.journal.saveObservation(binding, { bindingRevision: binding.bindingRevision,
        generation: selected.generation, sequence,
        observedAt: new Date(this.now()).toISOString(), status: 'login-pending', identity: null,
        subject: null, readiness: 'unknown' })
    }
    const observed = await this.commands.observeAccount(input, sequence)
    if (observed.generation !== selected.generation) throw new DomainError('PROVIDER_OBSERVATION_STALE',
      'The native account generation changed during observation.', 409)
    return this.journal.saveObservation(binding, observed)
  }
  requireRuntimeAccount(input: ProviderAccountNativeInput) { return this.commands.requireRuntimeAccount(input) }
  authenticationGeneration(input: ProviderAccountNativeInput) { return this.commands.authenticationGeneration(input) }
  models(input: ProviderAccountNativeInput) { return this.commands.models(input) }
  resolveProfile(account: ProviderAccountNativeInput['account']) { return this.commands.resolveProfile(account) }
  registerProfile(input: Parameters<NativeProviderAccountCommands['registerProfile']>[0]) {
    return this.commands.registerProfile(input)
  }
  discover(...input: Parameters<NativeProviderAccountCommands['discover']>) { return this.commands.discover(...input) }
  humanHandoff(input: OperationInput) { return this.commands.humanHandoff(input) }
  login(input: ProviderAccountNativeInput) { return this.commands.login(input) }
  logout(input: ProviderAccountNativeInput) { return this.commands.logout(input) }
  cancelLogin(accountId: string) { return this.commands.cancelLogin(accountId) }

  private async closeOriginal(record: NativeAccountRecord): Promise<boolean> {
    if (!record.launchId) return !record.dispatched
    await this.processes.closeRegistration(this.processes.scope(record.owner), record.launchId)
    return true
  }

  private update(record: NativeAccountRecord, state: NativeAccountRecord['observation']['state'], closed: boolean) {
    record.observation = { ...record.observation, state, nativeClosed: closed, sequence: record.observation.sequence + 1 }
    this.journal.write(record)
  }

  private validate(input: OperationInput, record: NativeAccountRecord): void {
    if (!isDeepStrictEqual(record.operation.binding, input.account.binding)
      || record.operation.binding.accountId !== input.account.id
      || record.operation.binding.provider !== input.account.provider
      || record.operation.intent === 'sign-in' && input.account.authMode !== 'subscription') {
      throw new DomainError('PROVIDER_OPERATION_CONFLICT', 'The native operation differs from its accepted account.', 409)
    }
  }

  prepareAuthentication(input: OperationInput): Promise<ProviderAccountNativeAuthenticationObservation> {
    input = structuredClone(input)
    const previous = this.pending.get(input.operation.id)
    if (previous) return previous.then(() => this.observeAuthentication(input))
    const pending = this.prepare(input).finally(() => { this.pending.delete(input.operation.id) })
    this.pending.set(input.operation.id, pending)
    return pending
  }

  private async prepare(input: OperationInput): Promise<ProviderAccountNativeAuthenticationObservation> {
    if (this.closing) throw new DomainError('PROVIDER_OPERATIONS_CLOSING', 'Account operations are shutting down.', 503)
    const { record, created } = this.journal.reserve(input.operation)
    this.validate(input, record)
    if (!created) return this.observeAuthentication(input)
    if (input.operation.cancelRequested || Date.parse(input.operation.expiresAt) <= this.now()) {
      this.update(record, input.operation.cancelRequested ? 'canceled' : 'expired', true)
      return structuredClone(record.observation)
    }
    let installation: QualifiedAccountInstallation
    try {
      await this.eligibility(input)
      installation = await this.commands.selected(input)
    } catch (error) {
      this.update(record, 'failed', true)
      throw error
    }
    const checked = this.journal.read(record.operation.id)!
    if (checked.operation.cancelRequested || checked.observation.nativeClosed) return structuredClone(checked.observation)
    if (this.closing) {
      this.update(checked, 'failed', true)
      return structuredClone(checked.observation)
    }
    const recovery = await this.processes.reserveLaunch(record.owner)
    if (!recovery.launchId) throw new DomainError('PROVIDER_OPERATION_UNSUPPORTED',
      'This host cannot retain native account process ownership.', 409)
    const current = this.journal.read(record.operation.id)!
    if (current.operation.cancelRequested || current.observation.nativeClosed) {
      await this.processes.abandonReservedLaunch(recovery)
      return structuredClone(this.journal.read(record.operation.id)!.observation)
    }
    current.launchId = recovery.launchId
    current.dispatched = true
    this.update(current, input.operation.intent === 'sign-in' ? 'awaiting-human' : 'observing', false)
    let process: AccountCommandProcess
    try {
      process = await this.commands.dispatch(input, input.operation.intent === 'sign-in' ? 'login' : 'logout', {
        recovery, expected: installation,
        timeoutMs: Math.max(1, Math.min(600_000, Date.parse(record.operation.expiresAt) - this.now())),
        assertLaunch: () => {
          const current = this.journal.read(record.operation.id)!
          if (current.operation.cancelRequested || current.observation.nativeClosed || this.closing
            || Date.parse(current.operation.expiresAt) <= this.now()) {
            throw new DomainError('PROVIDER_OPERATION_CANCELED', 'The original native operation is no longer dispatchable.', 409)
          }
        },
      })
    } catch {
      return this.failedDispatch(record.operation.id, recovery)
    }
    const completion = this.finish(input, installation, process.completion).finally(() => {
      this.residents.delete(record.operation.id)
    })
    this.residents.set(record.operation.id, { process, completion })
    return structuredClone(current.observation)
  }

  private async failedDispatch(id: string, recovery: NativeProcessRecovery) {
    const neverStarted = await this.processes.abandonReservedLaunch(recovery)
    const closed = await this.closeOriginal(this.journal.read(id)!)
    const current = this.journal.read(id)!
    let state: NativeAccountRecord['observation']['state'] = 'outcome-unknown'
    if (closed) {
      if (current.operation.cancelRequested) state = 'canceled'
      else if (Date.parse(current.operation.expiresAt) <= this.now()) state = 'expired'
      else if (neverStarted) state = 'failed'
    }
    this.update(current, state, closed)
    return structuredClone(current.observation)
  }

  private async finish(input: OperationInput, installation: QualifiedAccountInstallation,
    completion: Promise<AccountCommandResult>): Promise<void> {
    let closureConfirmed = false
    try {
      const outcome = await completion.then(result => ({ result }), () => ({ result: undefined }))
      const original = this.journal.read(input.operation.id)!
      closureConfirmed = await this.closeOriginal(original)
      let current = this.journal.read(input.operation.id)!
      if (!closureConfirmed) { this.update(current, 'outcome-unknown', false); return }
      if (current.operation.cancelRequested || Date.parse(current.operation.expiresAt) <= this.now()) {
        this.update(current, current.operation.cancelRequested ? 'canceled' : 'expired', true)
        return
      }
      await this.eligibility(input)
      const selected = await this.commands.selected(input)
      current = this.journal.read(input.operation.id)!
      if (current.operation.cancelRequested || Date.parse(current.operation.expiresAt) <= this.now()) {
        this.update(current, current.operation.cancelRequested ? 'canceled' : 'expired', true)
        return
      }
      if (!isDeepStrictEqual(installation, selected) || !outcome.result) {
        this.update(current, 'outcome-unknown', true)
        return
      }
      if (outcome.result.code === 0 && !outcome.result.timedOut && input.account.binding) {
        this.update(current, 'observing', false)
        const sequence = this.journal.nextObservationSequence(input.account.binding)
        const account = await this.commands.observeAccount(input, sequence)
        await this.eligibility(input)
        if (!isDeepStrictEqual(installation, await this.commands.selected(input))) {
          throw new DomainError('PROVIDER_OBSERVATION_STALE', 'The native account changed before authentication publication.', 409)
        }
        current = this.journal.read(input.operation.id)!
        if (current.operation.cancelRequested || Date.parse(current.operation.expiresAt) <= this.now()) {
          this.update(current, current.operation.cancelRequested ? 'canceled' : 'expired', true)
          return
        }
        current.observation = { ...current.observation,
          account: this.journal.saveObservation(input.account.binding, account) }
      }
      let state: NativeAccountRecord['observation']['state'] = 'failed'
      if (outcome.result.timedOut) state = 'expired'
      else if (outcome.result.code === 0) state = 'completed'
      this.update(current, state, true)
    } catch {
      const current = this.journal.read(input.operation.id)!
      this.update(current, 'outcome-unknown', closureConfirmed)
    }
  }

  async observeAuthentication(input: OperationInput): Promise<ProviderAccountNativeAuthenticationObservation> {
    const { record } = this.journal.reserve(input.operation)
    this.validate(input, record)
    if (input.operation.cancelRequested && record.observation.state === 'outcome-unknown') {
      return this.cancel(input, 'canceled')
    }
    if (record.observation.nativeClosed) return structuredClone(record.observation)
    if (input.operation.cancelRequested) return this.cancel(input, 'canceled')
    if (this.residents.has(record.operation.id)) {
      if (Date.parse(record.operation.expiresAt) <= this.now()) return this.cancel(input, 'expired')
      return structuredClone(record.observation)
    }
    const closed = record.launchId && this.processes.closedRegistration(record.owner, record.launchId)
    if (closed) this.update(record, record.operation.cancelRequested ? 'canceled' : 'outcome-unknown', true)
    else this.update(record, 'outcome-unknown', false)
    return structuredClone(record.observation)
  }

  cancelAuthentication(input: OperationInput): Promise<ProviderAccountNativeAuthenticationObservation> {
    return this.cancel(input, 'canceled')
  }

  private async cancel(input: OperationInput, state: 'canceled' | 'expired') {
    const { record } = this.journal.reserve(input.operation)
    this.validate(input, record)
    if (record.observation.nativeClosed) {
      if (record.observation.state === 'outcome-unknown') {
        record.operation.cancelRequested = true
        this.update(record, state, true)
      }
      return structuredClone(record.observation)
    }
    record.operation.cancelRequested = true
    this.update(record, 'observing', false)
    try {
      const resident = this.residents.get(record.operation.id)
      if (resident) { await resident.process.stop(); await resident.completion }
      const closed = await this.closeOriginal(record)
      const current = this.journal.read(record.operation.id)!
      this.update(current, closed ? state : 'outcome-unknown', closed)
      return structuredClone(current.observation)
    } catch {
      const current = this.journal.read(record.operation.id)!
      this.update(current, 'outcome-unknown', false)
      return structuredClone(current.observation)
    }
  }

  async close(): Promise<void> {
    this.closing = true
    const prepared = await Promise.allSettled([...this.pending.values()])
    const failures = prepared.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    for (const id of this.residents.keys()) {
      const record = this.journal.read(id)!
      try {
        await this.residents.get(id)!.process.stop()
        await this.residents.get(id)?.completion
        if (!await this.closeOriginal(record)) throw new Error('Native account cleanup is unconfirmed.')
      } catch (error) { failures.push(error) }
    }
    try { await this.commands.close() } catch (error) { failures.push(error) }
    if (failures.length) throw new AggregateError(failures, 'Native account cleanup remains unconfirmed.')
  }
}
