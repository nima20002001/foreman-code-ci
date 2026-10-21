import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  ProviderAccountModelsSchema, ProviderAccountSubjectSchema,
  type AccountProvider, type ProviderAccountAuthMode, type ProviderAccount, type ProviderAccountBinding,
  type ProviderAccountAuthenticationOperation, type ProviderAccountObservation,
  type ProviderAccountModels, type ProviderAccountCapability, type ProviderAccountProfileChoice,
  type ProviderAccountHumanHandoff,
} from '@foreman-code/contracts/provider-accounts'
import type { z } from 'zod'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { DomainError } from '../errors.js'
import { nativeProcessExit, spawnNativeProcess, type NativeProcessRecovery, type NativeProcessRegistry } from '../harnesses/recovery/processRegistry.js'
import { stopProcess } from '../harnesses/process.js'
import { providerAccountEnvironment } from './environment.js'

export interface ProviderAccountNativeInput {
  account: ProviderAccount
  homePath: string
  userHome: string
  apiKey?: string
  operation?: ProviderAccountAuthenticationOperation
}
export interface AccountLoginState {
  status: ProviderAccount['status']
  identity: string | null
  subject?: z.infer<typeof ProviderAccountSubjectSchema> | null
}
export interface ProviderAccountNativePort {
  status(input: ProviderAccountNativeInput): Promise<AccountLoginState>
  login(input: ProviderAccountNativeInput): Promise<void>
  cancelLogin(accountId: string): Promise<void>
  logout(input: ProviderAccountNativeInput): Promise<void>
  close(): Promise<void>
}
export interface AccountCommandInvocation {
  binary: string
  args: string[]
  environment: NodeJS.ProcessEnv
  workingDirectory: string
  timeoutMs: number
  recovery?: NativeProcessRecovery
}
export interface AccountCommandResult {
  code: number | null
  stdout: string
  timedOut?: boolean
}
export interface AccountCommandProcess {
  completion: Promise<AccountCommandResult>
  stop(): Promise<void>
}
export type AccountCommandLauncher = (input: AccountCommandInvocation) => AccountCommandProcess

export const launchAccountCommand: AccountCommandLauncher = input => {
  const child = spawnNativeProcess(input.binary, input.args, {
    cwd: input.workingDirectory, env: input.environment, purpose: 'command',
    ...(input.recovery ? { recovery: input.recovery } : {}),
  })
  child.stdin.end()
  let output = ''
  let timedOut = false
  const capture = (bytes: Buffer) => {
    if (output.length < 32_768) output += bytes.toString().slice(0, 32_768 - output.length)
  }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  let stopFailure: unknown
  const timer = setTimeout(() => {
    timedOut = true
    void stopProcess(child).catch(error => { stopFailure = error })
  }, input.timeoutMs)
  const completion = new Promise<AccountCommandResult>((resolve, reject) => {
    child.once('error', () => {
      clearTimeout(timer)
      reject(new DomainError('PROVIDER_COMMAND_UNAVAILABLE', 'The native account command could not start.', 409))
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      try {
        if (stopFailure) throw stopFailure
        const result = nativeProcessExit(child, { exitCode: code, exitSignal: signal })
        resolve({ code: result.exitCode, stdout: output, timedOut })
      } catch {
        reject(new DomainError('PROVIDER_COMMAND_OUTCOME_UNKNOWN', 'The native account outcome is unknown.', 409))
      }
    })
  })
  return { completion, async stop() {
    if (!await stopProcess(child)) {
      throw new DomainError('PROVIDER_COMMAND_CLOSURE_UNKNOWN', 'Native account cleanup remains unconfirmed.', 409)
    }
    await completion
  } }
}

export interface QualifiedAccountInstallation {
  binding: ProviderAccountBinding
  binary: string
  profilePath: string
  qualificationId: string
  generation: number
  isolation: true
  status: boolean
  login: boolean
  logout: boolean
  subjectField?: 'subject' | 'accountId' | 'userId'
}
export type AccountProcessRegistry = Pick<NativeProcessRegistry, 'reserveLaunch' | 'abandonReservedLaunch' | 'closeOwner'>

