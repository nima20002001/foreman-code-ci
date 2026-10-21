import type pg from 'pg'
import { ev } from '../../../diagTemp.js'
import { isDeepStrictEqual } from 'node:util'
import type { HarnessConfiguration } from '@foreman-code/contracts'
import { HarnessProfileSelectionSchema, type HarnessProfileSelection } from '@foreman-code/contracts/harness-registry'
import { RETIRED_OPENCODE_MESSAGE, withAdvancedDefaults } from '@foreman-code/contracts'
import { HostHarnessOverrideListInputSchema, HostHarnessOverrideSaveSchema, type HostHarnessOverride, type HostHarnessOverrideListInput, type HostHarnessOverrideSave, type HostHarnessInstanceCheckInput } from '@foreman-code/contracts/harness-registry'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { DomainError } from '../../errors.js'
import { harnessProfileSelectionConflict, staleHarnessProfileSelectionConflict } from './selectionConflict.js'
import { requireAuthorization } from '../../access/policy.js'
import { commandInputHash, type PostgresCommandCoordinator } from '../../commands/postgres.js'
import type { HostHarnessInstanceProfileChecks } from './profileChecks.js'
import { harnessHostKey, type HarnessInstanceSettingsRepository } from './repository.js'
import { nativeProfileCheckId } from './profileChecks.js'
import type { HostHarnessOverrideAuthority } from './authority.js'
import type { GraphSqlClient } from '../../run-graph/connection.js'
import { fallbackOnError, ignoreError } from '../../diagnostics/ignoredError.js'

export type { HostHarnessOverrideAuthority }
/** Account resolution port, implemented by ProviderAccountConfigurationService. */
export interface HarnessAccountConfigurationResolver {
  resolve(configuration: HarnessConfiguration, selection?: HarnessProfileSelection,
    options?: { sql: GraphSqlClient }): Promise<HarnessConfiguration>
}
export interface HostHarnessOverrideEvidence {
  /** Resolver must match current driver/protocol/suite and authorized connection generations. */
  target: HostHarnessOverride['target']
  configurationFingerprint: string
  qualified: boolean
  failure?: HostHarnessOverride['qualificationFailure']
}

