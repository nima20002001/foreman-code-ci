import { isDeepStrictEqual } from 'node:util'
import type pg from 'pg'
import type { HostHarnessOverride, HostHarnessProfileEvidence } from '@foreman-code/contracts/harness-registry'
import { ClaudeQualificationPinSchema, type ClaudeQualificationPin } from '@foreman-code/contracts/claude-qualification'
import type { RegistryHarnessSelection } from '../installationRegistry.js'
import type { HarnessInstanceSettingsRepository } from './repository.js'
import type { HostHarnessProfileEvidenceRepository } from './profileRepository.js'
import { DomainError } from '../../errors.js'

export interface AcceptedProfileSelector {
  instanceId: string
  instanceRevision: string
  target: HostHarnessOverride['target']
}
export type CurrentHarnessProfileBinding = Pick<HostHarnessProfileEvidence,
  'target' | 'instanceRevision' | 'configurationFingerprint' | 'driverId' | 'driverRevision' |
  'protocolRevision' | 'suiteRevision' | 'environmentGeneration' | 'connectionGeneration'> & {
    instanceId: string
    pin?: ClaudeQualificationPin
  }
export type CurrentClaudeProfileBinding = CurrentHarnessProfileBinding & { pin: ClaudeQualificationPin }
export interface AcceptedHarnessProfile {
  override: HostHarnessOverride
  persistedProof: HostHarnessProfileEvidence
  currentBinding: CurrentHarnessProfileBinding
}
export interface AcceptedClaudeProfile {
  override: HostHarnessOverride
  persistedProof: HostHarnessProfileEvidence
  currentBinding: CurrentClaudeProfileBinding
}
/** The caller supplies its actual execution/conversation/turn owner authority, never a management grant surrogate. */
export interface AcceptedProfileAuthority<Owner> {
  authorize(owner: Owner, selector: AcceptedProfileSelector, client: pg.PoolClient): Promise<void>
  current(owner: Owner, value: HostHarnessOverride, client: pg.PoolClient,
    options: { purpose: 'execution' | 'observation' }): Promise<{
    registry: RegistryHarnessSelection
    applicationInstallationId: string
    suiteRevision: string
    pin?: ClaudeQualificationPin
  }>
  assertCurrent(binding: RegistryHarnessSelection): void
  assertReady?(profile: HostHarnessOverride): void
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
const unavailable = (): never => { throw new DomainError('HARNESS_PROFILE_UNAVAILABLE', 'The exact accepted native profile is unavailable or its proof is stale.', 409) }

/** Reads existing immutable settings and real native proof. No manager, native probe or default-profile synthesis. */
export class AcceptedHarnessProfileAdmission<Owner> {
  constructor(
    private readonly settings: HarnessInstanceSettingsRepository,
    private readonly proofs: HostHarnessProfileEvidenceRepository,
    private readonly authority: AcceptedProfileAuthority<Owner>,
  ) {}
  async admit(owner: Owner, selector: AcceptedProfileSelector): Promise<AcceptedHarnessProfile> {
    const selected = structuredClone(selector)
    try {
      return await this.readProfile(owner, selected, { purpose: 'execution' })
    } catch (error) {
      if (error instanceof DomainError && error.code === 'HARNESS_PROFILE_UNAVAILABLE') {
        // Qualification can start or complete while the authorized read awaits IO; the reread asserts the
        // selected profile's readiness and picks up a proof the completed check replaced.
        return this.readProfile(owner, selected, { purpose: 'execution' })
      }
      throw error
    }
  }
  async admitObservation(owner: Owner, selector: AcceptedProfileSelector): Promise<AcceptedHarnessProfile> {
    return this.readProfile(owner, selector, { purpose: 'observation' })
  }
  private async readProfile(owner: Owner, selector: AcceptedProfileSelector,
    options: { purpose: 'execution' | 'observation' }): Promise<AcceptedHarnessProfile> {
    // Snapshot before any await so a mutable caller cannot change the authorized selector.
    const selected = freeze(structuredClone(selector))
    return this.settings.readAuthorized(async client => {
      await this.authority.authorize(owner, selected, client)
      // Readers share placement's lock; settings appends still exclude both.
      await this.settings.lockRevision(client, selected.instanceId, { mode: 'shared' })
      const value = options.purpose === 'observation'
        ? await this.settings.savedRevision(client, selected.instanceId, selected.instanceRevision, { target: selected.target })
        : await this.settings.latest(client, selected.instanceId)
      if (!value || (options.purpose === 'execution' && !value.enabled) || value.driverId !== value.configuration.harness
        || value.instanceRevision !== selected.instanceRevision) return unavailable()
      if (!isDeepStrictEqual(value.target, selected.target)) {
        const original = await this.settings.savedRevision(client, selected.instanceId, selected.instanceRevision,
          { target: selected.target })
        if (!original || !isDeepStrictEqual(original.target, selected.target)
          || original.configurationFingerprint !== value.configurationFingerprint
          || !isDeepStrictEqual(original.target.hostRef, value.target.hostRef)
          || original.target.applicationInstallationId !== value.target.applicationInstallationId
          || original.driverId !== value.driverId) return unavailable()
      }
      if (options.purpose === 'execution') this.authority.assertReady?.(value)
      const proof = await this.proofs.latest(value.instanceId, value.revision, client)
      if (!proof || !proof.qualified || proof.authenticated !== true || proof.compatible !== true ) return unavailable()
      const current = await this.authority.current(owner, value, client, options)
      this.authority.assertCurrent(current.registry)
      const { selection, installation, instance } = current.registry
      if (current.applicationInstallationId !== value.target.applicationInstallationId
        || selection.instanceId !== value.instanceId || selection.instanceRevision !== value.instanceRevision
        || selection.driverId !== value.driverId || !isDeepStrictEqual(selection.hostRef, value.target.hostRef)
        || selection.harnessInstallationId !== value.target.harnessInstallationId
        || selection.installationFingerprint !== value.target.installationFingerprint
        || !isDeepStrictEqual(instance.configuration, value.configuration)) return unavailable()
      const binding: CurrentHarnessProfileBinding = {
        instanceId: value.instanceId, target: value.target, instanceRevision: value.instanceRevision,
        configurationFingerprint: value.configurationFingerprint, driverId: value.driverId,
        driverRevision: installation.driverRevision, protocolRevision: installation.protocolRevision,
        suiteRevision: current.suiteRevision, environmentGeneration: installation.environmentGeneration,
        connectionGeneration: installation.connectionGeneration,
        ...(value.driverId === 'claude' ? { pin: ClaudeQualificationPinSchema.parse(current.pin) } : {}),
      }
      for (const key of ['target', 'instanceRevision', 'configurationFingerprint', 'driverId', 'driverRevision',
        'protocolRevision', 'suiteRevision', 'environmentGeneration', 'connectionGeneration'] as const) {
        // A restart changes process generations; saved-session cleanup still
        // verifies the installed payload, protocol and accepted configuration.
        if (options.purpose === 'observation'
          && (key === 'environmentGeneration' || key === 'connectionGeneration')) continue
        if (!isDeepStrictEqual(proof[key], binding[key])) return unavailable()
      }
      if (value.configuration.harness === 'claude' && (!proof.claudeProof || !binding.pin
        || !isDeepStrictEqual(proof.claudeProof.pin, binding.pin) || binding.pin.profilePath !== value.configuration.configDirectory)) return unavailable()
      await this.authority.authorize(owner, selected, client)
      this.authority.assertCurrent(current.registry)
      return freeze(structuredClone({ override: value, persistedProof: proof, currentBinding: binding }))
    })
  }
  /** Invoke in the existing async native-effect guard; the synchronous factory consumes only the frozen snapshot. */
  async revalidate(owner: Owner, accepted: AcceptedHarnessProfile): Promise<void> {
    const current = await this.admit(owner, {
      instanceId: accepted.override.instanceId, instanceRevision: accepted.override.instanceRevision, target: accepted.override.target,
    })
    // Rechecks replace proof metadata even when the admitted runtime binding is unchanged.
    if (!isDeepStrictEqual(current.override, accepted.override)
      || !isDeepStrictEqual(current.currentBinding, accepted.currentBinding)) unavailable()
  }
  async revalidateObservation(owner: Owner, accepted: AcceptedHarnessProfile): Promise<void> {
    const current = await this.admitObservation(owner, {
      instanceId: accepted.override.instanceId, instanceRevision: accepted.override.instanceRevision,
      target: accepted.override.target,
    })
    if (!isDeepStrictEqual(current, accepted)) unavailable()
  }
}


/** Claude admission adds its mandatory genuine current SDK/CLI/profile pin. */
export class AcceptedClaudeProfileAdmission<Owner> extends AcceptedHarnessProfileAdmission<Owner> {
  override async admit(owner: Owner, selector: AcceptedProfileSelector): Promise<AcceptedClaudeProfile> {
    const accepted = await super.admit(owner, selector)
    if (accepted.override.driverId !== 'claude' || accepted.override.configuration.harness !== 'claude' || !accepted.currentBinding.pin) return unavailable()
    return freeze({ ...accepted, currentBinding: { ...accepted.currentBinding, pin: accepted.currentBinding.pin } })
  }
}