export interface AccountNativeSelection {
  discover?(target: DeviceProvisioningTarget, provider?: AccountProvider): Promise<{
    providers: ProviderAccountCapability[]; profiles: ProviderAccountProfileChoice[]; generation: number
  }>
  humanHandoff?(input: ProviderAccountNativeInput & { operation: ProviderAccountAuthenticationOperation }):
    Promise<ProviderAccountHumanHandoff>
  selected(input: ProviderAccountNativeInput): Promise<QualifiedAccountInstallation | null>
  models?(input: ProviderAccountNativeInput, selected: QualifiedAccountInstallation): Promise<ProviderAccountModels>
  resolveProfile?(account: ProviderAccount): Promise<{ binding: ProviderAccountBinding; homePath: string; userHome: string }>
  registerProfile?(input: { provider: AccountProvider; authMode?: ProviderAccountAuthMode | undefined; profileRef: string; qualificationId: string;
    target: DeviceProvisioningTarget }): Promise<{ profileRef: string }>
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some(character => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })
}

function accountReadiness(status: ProviderAccount['status']): ProviderAccountObservation['readiness'] {
  if (status === 'signed-out') return 'sign-in-required'
  if (status === 'unavailable') return 'unavailable'
  return 'unknown'
}

function safeIdentity(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 200 || hasControlCharacters(value)
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return null
  return value
}

/** Only supported native status fields escape this boundary. */
export class NativeProviderAccountCommands implements ProviderAccountNativePort {
  private sequence = 0
  private closing = false
  private readonly observations = new Set<Promise<AccountLoginState>>()
  private readonly inspections = new Set<AccountCommandProcess>()

  constructor(
    private readonly selection: AccountNativeSelection,
    private readonly launcher: AccountCommandLauncher = launchAccountCommand,
    private processes?: AccountProcessRegistry,
  ) {}

  bindProcessRegistry(processes: AccountProcessRegistry): void {
    if (this.processes && this.processes !== processes) throw new DomainError(
      'PROVIDER_ACCOUNT_OWNER_CONFLICT', 'Account commands already belong to another native registry.', 409)
    this.processes = processes
  }

  async selected(input: ProviderAccountNativeInput): Promise<QualifiedAccountInstallation> {
    if (this.closing) throw new DomainError('PROVIDER_OPERATIONS_CLOSING', 'Native account observations are shutting down.', 503)
    const selected = await this.selection.selected(input)
    if (!selected || !selected.isolation || !isAbsolute(selected.binary) || !input.account.binding
      || !isAbsolute(input.homePath) || resolve(input.homePath) !== input.homePath
      || selected.profilePath !== input.homePath
      || input.account.removedAt || !isDeepStrictEqual(input.account.binding, selected.binding)
      || selected.binding.provider !== input.account.provider || selected.binding.accountId !== input.account.id
      || input.operation && (selected.generation !== input.operation.generation
        || !isDeepStrictEqual(selected.binding, input.operation.binding))) {
      throw new DomainError('PROVIDER_ACCOUNT_UNQUALIFIED', 'The selected native account installation is unavailable.', 409)
    }
    return structuredClone(selected)
  }

  async dispatch(input: ProviderAccountNativeInput, action: 'login' | 'logout' | 'status', options: {
    recovery?: NativeProcessRecovery; expected?: QualifiedAccountInstallation; assertLaunch?: () => void; timeoutMs?: number
  } = {}): Promise<AccountCommandProcess> {
    const { recovery, expected, assertLaunch } = options
    const selected = await this.selected(input)
    if (expected && !isDeepStrictEqual(expected, selected)) throw new DomainError(
      'PROVIDER_ACCOUNT_INSTALLATION_CHANGED', 'The accepted native account installation changed.', 409)
    const supported = action === 'status' ? selected.status : selected[action]
    if (!supported) throw new DomainError('PROVIDER_ACCOUNT_UNSUPPORTED', 'The native account operation is unsupported.', 409)
    if (action !== 'status' && (!input.operation || !recovery?.launchId
      || input.operation.intent !== (action === 'login' ? 'sign-in' : 'sign-out')
      || input.operation.cancelRequested || Date.parse(input.operation.expiresAt) <= Date.now())) {
      throw new DomainError('PROVIDER_OPERATION_REQUIRED', 'Reserve the account operation before native dispatch.', 409)
    }
    if (this.closing) throw new DomainError('PROVIDER_OPERATIONS_CLOSING', 'Native account observations are shutting down.', 503)
    if (this.launcher === launchAccountCommand && !recovery?.launchId) throw new DomainError(
      'PROVIDER_OPERATION_UNSUPPORTED', 'Native account commands require retained process ownership.', 409)
    assertLaunch?.()
    let args: string[]
    if (input.account.provider === 'codex') args = action === 'status' ? ['login', 'status'] : [action]
    else args = action === 'status' ? ['auth', 'status', '--json'] : ['auth', action]
    return this.launcher({ binary: selected.binary, args,
      environment: providerAccountEnvironment(input.account.provider, input.homePath, input.userHome),
      workingDirectory: input.userHome, timeoutMs: options.timeoutMs ?? (action === 'login' ? 600_000 : 15_000),
      ...(recovery ? { recovery } : {}) })
  }