/** Shared HTTP/MCP domain authority. No watcher, native spawn or credential storage. */
export class HostHarnessOverrideService {
  constructor(private readonly repository: HarnessInstanceSettingsRepository,
    private readonly commands: PostgresCommandCoordinator,
    private readonly authority: HostHarnessOverrideAuthority,
    private readonly evidence: (value: HostHarnessOverride, client?: pg.PoolClient) => Promise<HostHarnessOverrideEvidence | null>,
    private readonly profileChecks?: HostHarnessInstanceProfileChecks,
    private readonly configurationTarget?: (configuration: HarnessConfiguration) => HostHarnessOverride['target'],
    private readonly accountConfigurations?: HarnessAccountConfigurationResolver,
    private readonly startProfileCheck?: (value: HostHarnessOverride) => Promise<void>,
  ) {}
  get qualificationSupported(): boolean { return Boolean(this.profileChecks) }
  async closeChecks(): Promise<void> { await this.profileChecks?.close() }
  async ensureReady(value: HostHarnessOverride): Promise<void> {
    ev('ensureReady begin')
    try { await this.ensureReady2(value) } catch (error) { ev(`ensureReady error ${(error as { code?: string }).code}`); throw error }
    ev('ensureReady ok')
  }
  private async ensureReady2(value: HostHarnessOverride): Promise<void> {
    if (!value.enabled || value.driverId === 'opencode') return
    this.profileChecks?.assertReady(value)
    const evidence = await this.evidence(value)
    if (evidence?.qualified) return
    if (evidence) {
      throw new DomainError(evidence.failure?.code ?? 'HARNESS_INSTANCE_UNQUALIFIED',
        evidence.failure?.message ?? 'The harness profile failed its check.', 409,
        { reason: evidence.failure?.code ?? 'profile_check_failed', hostKind: value.target.hostRef.kind })
    }
    this.startAutomaticCheck(value)
    this.profileChecks?.assertReady(value)
  }
  private startAutomaticCheck(value: HostHarnessOverride): void {
    if (!this.startProfileCheck || this.profileChecks?.pending(value)) return
    void this.startProfileCheck(value).catch(ignoreError('harness', 'automatic harness profile check', {
      instanceId: value.instanceId, revision: value.revision,
    }))
  }
  async check(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: HostHarnessInstanceCheckInput) {
    try {
      if (!this.profileChecks) throw new DomainError('HARNESS_PROFILE_CHECK_UNAVAILABLE', 'Exact-host profile qualification is not composed.', 503)
      const result = await this.profileChecks.check(principal, source, raw)
      return { value: await this.describe(result.value.override), proof: result.value.proof, replayed: result.replayed }
    } catch (error) {
      if (error instanceof DomainError && error.status === 403) await this.commands.recordDenied(principal.id, source, 'harness_instance_check', `harness-instance:${raw.instanceId}`)
      throw error
    }
  }
  private async describe(value: HostHarnessOverride, client?: pg.PoolClient): Promise<HostHarnessOverride> {
    if (value.driverId === 'opencode' || value.configuration.harness === 'opencode') return {
      ...value, qualification: 'retired', retirementMessage: RETIRED_OPENCODE_MESSAGE,
    }
    if (!value.enabled) return { ...value, qualification: 'disabled' }
    if (this.profileChecks?.pending(value)) return { ...value, qualification: 'qualifying' }
    // Missing/remote failed evidence remains unavailable, never substitutes local discovery.
    const evidence = await this.evidence(value, client).catch(fallbackOnError(null, 'harness', 'read harness qualification evidence'))
    const qualification = !evidence ? 'unqualified' : harnessHostKey(evidence.target.hostRef) !== harnessHostKey(value.target.hostRef)
      || evidence.target.applicationInstallationId !== value.target.applicationInstallationId
      || evidence.target.harnessInstallationId !== value.target.harnessInstallationId
      || evidence.target.installationFingerprint !== value.target.installationFingerprint
      ? 'installation-changed' : evidence.configurationFingerprint === value.configurationFingerprint && evidence.qualified ? 'qualified' : 'unqualified'
    const failure = evidence?.failure ?? await this.profileChecks?.failure(value, client)
    return { ...value, qualification, ...(failure ? { qualificationFailure: failure } : {}) }
  }
  async list(principal: ManagementPrincipal, raw: HostHarnessOverrideListInput, source: 'http' | 'mcp' = 'http'): Promise<{ overrides: HostHarnessOverride[] }> {
    try { return await this.read(principal, raw) } catch (error) {
      if (error instanceof DomainError && error.status === 403) await this.commands.recordDenied(principal.id, source, 'harness_instances_list', 'harness-instances')
      throw error
    }
  }
  private async read(principal: ManagementPrincipal, raw: HostHarnessOverrideListInput): Promise<{ overrides: HostHarnessOverride[] }> {
    requireAuthorization(principal, 'harnesses:read')
    const input = HostHarnessOverrideListInputSchema.parse(raw)
    return this.repository.readAuthorized(async client => {
      await this.authority.authorize(principal, 'harnesses:read', input.hostRef, input.applicationInstallationId, client)
      const overrides = await this.repository.list(input.hostRef, input.applicationInstallationId, client)
      // One transaction client runs one query at a time.
      const described: HostHarnessOverride[] = []
      for (const value of overrides) described.push(await this.describe(value, client))
      return { overrides: described }
    })
  }
  /** Called inside the existing management command transaction before publishing a selected profile. */
  async validateSelection(principal: ManagementPrincipal, raw: HarnessProfileSelection, configuration: HarnessConfiguration, client: pg.PoolClient): Promise<void> {
    requireAuthorization(principal, 'harnesses:read')
    const selection = HarnessProfileSelectionSchema.parse(raw)
    await this.authority.authorize(principal, 'harnesses:read', selection.target.hostRef, selection.target.applicationInstallationId, client)
    await this.repository.lockRevision(client, selection.instanceId)
    const value = await this.repository.latest(client, selection.instanceId)
    const canonicalConfiguration = withAdvancedDefaults(configuration)
    if (!value || !value.enabled || value.instanceRevision !== selection.instanceRevision
      || harnessHostKey(value.target.hostRef) !== harnessHostKey(selection.target.hostRef)
      || value.target.applicationInstallationId !== selection.target.applicationInstallationId) {
      throw staleHarnessProfileSelectionConflict('The harness profile selection is stale.')
    }
    if (value.driverId !== configuration.harness
      || value.configurationFingerprint !== commandInputHash(canonicalConfiguration)
      || !isDeepStrictEqual(withAdvancedDefaults(value.configuration), canonicalConfiguration)) {
      throw harnessProfileSelectionConflict('The harness configuration changed from the selected saved profile.')
    }
    if (!isDeepStrictEqual(value.target, selection.target)
      && (await this.describe(value, client)).qualification !== 'qualified') {
      throw staleHarnessProfileSelectionConflict(
        'The harness profile selection is stale: the updated installation requires qualification before use.')
    }
  }
  /** New local Claude choices may reuse an exact qualified saved profile.
   * No changed model/effort/access setting can borrow another profile's proof. */
  async selectionForConfiguration(principal: ManagementPrincipal, configuration: HarnessConfiguration, client: pg.PoolClient): Promise<HarnessProfileSelection | undefined> {
    requireAuthorization(principal, 'harnesses:read')
    const installation = (await client.query<{ id: string }>('select id::text as id from application_installation')).rows[0]
    if (!installation) return undefined
    const hostRef = { kind: 'main' as const, mainId: installation.id }
    await this.authority.authorize(principal, 'harnesses:read', hostRef, installation.id, client)
    const profiles = await this.repository.list(hostRef, installation.id, client)
    for (const profile of profiles) {
      if (!profile.enabled || !isDeepStrictEqual(withAdvancedDefaults(profile.configuration), withAdvancedDefaults(configuration))) continue
      if ((await this.describe(profile, client)).qualification !== 'qualified') continue
      const selection = { instanceId: profile.instanceId, instanceRevision: profile.instanceRevision, target: profile.target }
      await this.validateSelection(principal, selection, configuration, client)
      return selection
    }
    return undefined
  }
  /** First Operator Claude setup shares the saved-profile operation, authority,
   * idempotent receipts and native producer used by computer settings/MCP. */
  async prepareOperatorConfiguration(principal: ManagementPrincipal, source: 'http' | 'mcp', configuration: HarnessConfiguration,
    commandId: string): Promise<HarnessProfileSelection | undefined> {
    if (configuration.harness !== 'claude' || !this.configurationTarget || !this.profileChecks) return undefined
    requireAuthorization(principal, 'harnesses:read'); requireAuthorization(principal, 'harnesses:update')
    const target = this.configurationTarget(configuration)
    if (target.hostRef.kind !== 'main') throw new DomainError('HARNESS_HOST_MISMATCH', 'Automatic Operator setup uses only its actual local Claude installation.', 409)
    const instanceId = nativeProfileCheckId(target.hostRef.mainId, principal.id, `operator-claude-profile:${commandId}`)
    const saveCommandId = nativeProfileCheckId(target.hostRef.mainId, principal.id, `operator-claude-save:${commandId}`)
    const checkCommandId = nativeProfileCheckId(target.hostRef.mainId, principal.id, `operator-claude-check:${commandId}`)
    const existing = await this.repository.list(target.hostRef, target.applicationInstallationId)
    const exact = existing.find(profile => profile.enabled && isDeepStrictEqual(profile.target, target)
      && isDeepStrictEqual(withAdvancedDefaults(profile.configuration), withAdvancedDefaults(configuration)))
    const profile = exact ?? (await this.save(principal, source, { instanceId, target, configuration, presetId: 'local-default:claude',
      expectedRevision: 0, commandId: saveCommandId, enabled: true })).value
    const checked = await this.check(principal, source, { instanceId: profile.instanceId, target: profile.target,
      expectedRevision: profile.revision, commandId: checkCommandId })
    if (!checked.proof.qualified) throw new DomainError('CLAUDE_DEFAULT_SETUP_UNQUALIFIED', checked.proof.failure?.message ?? 'The exact installed Claude profile did not qualify.', 409)
    return { instanceId: checked.value.instanceId, instanceRevision: checked.value.instanceRevision, target: checked.value.target }
  }
  async save(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: HostHarnessOverrideSave) {
    try { return await this.saveAuthorized(principal, source, raw) } catch (error) {
      if (error instanceof DomainError && error.status === 403) await this.commands.recordDenied(principal.id, source, 'harness_instance_save', `harness-instance:${raw.instanceId}`)
      throw error
    }
  }
  private async saveAuthorized(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: HostHarnessOverrideSave) {
    requireAuthorization(principal, 'harnesses:update')
    const input = HostHarnessOverrideSaveSchema.parse(raw)
    // Existing validators retain sandbox/model/advanced controls; no credentials are accepted.
    const result = await this.commands.execute({ principal, source, operation: 'harness.instance.save', commandId: input.commandId,
      targetKey: `harness-instance:${input.instanceId}`, payload: input,
      authorize: client => this.authority.authorize(principal, 'harnesses:update', input.target.hostRef, input.target.applicationInstallationId, client),
      perform: async client => {
        await this.repository.lockRevision(client, input.instanceId)
        const previous = await this.repository.latest(client, input.instanceId)
        const requested = this.accountConfigurations ? await this.accountConfigurations.resolve(input.configuration,
          { instanceId: input.instanceId, instanceRevision: previous?.instanceRevision ?? '0', target: input.target },
          { sql: client }) : input.configuration
        const configuration = withAdvancedDefaults(requested)
        const configurationFingerprint = commandInputHash(configuration)
        const revision = (previous?.revision ?? 0) + 1
        const value: HostHarnessOverride = { instanceId: input.instanceId, revision, instanceRevision: String(revision),
          target: input.target, presetId: input.presetId, enabled: input.enabled, driverId: configuration.harness,
          configuration, configurationFingerprint, qualification: input.enabled ? 'unqualified' : 'disabled' }
        return this.repository.append(client, principal.id, input.expectedRevision, value)
      },
    })
    const described = await this.describe(result.value)
    if (described.enabled && !described.qualificationFailure
      && (described.qualification === 'unqualified' || described.qualification === 'installation-changed')) {
      try {
        this.startAutomaticCheck(result.value)
      } catch (error) {
        ignoreError('harness', 'start saved harness profile check', { instanceId: result.value.instanceId })(error)
      }
    }
    // Receipts remain immutable; readback rechecks current exact-target qualification.
    return { value: await this.describe(result.value), replayed: result.replayed }
  }
}

/** Admission consumes the exact readback snapshot; saved settings alone grant no execution trust. */
export function requireQualifiedHostOverride(value: HostHarnessOverride, expected: { instanceRevision: string; target: HostHarnessOverride['target'] }): HostHarnessOverride {
  if (value.driverId === 'opencode' || value.configuration.harness === 'opencode') throw new DomainError(
    'HARNESS_RETIRED', RETIRED_OPENCODE_MESSAGE, 409)
  if (!value.enabled || value.qualification !== 'qualified' || value.instanceRevision !== expected.instanceRevision
    || value.target.installationFingerprint !== expected.target.installationFingerprint
    || value.target.harnessInstallationId !== expected.target.harnessInstallationId
    || value.target.applicationInstallationId !== expected.target.applicationInstallationId
    || harnessHostKey(value.target.hostRef) !== harnessHostKey(expected.target.hostRef)) {
    throw new DomainError('HARNESS_INSTANCE_UNQUALIFIED', 'The exact host instance revision and installation require qualification.', 409)
  }
  return structuredClone(value)
}
