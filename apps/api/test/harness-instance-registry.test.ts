import { describe, expect, it } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, type ClaudeHarnessConfiguration } from '@foreman-code/contracts'
import { HarnessInstanceRegistry, localDefaultInstances, localHarnessDrivers } from '../src/modules/harnesses/instanceRegistry.js'

describe('configured harness instances', () => {
  it('decodes only changed inputs when adding a configuration to retained profiles', () => {
    let decodes = 0
    const registry = new HarnessInstanceRegistry([{
      driverId: 'test', driverRevision: '1', decodeConfiguration(value) {
        decodes++
        return value
      },
    }])
    const profiles = Array.from({ length: 170 }, (_, index) => ({
      instanceId: `profile-${index}`, instanceRevision: '1', driverId: 'test', enabled: true,
      configuration: { model: `model-${index}` },
    }))
    registry.reload(profiles)
    const pinned = registry.select(profiles[0]!.instanceId)
    const added = { ...structuredClone(profiles[0]!), instanceId: 'configuration-check' }
    registry.reload([...structuredClone(profiles), added])
    expect(decodes).toBe(171)
    expect(registry.select(profiles[0]!.instanceId)).toBe(pinned)
    expect(registry.select(added.instanceId).configuration).toEqual(added.configuration)

    profiles[0]!.configuration.model = 'changed-model'
    expect(() => registry.reload(profiles)).toThrow('immutable')
    expect(registry.select(profiles[0]!.instanceId)).toBe(pinned)
    expect(pinned.configuration).toEqual({ model: 'model-0' })
    registry.reload([{ ...profiles[0]!, instanceRevision: '2' }, added])
    expect(registry.select(profiles[0]!.instanceId).configuration).toEqual({ model: 'changed-model' })
    expect(registry.list()).toHaveLength(2)
    expect(() => registry.select(profiles[1]!.instanceId)).toThrow('unavailable')
  })

  it('decodes once and pins independent immutable revisions without live resources', () => {
    let decodes = 0
    const registry = new HarnessInstanceRegistry([{ driverId: 'test', driverRevision: '1', decodeConfiguration(value) { decodes++; return value } }])
    const a = { instanceId: 'a', instanceRevision: '1', driverId: 'test', enabled: true, configuration: { model: 'old' } }
    const b = { ...a, instanceId: 'b' }
    registry.reload([a, b])
    const pinned = registry.select('a')
    expect(registry.select('a')).toBe(pinned)
    expect(decodes).toBe(2)
    registry.reload([{ ...a, instanceRevision: '2', configuration: { model: 'new' } }, b])
    expect(pinned.configuration).toEqual({ model: 'old' })
    expect(Object.isFrozen(pinned.configuration)).toBe(true)
    expect(registry.select('b').configuration).toEqual({ model: 'old' })
    expect(() => registry.reload([{ ...a, instanceRevision: '2' }])).toThrow('immutable')
  })
  it('keeps unknown, invalid and disabled instances visible and fails closed', () => {
    const registry = new HarnessInstanceRegistry([{ driverId: 'bad', driverRevision: '1', decodeConfiguration() { throw new Error('invalid') } }])
    registry.reload(['unknown', 'bad'].map((driverId) => ({ instanceId: driverId, instanceRevision: '1', driverId, configuration: {}, enabled: true })).concat([{ instanceId: 'disabled', instanceRevision: '1', driverId: 'bad', configuration: {}, enabled: false }]))
    expect(registry.list().map((value) => value.availability)).toEqual(['unknown-driver', 'invalid-configuration', 'disabled'])
    for (const id of ['unknown', 'bad', 'disabled', 'missing']) expect(() => registry.select(id)).toThrow('unavailable')
    for (const id of ['unknown', 'bad', 'disabled']) {
      expect(() => registry.select(id)).toThrow(expect.objectContaining({ code: 'HARNESS_INSTANCE_INVALID', status: 409 }))
    }
    expect(() => registry.select('missing')).toThrow(expect.objectContaining({ code: 'HARNESS_INSTANCE_UNAVAILABLE', status: 503 }))
  })
})

it('exposes a saved Claude preset for host configuration and keeps its revision immutable', () => {
  const configuration: ClaudeHarnessConfiguration = {
    harness: 'claude', model: 'saved-model', configDirectory: '/saved/profile',
    authMode: 'subscription', permissionMode: 'default', sandbox: 'danger-full-access',
    tools: ['Write'], permissionRules: [], instructions: '', mcpServers: {},
  }
  const registry = new HarnessInstanceRegistry(localHarnessDrivers)
  registry.reload(localDefaultInstances(DEFAULT_HARNESS_DEFAULTS, 1))
  expect(registry.list().map(value => value.driverId)).toEqual(['codex'])
  registry.reload(localDefaultInstances({ ...DEFAULT_HARNESS_DEFAULTS, claude: configuration }, 2))
  const saved = registry.select('local-default:claude')
  expect(saved).toMatchObject({ driverId: 'claude', instanceRevision: '2',
    enabled: true, configuration, availability: 'available' })
  registry.reload(localDefaultInstances({ ...DEFAULT_HARNESS_DEFAULTS,
    claude: { ...configuration, configDirectory: '/different/profile' } }, 3))
  expect(registry.select('local-default:claude')).toMatchObject({ instanceRevision: '3',
    configuration: { configDirectory: '/different/profile' } })
  expect(saved.configuration).toEqual(configuration)
})

it('reads a retired OpenCode preset unchanged and refuses to select it for execution', () => {
  const configuration = {
    harness: 'opencode', model: 'saved-provider/model', variant: 'max', nativeAgent: 'build',
    thinking: true, autoApprove: false,
    advanced: { permissionRules: [{ permission: 'bash', pattern: '*', effect: 'deny' }] },
  }
  const saved = { instanceId: 'historical-preset', instanceRevision: 'saved-revision',
    driverId: 'opencode', enabled: true, configuration }
  const before = structuredClone(saved)
  const registry = new HarnessInstanceRegistry(localHarnessDrivers)
  registry.reload([saved])
  expect(registry.list()).toEqual([expect.objectContaining({ ...before, availability: 'retired',
    retirementMessage: expect.stringMatching(/retired/i) })])
  expect(saved).toEqual(before)
  expect(() => registry.select(saved.instanceId)).toThrow(expect.objectContaining({ code: 'HARNESS_RETIRED' }))
})