  status(input: ProviderAccountNativeInput): Promise<AccountLoginState> {
    const result = this.inspectStatus(input)
    this.observations.add(result)
    void result.then(() => this.observations.delete(result), () => this.observations.delete(result))
    return result
  }

  private async inspectStatus(input: ProviderAccountNativeInput): Promise<AccountLoginState> {
    let selected: QualifiedAccountInstallation
    let result: AccountCommandResult | undefined
    try {
      selected = await this.selected(input)
      const recovery = await this.processes?.reserveLaunch(`provider-account-status:${randomUUID()}`)
      let inspection: AccountCommandProcess | undefined
      let inspectionFailure: unknown
      try {
        inspection = await this.dispatch(input, 'status', { ...(recovery ? { recovery } : {}), expected: selected })
        this.inspections.add(inspection)
        result = await inspection.completion
      } catch (error) {
        inspectionFailure = error
      } finally {
        if (inspection) this.inspections.delete(inspection)
      }
      if (recovery && this.processes) {
        await this.processes.abandonReservedLaunch(recovery)
        if (!await this.processes.closeOwner(recovery.owner)) {
          throw new DomainError('PROVIDER_COMMAND_CLOSURE_UNKNOWN', 'Native account observation cleanup is unconfirmed.', 409)
        }
      }
      if (inspectionFailure !== undefined) throw inspectionFailure
      if (!isDeepStrictEqual(selected, await this.selected(input))) return { status: 'unavailable', identity: null }
    } catch (error) {
      if (!(error instanceof DomainError)) throw error
      return { status: 'unavailable', identity: null }
    }
    if (!result || result.timedOut || result.code === null) return { status: 'unavailable', identity: null }
    if (input.account.provider === 'codex') {
      if (result.code === 0 && /logged in using chatgpt/i.test(result.stdout)) return { status: 'signed-in', identity: null }
      if (/^\s*not logged in\s*$/i.test(result.stdout)) return { status: 'signed-out', identity: null }
      return { status: 'unavailable', identity: null }
    }
    let data: unknown
    try { data = JSON.parse(result.stdout) } catch { return { status: 'unavailable', identity: null } }
    if (!data || typeof data !== 'object' || Array.isArray(data) || result.code !== 0) {
      return { status: 'unavailable', identity: null }
    }
    const observation = data as Record<string, unknown>
    if (observation.loggedIn === false) return { status: 'signed-out', identity: null }
    if (observation.loggedIn !== true || ['api_key', 'api-key'].includes(String(observation.authMethod))) {
      return { status: 'unavailable', identity: null }
    }
    let subject: z.infer<typeof ProviderAccountSubjectSchema> | null = null
    const nativeSubject = selected.subjectField ? observation[selected.subjectField] : undefined
    if (typeof nativeSubject === 'string' && !hasControlCharacters(nativeSubject)) {
      const parsed = ProviderAccountSubjectSchema.safeParse({ subject: nativeSubject,
        provenance: 'qualified-native', qualificationId: selected.qualificationId, observedAt: new Date().toISOString() })
      if (parsed.success) subject = parsed.data
    }
    return { status: 'signed-in', identity: safeIdentity(observation.email), subject }
  }

  async discover(target: DeviceProvisioningTarget, provider?: AccountProvider) {
    if (this.selection.discover) return this.selection.discover(target, provider)
    return { generation: 1, profiles: [], providers: (provider ? [provider] : ['codex', 'claude'] as const)
      .map(value => ({ provider: value, actions: [], qualified: false,
        reason: 'The selected installation has no account isolation qualification.' })) }
  }

  async humanHandoff(input: ProviderAccountNativeInput & { operation: ProviderAccountAuthenticationOperation }) {
    await this.selected(input)
    if (!this.selection.humanHandoff) throw new DomainError('PROVIDER_HANDOFF_UNAVAILABLE',
      'This installed CLI has no qualified human handoff.', 409)
    return this.selection.humanHandoff(input)
  }

  async requireRuntimeAccount(input: ProviderAccountNativeInput): Promise<void> {
    await this.selected(input)
  }

