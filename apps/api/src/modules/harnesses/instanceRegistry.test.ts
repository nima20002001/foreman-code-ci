import { describe, expect, it } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, RETIRED_OPENCODE_MESSAGE } from '@foreman-code/contracts'
import { HarnessInstanceRegistry, localDefaultInstances, localHarnessDrivers } from './instanceRegistry.js'
import { projectHarnessInstance } from './registryProjection.js'

const retiredConfiguration = {
  harness: 'opencode' as const,
  model: 'historical/provider-model',
  variant: 'high',
  nativeAgent: 'plan',
  thinking: true,
  autoApprove: false,
}

describe('harness instance retirement', () => {
  it.each([true, false])('retains a saved OpenCode configuration when enabled is %s', enabled => {
    const registry = new HarnessInstanceRegistry(localHarnessDrivers)
    const saved = {
      instanceId: 'saved-instance',
      instanceRevision: 'saved-revision',
      driverId: 'opencode',
      enabled,
      configuration: retiredConfiguration,
    }
    registry.reload([saved])
    const projection = projectHarnessInstance(registry.list()[0]!)
    expect(projection).toEqual({ ...saved, availability: 'retired', retirementMessage: RETIRED_OPENCODE_MESSAGE })
    expect(saved.configuration).toEqual(retiredConfiguration)
    expect(() => registry.select(saved.instanceId)).toThrowError(RETIRED_OPENCODE_MESSAGE)
  })

  it('keeps the saved Codex preset selectable and lists only supported local drivers', () => {
    const registry = new HarnessInstanceRegistry(localHarnessDrivers)
    registry.reload(localDefaultInstances(DEFAULT_HARNESS_DEFAULTS, 7))
    expect(localHarnessDrivers.map(driver => driver.driverId)).toEqual(['codex', 'claude'])
    expect(registry.select('local-default:codex')).toMatchObject({
      availability: 'available',
      configuration: DEFAULT_HARNESS_DEFAULTS.codex,
    })
  })
})
