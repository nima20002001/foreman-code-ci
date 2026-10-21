import { HarnessConfigurationSchema, RETIRED_OPENCODE_MESSAGE, type HarnessDefaults } from '@foreman-code/contracts'
import { isDeepStrictEqual } from 'node:util'
import { DomainError } from '../errors.js'

/** Reusable code/metadata only. A registration must not contain a live manager. */
export interface HarnessDriverRegistration {
  readonly driverId: string
  readonly driverRevision: string
  readonly decodeConfiguration: (value: unknown) => unknown
}
export interface ConfiguredHarnessInstance {
  readonly instanceId: string
  readonly instanceRevision: string
  readonly driverId: string
  readonly enabled: boolean
  readonly configuration: unknown
}
export type HarnessInstanceProjection = ConfiguredHarnessInstance & {
  readonly availability: 'available' | 'disabled' | 'unknown-driver' | 'invalid-configuration' | 'retired'
  readonly driverRevision?: string
  readonly retirementMessage?: string
}

function freeze(value: unknown): unknown {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

/** Reloads affect new selections only: accepted callers retain their immutable value. */
export class HarnessInstanceRegistry {
  private instances = new Map<string, HarnessInstanceProjection>()
  private inputs = new Map<string, ConfiguredHarnessInstance>()
  private readonly drivers: ReadonlyMap<string, HarnessDriverRegistration>
  constructor(drivers: readonly HarnessDriverRegistration[]) {
    this.drivers = new Map(drivers.map((driver) => [driver.driverId, Object.freeze({ ...driver })]))
    if (this.drivers.size !== drivers.length) throw new Error('Duplicate harness driver registration.')
  }
  reload(instances: readonly ConfiguredHarnessInstance[]): void {
    const next = new Map<string, HarnessInstanceProjection>()
    const inputs = new Map<string, ConfiguredHarnessInstance>()
    for (const instance of instances) {
      if (!instance.instanceId || !instance.instanceRevision || next.has(instance.instanceId)) throw new Error('Invalid or duplicate harness instance identity.')
      const prior = this.instances.get(instance.instanceId)
      const priorInput = this.inputs.get(instance.instanceId)
      if (prior && priorInput && isDeepStrictEqual(priorInput, instance)) {
        next.set(instance.instanceId, prior)
        inputs.set(instance.instanceId, priorInput)
        continue
      }
      inputs.set(instance.instanceId, structuredClone(instance))
      const driver = this.drivers.get(instance.driverId)
      let configuration = structuredClone(instance.configuration)
      let availability: HarnessInstanceProjection['availability'] = driver ? 'available' : 'unknown-driver'
      if (driver) {
        try { configuration = structuredClone(driver.decodeConfiguration(configuration)) }
        catch { availability = 'invalid-configuration' }
      }
      if (!instance.enabled) availability = 'disabled'
      const savedConfiguration = HarnessConfigurationSchema.safeParse(configuration)
      const retired = instance.driverId === 'opencode'
        || savedConfiguration.success && savedConfiguration.data.harness === 'opencode'
      if (retired) availability = 'retired'
      const projection: HarnessInstanceProjection = { ...instance, configuration: freeze(configuration), availability, ...(retired ? { retirementMessage: RETIRED_OPENCODE_MESSAGE } : {}), ...(driver ? { driverRevision: driver.driverRevision } : {}) }
      if (prior?.instanceRevision === instance.instanceRevision && JSON.stringify(prior) !== JSON.stringify(projection)) {
        throw new Error('A configured instance revision is immutable.')
      }
      next.set(instance.instanceId, Object.freeze(projection))
    }
    this.instances = next
    this.inputs = inputs
  }
  list(): readonly HarnessInstanceProjection[] { return [...this.instances.values()] }
  select(instanceId: string): HarnessInstanceProjection {
    const instance = this.instances.get(instanceId)
    if (!instance) throw new DomainError('HARNESS_INSTANCE_UNAVAILABLE', 'Harness instance inventory is unavailable.', 503)
    if (instance.availability === 'retired') throw new DomainError('HARNESS_RETIRED', RETIRED_OPENCODE_MESSAGE, 409)
    if (instance.availability !== 'available') {
      throw new DomainError('HARNESS_INSTANCE_INVALID', `Harness instance unavailable: ${instance.availability}.`, 409)
    }
    return instance
  }
}

export const localHarnessDrivers: readonly HarnessDriverRegistration[] = ['codex', 'claude'].map((driverId) => ({
  driverId, driverRevision: '1', decodeConfiguration: (value: unknown) => {
    const configuration = HarnessConfigurationSchema.parse(value)
    if (configuration.harness !== driverId) throw new Error('Harness configuration driver mismatch.')
    return configuration
  },
}))

/** Existing managed-default CAS/auth remains in the catalog/settings services. */
export function localDefaultInstances(defaults: HarnessDefaults, revision: number): ConfiguredHarnessInstance[] {
  return (['codex', 'claude'] as const)
    .filter(driverId => defaults[driverId] !== undefined)
    .map((driverId) => ({
      instanceId: `local-default:${driverId}`, instanceRevision: String(revision), driverId,
      enabled: true, configuration: defaults[driverId],
    }))
}