  async authenticationGeneration(input: ProviderAccountNativeInput): Promise<number> {
    const selection = await this.selected({ account: input.account, homePath: input.homePath, userHome: input.userHome })
    return selection.generation
  }

  async observeAccount(input: ProviderAccountNativeInput, requestedSequence?: number): Promise<ProviderAccountObservation> {
    this.sequence = Math.max(this.sequence + 1, Date.now())
    const sequence = requestedSequence ?? this.sequence
    const selected = await this.selected(input)
    const state = await this.status(input)
    if (!isDeepStrictEqual(selected, await this.selected(input))) throw new DomainError(
      'PROVIDER_OBSERVATION_STALE', 'The native account installation changed during observation.', 409)
    return { bindingRevision: selected.binding.bindingRevision, generation: selected.generation,
      sequence, observedAt: new Date().toISOString(), status: state.status,
      identity: state.identity, subject: state.subject ?? null,
      readiness: accountReadiness(state.status) }
  }

  async models(input: ProviderAccountNativeInput): Promise<ProviderAccountModels> {
    const selected = await this.selected(input)
    if (!this.selection.models) throw new DomainError('PROVIDER_MODELS_UNAVAILABLE', 'Native account models are unavailable.', 409)
    const result = ProviderAccountModelsSchema.parse(await this.selection.models(input, selected))
    if (!isDeepStrictEqual(selected, await this.selected(input)) || !isDeepStrictEqual(result.binding, selected.binding)
      || result.generation !== selected.generation) {
      throw new DomainError('PROVIDER_OBSERVATION_STALE', 'The native account installation changed during discovery.', 409)
    }
    return result
  }

  registerProfile(input: { provider: AccountProvider; authMode?: ProviderAccountAuthMode | undefined; profileRef: string; qualificationId: string;
    target: DeviceProvisioningTarget }): Promise<{ profileRef: string }> {
    if (!this.selection.registerProfile) throw new DomainError('PROVIDER_PROFILE_UNQUALIFIED',
      'Select an existing qualified native profile on its owning computer.', 409)
    if (/[/\\]/.test(input.profileRef)) throw new DomainError('PROVIDER_PROFILE_UNQUALIFIED',
      'Choose a qualified profile reference rather than a filesystem path.', 409)
    return this.selection.registerProfile(input).then(result => {
      if (result.profileRef !== input.profileRef) throw new DomainError('PROVIDER_PROFILE_UNQUALIFIED',
        'The native registration returned another profile reference.', 409)
      return result
    })
  }

  async resolveProfile(account: ProviderAccount): Promise<{ homePath: string; userHome: string }> {
    if (!this.selection.resolveProfile || !account.binding) {
      throw new DomainError('PROVIDER_PROFILE_UNAVAILABLE', 'The registered native profile is unavailable.', 409)
    }
    const profile = await this.selection.resolveProfile(account)
    if (!isDeepStrictEqual(profile.binding, account.binding)) throw new DomainError(
      'PROVIDER_ACCOUNT_BINDING_CONFLICT', 'The registered profile belongs to another accepted account.', 409)
    for (const path of [profile.homePath, profile.userHome]) {
      if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path) throw new DomainError(
        'ACCOUNT_HOME_UNSAFE', 'The qualified profile has an unsafe directory alias.', 409)
      const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink() || process.getuid && info.uid !== process.getuid()) {
        throw new DomainError('ACCOUNT_HOME_UNSAFE', 'The qualified native profile is not owned by this host user.', 409)
      }
    }
    return { homePath: profile.homePath, userHome: profile.userHome }
  }

  login: ProviderAccountNativePort['login'] = async () => {
    throw new DomainError('PROVIDER_OPERATION_REQUIRED', 'Reserve and prepare the original account operation.', 409)
  }
  cancelLogin: ProviderAccountNativePort['cancelLogin'] = async () => {
    throw new DomainError('PROVIDER_OPERATION_REQUIRED', 'Cancel the persisted account operation by its original identity.', 409)
  }
  logout: ProviderAccountNativePort['logout'] = async () => {
    throw new DomainError('PROVIDER_OPERATION_REQUIRED', 'Reserve and prepare the original account operation.', 409)
  }
  async close(): Promise<void> {
    this.closing = true
    const stopped = await Promise.allSettled([...this.inspections].map(inspection => inspection.stop()))
    const observed = await Promise.allSettled([...this.observations])
    const failures = [...stopped, ...observed].flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, 'Native account observation cleanup remains unconfirmed.')
  }
}
